import { CREDENTIAL_TOKEN_TTL_SECONDS, generateCredentialToken, type CredentialToken, type CredentialTokenPurpose } from "@slugbase/core";
import { credentialTokenRepository, type AuthStore } from "@slugbase/db";
import { FakeIdentity, InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { verifyHash } from "../../src/auth/password.ts";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { urlOf } from "../migrate/support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { issuedToken, postJson, seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// POST /api/v1/auth/verify-email (doc 04 sections 4.5 and 10.2, doc 02 sections 2.2 and 2.6, doc 10 T4, T8
// and T9) over the whole chain and a migrated database. The failure scenarios: a verification token that
// works twice, after 24 hours, or for another account; a replay or a double submit that creates a second
// workspace; and the pre-registration takeover, an account registered with password A and verified by its
// owner with password B that still accepts A or keeps a session that existed before the verification.

const REGISTER = "/api/v1/auth/register";
const VERIFY = "/api/v1/auth/verify-email";
const LOGIN = "/api/v1/auth/login";
const ME = "/api/v1/me";
const WEAK = "short";
const PASSWORD_A = "the password the visitor registered with";
const PASSWORD_B = "the password the owner chose on verifying";
const HOOK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 40_000;
const PARALLEL = 4;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
}, 30_000);

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`DELETE FROM pgboss.job WHERE name IN ('mail.send', 'event.account.created', 'event.workspace.created')`;
});

const ISSUER = "https://idp.example.test";
const OIDC_START = "/api/v1/auth/oidc/idp/start";
const PREAUTH_COOKIE = "__Host-slugbase_oidc";

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly fake: FakeIdentity;
}

/** The server as the CE composes it with registration open and verification required; the limits are open unless a test is about them. */
function serve({ openLimits = true, verificationRequired = true }: { readonly openLimits?: boolean; readonly verificationRequired?: boolean } = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    PUBLIC_REGISTRATION: "true",
    EMAIL_VERIFICATION_REQUIRED: String(verificationRequired),
    RATE_LIMIT_REGISTER_IP: "1000/hour",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    ...(openLimits ? { RATE_LIMIT_TOKEN_REDEEM_IP: "1000/hour" } : {}),
  });
  const fake = new FakeIdentity({ providers: [{ id: "idp", displayName: "Example IdP", issuer: ISSUER, clientId: "client-id-1" }] });
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
      tenantResolver: createAccountOnlyTenantResolver(),
      mail: new InMemoryMail(),
      secretBox: testSecretBox(testKey("oidc-1")),
      identity: { available: true, listProviders: () => fake.listProviders(), begin: (request) => fake.begin(request), complete: (request) => fake.complete(request) },
    },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, fake };
}

let counter = 0;

/** Registers an account through the route, as a visitor does, and returns its identifier. */
async function register(world: World, password = PASSWORD_A, displayName = "Ada Lovelace"): Promise<{ id: string; email: string }> {
  counter += 1;
  const email = `owner.${String(counter)}@example.test`;
  const response = await world.server.fetch(postJson(world.origin, REGISTER, { displayName, email, password }));
  expect(response.status).toBe(202);
  return { id: await accountIdOf(email), email };
}

const SUBJECT = "subject-of-the-pre-registrant";

interface Footholds {
  readonly apiToken: string;
}

/** What someone who registered the address first can have set up while the account was unverified: a second factor with a recovery code, an API token, a linked identity. */
async function plantFootholds(accountId: string, email: string): Promise<Footholds> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET mfa_secret = ${Buffer.alloc(40, 3)}, mfa_secret_key_id = 'oidc-1', mfa_enabled_at = now() WHERE id = ${accountId}`;
    await tx`INSERT INTO mfa_backup_codes (id, account_id, code_hash) VALUES (${uuidv7()}, ${accountId}, ${Buffer.alloc(8, 1)})`;
  });
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${uuidv7()}, ${accountId}, 'idp', ${SUBJECT}, ${email})`;
  });
  const workspaceId = await seedWorkspace(database());
  await seedMembership(database(), { workspaceId, accountId, role: "member" });
  const token = await seedApiToken(database(), { accountId, workspaceId });
  return { apiToken: token.value };
}

interface FootholdCounts {
  readonly mfa: boolean;
  readonly backupCodes: number;
  readonly apiTokens: number;
  readonly identities: number;
  readonly pendingLinks: number;
}

async function footholdCounts(accountId: string): Promise<FootholdCounts> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ mfa: boolean; codes: number; tokens: number; identities: number; links: number }[]>`
      SELECT (a.mfa_secret IS NOT NULL OR a.mfa_secret_key_id IS NOT NULL OR a.mfa_enabled_at IS NOT NULL OR a.mfa_last_step IS NOT NULL) AS mfa,
             (SELECT count(*)::int FROM mfa_backup_codes WHERE account_id = a.id) AS codes,
             (SELECT count(*)::int FROM api_tokens WHERE account_id = a.id) AS tokens,
             (SELECT count(*)::int FROM account_identities WHERE account_id = a.id) AS identities,
             (SELECT count(*)::int FROM oidc_login_states WHERE link_account_id = a.id) AS links
      FROM accounts a WHERE a.id = ${accountId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return { mfa: row.mfa, backupCodes: row.codes, apiTokens: row.tokens, identities: row.identities, pendingLinks: row.links };
}

function withBearer(world: World, token: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(ME, world.origin), { headers: { authorization: `Bearer ${token}` } }));
}

/** Signs in through the provider as the identity of `SUBJECT`, which asserts `email` as verified or not; the answer is the callback's. */
async function oidcSignIn(world: World, email: string, emailVerified = true): Promise<Response> {
  const started = await world.server.fetch(new Request(new URL(OIDC_START, world.origin)));
  const authorizationUrl = started.headers.get("location") ?? "";
  const preAuth = started.headers.getSetCookie().map((header) => new RegExp(`^${PREAUTH_COOKIE}=([^;]+);`).exec(header)?.[1]).find((value) => value !== undefined);
  if (started.status !== 302 || preAuth === undefined) {
    throw new Error(`the handshake did not start: ${String(started.status)}`);
  }
  const callbackUrl = world.fake.approve(authorizationUrl, { subject: SUBJECT, email, emailVerified });
  return world.server.fetch(new Request(callbackUrl, { headers: { cookie: `${PREAUTH_COOKIE}=${preAuth}` } }));
}

async function accountIdOf(email: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM accounts WHERE email = ${email}`;
  });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("the account was not created");
  }
  return id;
}

/** A token as the worker issues one to the account, in the account's own transaction. */
async function issueToken(accountId: string, purpose: CredentialTokenPurpose = "email_verify"): Promise<CredentialToken> {
  const token = generateCredentialToken();
  const issued = await tenantDatabase(database()).withTenant({ accountId, requestId: "verify-email-test" }, (tx) =>
    credentialTokenRepository(tx).issue({ id: uuidv7(), purpose, tokenHash: token.hash, targetEmail: null, ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS[purpose] }),
  );
  expect(issued).toBe(true);
  return token;
}

function verify(world: World, body: unknown, cookie?: string): Promise<Response> {
  return world.server.fetch(postJson(world.origin, VERIFY, body, cookie === undefined ? {} : { cookie }));
}

/** A GET of a route that needs a session, with the session cookie of `token`. */
function probe(world: World, token: string | null): Promise<Response> {
  return world.server.fetch(new Request(new URL(ME, world.origin), { headers: token === null ? {} : { cookie: `__Host-slugbase_session=${token}` } }));
}

function login(world: World, email: string, password: string): Promise<Response> {
  return world.server.fetch(postJson(world.origin, LOGIN, { email, password, remember: false }));
}

async function signInAs(world: World, email: string, password: string): Promise<string> {
  const response = await login(world, email, password);
  const token = issuedToken(response);
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  return token;
}

interface AccountRow {
  password_hash: string | null;
  verified: boolean;
}

async function accountRow(accountId: string): Promise<AccountRow> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`SELECT password_hash, email_verified_at IS NOT NULL AS verified FROM accounts WHERE id = ${accountId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return row;
}

async function passwordIs(row: AccountRow, password: string): Promise<boolean> {
  return row.password_hash !== null && (await verifyHash(row.password_hash, password));
}

async function workspaceNames(accountId: string): Promise<{ name: string; role: string }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ name: string; role: string }[]>`
      SELECT w.name, m.role::text AS role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.account_id = ${accountId}`;
  });
  return [...rows];
}

async function workspaceEvents(): Promise<Record<string, unknown>[]> {
  const rows = await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'event.workspace.created' ORDER BY created_on, id`;
  return rows.map((row) => row.data);
}

/** The workspace.created audit events, read as the table owner acting as slugbase_system. */
async function workspaceAudit(): Promise<{ actor_account_id: string | null; actor_label: string; action: string; metadata: unknown }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ actor_account_id: string | null; actor_label: string; action: string; metadata: unknown }[]>`
      SELECT actor_account_id, actor_label, action, metadata FROM audit_events ORDER BY created_at, id`;
  });
  return [...rows];
}

async function ageToken(accountId: string, seconds: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE credential_tokens SET expires_at = expires_at - make_interval(secs => ${seconds}) WHERE account_id = ${accountId}`;
  });
}

async function usedTokens(accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ used: number }[]>`SELECT count(used_at)::int AS used FROM credential_tokens WHERE account_id = ${accountId}`;
  });
  return rows[0]?.used ?? 0;
}

describe("POST /api/v1/auth/verify-email", { timeout: TEST_TIMEOUT_MS }, () => {
  it("verifies the address, creates the personal workspace, signs the account in and announces the workspace", async () => {
    const world = serve();
    const account = await register(world);
    const token = await issueToken(account.id);

    const response = await verify(world, { token: token.value, password: PASSWORD_B });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "done" });
    const cookie = issuedToken(response);
    expect(cookie).toBeDefined();
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect((await accountRow(account.id)).verified).toBe(true);
    expect(await workspaceNames(account.id)).toEqual([{ name: "Ada Lovelace's workspace", role: "owner" }]);
    expect(await workspaceEvents()).toMatchObject([{ accountId: account.id }]);
    expect(await workspaceAudit()).toEqual([
      { actor_account_id: account.id, actor_label: "Ada Lovelace", action: "workspace.created", metadata: { name: "Ada Lovelace's workspace" } },
    ]);
    expect((await probe(world, cookie ?? null)).status).toBe(200);
  });

  it("refuses the same token the second time with 410 token_expired and creates no second workspace, session or event", async () => {
    const world = serve();
    const account = await register(world);
    const token = await issueToken(account.id);
    expect((await verify(world, { token: token.value, password: PASSWORD_B })).status).toBe(200);
    const sessionsBefore = await sessionRows(database(), account.id);

    const replay = await verify(world, { token: token.value, password: "a different password for the replay" });

    expect(replay.status).toBe(410);
    expect(replay.headers.get("content-type")).toContain("application/problem+json");
    expect(await replay.json()).toMatchObject({ code: "token_expired", status: 410 });
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(await workspaceNames(account.id)).toHaveLength(1);
    expect(await workspaceEvents()).toHaveLength(1);
    expect(await workspaceAudit()).toHaveLength(1);
    expect(await sessionRows(database(), account.id)).toEqual(sessionsBefore);
    expect(await passwordIs(await accountRow(account.id), PASSWORD_B)).toBe(true);
  });

  it("answers an unknown token, a malformed one, a token past its 24 hours, a used one and one of another kind with one identical 410", async () => {
    const world = serve();
    const account = await register(world);
    const used = await issueToken(account.id);
    await verify(world, { token: used.value, password: PASSWORD_B });
    const other = await register(world);
    const stale = await issueToken(other.id);
    await ageToken(other.id, 24 * 3600 + 1);
    const third = await register(world);
    const reset = await issueToken(third.id, "password_reset");
    const fourth = await register(world);
    await issueToken(fourth.id);

    const answers: { status: number; body: string }[] = [];
    for (const token of [generateCredentialToken().value, "not-a-token", "A".repeat(43), used.value, stale.value, reset.value]) {
      const response = await verify(world, { token, password: PASSWORD_B });
      const text = await response.text();
      answers.push({ status: response.status, body: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([name]) => name !== "requestId"))) });
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    expect(answers[0]?.status).toBe(410);
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
    expect(JSON.parse(answers[0]?.body ?? "{}")).toMatchObject({ code: "token_expired" });
    for (const stranger of [other, third, fourth]) {
      expect((await accountRow(stranger.id)).verified).toBe(false);
      expect(await workspaceNames(stranger.id)).toEqual([]);
    }
  });

  it("does not let the token of one account verify another", async () => {
    const world = serve();
    const first = await register(world);
    const second = await register(world);
    const token = await issueToken(first.id);
    await issueToken(second.id);

    expect((await verify(world, { token: token.value, password: PASSWORD_B })).status).toBe(200);

    expect((await accountRow(first.id)).verified).toBe(true);
    expect((await accountRow(second.id)).verified).toBe(false);
    expect(await workspaceNames(second.id)).toEqual([]);
    expect(await sessionRows(database(), second.id)).toEqual([]);
    expect(await usedTokens(second.id)).toBe(0);
  });

  it("creates one workspace when the same link is submitted several times at once", async () => {
    const world = serve();
    const account = await register(world);
    const token = await issueToken(account.id);

    const responses = await Promise.all(Array.from({ length: PARALLEL }, () => verify(world, { token: token.value, password: PASSWORD_B })));

    expect(responses.map((response) => response.status).sort()).toEqual([200, ...Array.from({ length: PARALLEL - 1 }, () => 410)]);
    expect(await workspaceNames(account.id)).toHaveLength(1);
    expect(await workspaceEvents()).toHaveLength(1);
  });

  it("closes the pre-registration takeover: the password of the owner works, the visitor's does not, and the visitor's session is gone", async () => {
    // The visitor can only hold a session of the unverified account where verification is optional.
    const world = serve({ verificationRequired: false });
    const account = await register(world, PASSWORD_A);
    const visitorSession = await signInAs(world, account.email, PASSWORD_A);
    expect((await probe(world, visitorSession)).status).toBe(200);
    const token = await issueToken(account.id);

    const response = await verify(world, { token: token.value, password: PASSWORD_B });
    expect(response.status).toBe(200);
    const ownerSession = issuedToken(response);

    expect((await login(world, account.email, PASSWORD_A)).status).toBe(401);
    expect((await login(world, account.email, PASSWORD_B)).status).toBe(200);
    expect((await probe(world, visitorSession)).status).toBe(401);
    expect((await probe(world, ownerSession ?? null)).status).toBe(200);
  });

  it("applies the password policy before it touches the token: a weak password answers 422 weak_password and the link still works", async () => {
    const world = serve();
    const account = await register(world);
    const token = await issueToken(account.id);

    for (const password of [WEAK, "password1234", "x".repeat(257)]) {
      const response = await verify(world, { token: token.value, password });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "weak_password" });
    }

    expect(await usedTokens(account.id)).toBe(0);
    expect((await accountRow(account.id)).verified).toBe(false);
    expect(await passwordIs(await accountRow(account.id), PASSWORD_A)).toBe(true);
    expect((await verify(world, { token: token.value, password: PASSWORD_B })).status).toBe(200);
  });

  it("answers 422 validation_failed for a body without a password or with a field it does not know", async () => {
    const world = serve();
    const token = generateCredentialToken().value;

    for (const body of [{ token }, { password: PASSWORD_B }, { token, password: PASSWORD_B, extra: true }, { token: "", password: PASSWORD_B }]) {
      const response = await verify(world, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "validation_failed" });
    }
  });

  it("keeps the password and the sessions of an account that is already verified, and gives it no second workspace", async () => {
    const world = serve();
    const account = await register(world);
    const first = await issueToken(account.id);
    await verify(world, { token: first.value, password: PASSWORD_B });
    const session = await signInAs(world, account.email, PASSWORD_B);
    const second = await issueToken(account.id);

    const response = await verify(world, { token: second.value, password: "a password that must not replace the stored one" });

    expect(response.status).toBe(200);
    expect(await passwordIs(await accountRow(account.id), PASSWORD_B)).toBe(true);
    expect((await login(world, account.email, PASSWORD_B)).status).toBe(200);
    expect((await probe(world, session)).status).toBe(200);
    expect(await workspaceNames(account.id)).toHaveLength(1);
  });

  it("leaves the one workspace a deployment without required verification made at registration, and announces it once", async () => {
    const world = serve({ verificationRequired: false });
    const account = await register(world);
    expect(await workspaceNames(account.id)).toEqual([{ name: "Ada Lovelace's workspace", role: "owner" }]);
    const token = await issueToken(account.id);

    const response = await verify(world, { token: token.value, password: PASSWORD_B });

    expect(response.status).toBe(200);
    expect(await workspaceNames(account.id)).toEqual([{ name: "Ada Lovelace's workspace", role: "owner" }]);
    expect(await workspaceEvents()).toHaveLength(1);
    expect((await accountRow(account.id)).verified).toBe(true);
  });

  it("removes the second factor with its recovery codes, the API tokens and the linked identities of an account nobody had verified, and none of them authenticates afterwards", async () => {
    const world = serve();
    const account = await register(world);
    const { apiToken } = await plantFootholds(account.id, account.email);
    expect((await withBearer(world, apiToken)).status).toBe(200);
    const before = await oidcSignIn(world, account.email);
    expect(before.headers.get("location")).toBe("/");
    expect(issuedToken(before)).toBeDefined();
    expect(await footholdCounts(account.id)).toMatchObject({ mfa: true, backupCodes: 1, apiTokens: 1, identities: 1 });
    const token = await issueToken(account.id);

    const response = await verify(world, { token: token.value, password: PASSWORD_B });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "done" });
    expect(await footholdCounts(account.id)).toEqual({ mfa: false, backupCodes: 0, apiTokens: 0, identities: 0, pendingLinks: 0 });
    expect((await withBearer(world, apiToken)).status).toBe(401);
    // The link is gone: an identity that links an account is one the provider vouches for with a verified address, which
    // this assertion does not make (a verified one is a first login by verified email, tested in oidc-first-login).
    const after = await oidcSignIn(world, account.email, false);
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/login?error=oidc_failed");
    expect(issuedToken(after)).toBeUndefined();
    expect((await sessionRows(database(), account.id)).map((row) => row.level)).toEqual(["full"]);
  });

  it("leaves the second factor, the API tokens and the identities of an account that was already verified alone", async () => {
    const world = serve();
    const account = await register(world);
    const first = await issueToken(account.id);
    expect((await verify(world, { token: first.value, password: PASSWORD_B })).status).toBe(200);
    const { apiToken } = await plantFootholds(account.id, account.email);
    const second = await issueToken(account.id);

    const response = await verify(world, { token: second.value, password: "a password that must not replace the stored one" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "mfa" });
    expect(await footholdCounts(account.id)).toMatchObject({ mfa: true, backupCodes: 1, apiTokens: 1, identities: 1 });
    expect((await withBearer(world, apiToken)).status).toBe(200);
  });

  it("signs a verified account with a second factor in with a partial session, which reaches nothing but the second factor", async () => {
    const world = serve();
    const account: SeededAccount = await seedAccount(database(), { password: PASSWORD_A, emailVerified: true });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1', mfa_enabled_at = now() WHERE id = ${account.id}`;
    });
    const token = await issueToken(account.id);

    const response = await verify(world, { token: token.value, password: PASSWORD_B });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "mfa" });
    expect((await sessionRows(database(), account.id)).map((row) => row.level)).toEqual(["partial"]);
    const partial = probe(world, issuedToken(response) ?? null);
    const denied = await partial;
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "mfa_required" });
  });

  it("undoes the verification when the workspace cannot be created, so the same link works on a retry", async () => {
    const world = serve();
    const account = await register(world);
    const token = await issueToken(account.id);
    // The queue the event is announced on is missing, so the transaction that verifies the address cannot commit.
    await database().owner`ALTER TABLE pgboss.queue RENAME TO queue_away`;
    try {
      const failed = await verify(world, { token: token.value, password: PASSWORD_B });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(failed.headers.get("set-cookie")).toBeNull();
    } finally {
      await database().owner`ALTER TABLE pgboss.queue_away RENAME TO queue`;
    }

    expect((await accountRow(account.id)).verified).toBe(false);
    expect(await passwordIs(await accountRow(account.id), PASSWORD_A)).toBe(true);
    expect(await workspaceNames(account.id)).toEqual([]);
    expect(await usedTokens(account.id)).toBe(0);
    expect((await verify(world, { token: token.value, password: PASSWORD_B })).status).toBe(200);
  });

  it("refuses a request that does not come from the application itself", async () => {
    const world = serve();
    const request = postJson(world.origin, VERIFY, { token: generateCredentialToken().value, password: PASSWORD_B });
    request.headers.set("origin", "https://evil.example");

    const response = await world.server.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cross_site_request" });
  });
});

describe("the token_redeem limit (T9)", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("allows 10 redemptions per hour from one address and answers the eleventh 429 with Retry-After", async () => {
    const world = serve({ openLimits: false });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await verify(world, { token: generateCredentialToken().value, password: PASSWORD_B })).status).toBe(410);
    }
    const denied = await verify(world, { token: generateCredentialToken().value, password: PASSWORD_B });

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await denied.json()).toMatchObject({ code: "rate_limited" });
  });
});
