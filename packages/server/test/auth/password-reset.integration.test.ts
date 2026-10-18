import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CREDENTIAL_TOKEN_TTL_SECONDS, generateCredentialToken, type CredentialToken, type CredentialTokenPurpose, type MailPort } from "@slugbase/core";
import { credentialTokenRepository, type AuthStore } from "@slugbase/db";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { verifyHash } from "../../src/auth/password.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { createRateLimitRegistry, loadConfig } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { urlOf } from "../migrate/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { issuedToken, medianLatencyRatio, postJson, seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// POST /api/v1/auth/password/forgot and /reset (doc 04 sections 4.5, 7 and 10.2, doc 02 section 2.5, doc 10 T4,
// T8, T9 and T17) over the whole chain and a migrated database. The failure scenarios: a reset token that works
// twice, after its hour, after a newer one was issued or for another purpose; a session of the old password that
// survives a reset; a reset that signs an account with a second factor in with a full session; a reset token
// requested before the owner verified the address that still works afterwards; a request for a link that tells
// an address with an account from one without.

const FORGOT = "/api/v1/auth/password/forgot";
const RESET = "/api/v1/auth/password/reset";
const VERIFY = "/api/v1/auth/verify-email";
const LOGIN = "/api/v1/auth/login";
const ME = "/api/v1/me";
const OLD_PASSWORD = "the password the account had before";
const NEW_PASSWORD = "the password chosen on the reset page";
const HOUR_SECONDS = 3600;
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
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

interface World {
  readonly server: Server;
  readonly origin: string;
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly mail?: MailPort;
}

/** The server as the CE composes it; the limits are open unless a test is about them. */
function serve({ env = {}, mail = new InMemoryMail() }: ServeOptions = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    PUBLIC_REGISTRATION: "true",
    EMAIL_VERIFICATION_REQUIRED: "true",
    RATE_LIMIT_RESET_IP: "1000/hour",
    RATE_LIMIT_RESET_EMAIL: "1000/hour",
    RATE_LIMIT_TOKEN_REDEEM_IP: "1000/hour",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    ...env,
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), rateLimit: memoryRateLimiter(createRateLimitRegistry(config)), tenantResolver: createAccountOnlyTenantResolver(), mail },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
}

function forgot(world: World, email: string, extra: { forwardedFor?: string } = {}): Promise<Response> {
  return world.server.fetch(postJson(world.origin, FORGOT, { email }, extra));
}

function reset(world: World, body: unknown, cookie?: string): Promise<Response> {
  return world.server.fetch(postJson(world.origin, RESET, body, cookie === undefined ? {} : { cookie }));
}

function login(world: World, email: string, password: string): Promise<Response> {
  return world.server.fetch(postJson(world.origin, LOGIN, { email, password, remember: false }));
}

/** A GET of a route that needs a session, with the session cookie of `token`. */
function probe(world: World, token: string | null): Promise<Response> {
  return world.server.fetch(new Request(new URL(ME, world.origin), { headers: token === null ? {} : { cookie: `__Host-slugbase_session=${token}` } }));
}

async function signInAs(world: World, account: SeededAccount): Promise<string> {
  const response = await login(world, account.email, account.password);
  const token = issuedToken(response);
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  return token;
}

/** A verified account with a password, which is the one account a reset is for. */
function ownerAccount(options: { email?: string } = {}): Promise<SeededAccount> {
  return seedAccount(database(), { emailVerified: true, password: OLD_PASSWORD, ...options });
}

/** A token as the worker issues one to the account, in the account's own transaction. */
async function issueToken(accountId: string, purpose: CredentialTokenPurpose = "password_reset"): Promise<CredentialToken> {
  const token = generateCredentialToken();
  const issued = await tenantDatabase(database()).withTenant({ accountId, requestId: "password-reset-test" }, (tx) =>
    credentialTokenRepository(tx).issue({ id: uuidv7(), purpose, tokenHash: token.hash, targetEmail: null, ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS[purpose] }),
  );
  expect(issued).toBe(true);
  return token;
}

async function ageToken(accountId: string, seconds: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE credential_tokens SET expires_at = expires_at - make_interval(secs => ${seconds}) WHERE account_id = ${accountId}`;
  });
}

async function setSecondFactor(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1', mfa_enabled_at = now() WHERE id = ${accountId}`;
  });
}

interface AccountRow {
  password_hash: string | null;
}

async function storedPassword(accountId: string): Promise<AccountRow> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`SELECT password_hash FROM accounts WHERE id = ${accountId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return row;
}

async function passwordIs(accountId: string, password: string): Promise<boolean> {
  const { password_hash: hash } = await storedPassword(accountId);
  return hash !== null && (await verifyHash(hash, password));
}

interface TokenRow {
  readonly account_id: string;
  readonly purpose: string;
  readonly token_hash: Buffer;
  readonly used_at: Date | null;
  readonly lifetime_seconds: number;
}

async function credentialTokens(): Promise<TokenRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<TokenRow[]>`
      SELECT account_id, purpose, token_hash, used_at, extract(epoch FROM expires_at - created_at)::float8 AS lifetime_seconds
      FROM credential_tokens ORDER BY created_at, id`;
  });
  return [...rows];
}

async function mailJobs(): Promise<{ data: Record<string, unknown> }[]> {
  return [...(await database().app<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'mail.send' ORDER BY created_on, id`)];
}

async function answerOf(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    // `x-request-id` differs by request, and `ratelimit` reports the remaining tokens of the address's own bucket, which a repeat of one address lowers.
    headers: [...response.headers].filter(([name]) => name !== "x-request-id" && name !== "ratelimit").sort(([a], [b]) => a.localeCompare(b)),
    body: text === "" ? text : JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([name]) => name !== "requestId"))),
  };
}

describe("POST /api/v1/auth/password/forgot", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers one 202 with no body for an account with a password, one without, an unverified one and an unknown address, whatever the spelling", async () => {
    const world = serve({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const withPassword = await ownerAccount({ email: "With.Password@Example.test" });
    const withoutPassword = await seedAccount(database(), { emailVerified: true, password: null, email: "No.Password@Example.test" });
    const unverified = await seedAccount(database(), { email: "Unverified.Person@Example.test" });

    const answers = [];
    let hop = 0;
    for (const email of [withPassword.email, withPassword.email.toUpperCase(), withoutPassword.email, unverified.email, "nobody@example.test"]) {
      hop += 1;
      answers.push(await answerOf(await forgot(world, email, { forwardedFor: `198.51.100.${String(hop)}` })));
    }

    expect(answers[0]?.status).toBe(202);
    expect(answers[0]?.body).toBe("");
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it("queues one reset mail job on every path, naming only the account that holds the address", async () => {
    const world = serve();
    const withPassword = await ownerAccount();
    const unverified = await seedAccount(database());

    for (const email of [withPassword.email, unverified.email, "nobody@example.test"]) {
      const before = (await mailJobs()).length;
      expect((await forgot(world, email)).status).toBe(202);
      expect(await mailJobs()).toHaveLength(before + 1);
    }

    const queued = (await mailJobs()).map((job) => job.data);
    expect(queued.map((data) => data["template"])).toEqual(["passwordReset", "passwordReset", "passwordReset"]);
    expect(queued.map((data) => data["accountId"])).toEqual([withPassword.id, unverified.id, expect.not.stringMatching(new RegExp(`${withPassword.id}|${unverified.id}`))]);
  });

  it("changes nothing of the account itself and issues no token: the job does", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const session = await signInAs(world, owner);
    const sessionsBefore = await sessionRows(database(), owner.id);

    expect((await forgot(world, owner.email)).status).toBe(202);

    expect(await credentialTokens()).toEqual([]);
    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
    expect(await sessionRows(database(), owner.id)).toEqual(sessionsBefore);
    expect((await probe(world, session)).status).toBe(200);
  });

  it("queues nothing when the mail port cannot send, and still answers the same 202", async () => {
    const world = serve({ mail: { available: false, send: () => Promise.reject(new Error("no mail")) } });
    const owner = await ownerAccount();

    const response = await forgot(world, owner.email);

    expect(response.status).toBe(202);
    expect(await mailJobs()).toEqual([]);
  });

  it("reports in GET /api/config that a deployment without mail has none, so the screen can say whom to ask", async () => {
    const without = serve({ mail: { available: false, send: () => Promise.reject(new Error("no mail")) } });
    const withMail = serve();

    const off = await without.server.fetch(new Request(new URL("/api/config", without.origin)));
    const on = await withMail.server.fetch(new Request(new URL("/api/config", withMail.origin)));

    expect(((await off.json()) as { features: { mail: boolean } }).features.mail).toBe(false);
    expect(((await on.json()) as { features: { mail: boolean } }).features.mail).toBe(true);
  });

  it("falls in one latency class for a known address as for an unknown one", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const world = serve();
    const owner = await ownerAccount();

    const ratio = await medianLatencyRatio(
      () => forgot(world, "nobody@example.test"),
      () => forgot(world, owner.email),
    );

    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("rejects a body that is not an email address with 422, and an unknown field", async () => {
    const world = serve();
    for (const body of [{ email: "not an address" }, {}, { email: "a@example.test", extra: 1 }]) {
      expect((await world.server.fetch(postJson(world.origin, FORGOT, body))).status).toBe(422);
    }
    expect(await mailJobs()).toEqual([]);
  });

  it("refuses a request that does not come from the application itself, and queues nothing", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const request = postJson(world.origin, FORGOT, { email: owner.email });
    request.headers.set("origin", "https://evil.example.test");

    const response = await world.server.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cross_site_request" });
    expect(await mailJobs()).toEqual([]);
  });
});

describe("the request limits of the reset link (T9)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is 5 per hour per address and 3 per hour per target email by default", () => {
    const registry = createRateLimitRegistry(serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()) }));
    expect(registry.window("reset")).toEqual({ capacity: 5, refillPerSecond: 5 / 3600 });
    expect(registry.window("reset:email")).toEqual({ capacity: 3, refillPerSecond: 3 / 3600 });
  });

  it("allows 5 requests per hour from one address and answers the sixth 429 with Retry-After, counting each address on its own", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_IP: "5/hour", TRUSTED_PROXY_HOPS: "1" } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await forgot(world, `flood.${String(attempt)}@example.test`, { forwardedFor: "198.51.100.7" })).status).toBe(202);
    }

    const denied = await forgot(world, "flood.5@example.test", { forwardedFor: "198.51.100.7" });

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await denied.json()).toMatchObject({ code: "rate_limited" });
    expect((await forgot(world, "flood.5@example.test", { forwardedFor: "198.51.100.8" })).status).toBe(202);
  });

  it("allows 3 requests per hour for one email, in any spelling and from any address, and queues nothing for the fourth", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_EMAIL: "3/hour", TRUSTED_PROXY_HOPS: "1" } });
    const owner = await ownerAccount({ email: "Target.Person@Example.test" });
    for (const [index, email] of [owner.email, owner.email.toLowerCase(), owner.email.toUpperCase()].entries()) {
      expect((await forgot(world, email, { forwardedFor: `198.51.100.${String(index + 1)}` })).status).toBe(202);
    }
    expect(await mailJobs()).toHaveLength(3);

    const denied = await forgot(world, owner.email, { forwardedFor: "198.51.100.9" });

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await mailJobs()).toHaveLength(3);
    expect((await forgot(world, "someone.else@example.test", { forwardedFor: "198.51.100.9" })).status).toBe(202);
  });

  it("counts an unknown address against the email limit exactly as a known one", async () => {
    const world = serve({ env: { RATE_LIMIT_RESET_EMAIL: "3/hour" } });
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await forgot(world, "ghost@example.test")).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe("POST /api/v1/auth/password/reset", { timeout: TEST_TIMEOUT_MS }, () => {
  it("sets the password, ends every session the account had and signs it in with a fresh one", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const earlier = [await signInAs(world, owner), await signInAs(world, owner)];
    const token = await issueToken(owner.id);

    const response = await reset(world, { token: token.value, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "done" });
    const fresh = issuedToken(response);
    expect(fresh).toBeDefined();
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    for (const session of earlier) {
      expect((await probe(world, session)).status).toBe(401);
    }
    expect((await probe(world, fresh ?? null)).status).toBe(200);
    expect(await sessionRows(database(), owner.id)).toHaveLength(1);
    expect(await passwordIs(owner.id, NEW_PASSWORD)).toBe(true);
    expect((await login(world, owner.email, OLD_PASSWORD)).status).toBe(401);
    expect((await login(world, owner.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("refuses the same token the second time with 410 token_expired and changes nothing", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);
    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);
    const sessionsBefore = await sessionRows(database(), owner.id);

    const replay = await reset(world, { token: token.value, newPassword: "a different password for the replay" });

    expect(replay.status).toBe(410);
    expect(replay.headers.get("content-type")).toContain("application/problem+json");
    expect(await replay.json()).toMatchObject({ code: "token_expired", status: 410 });
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(await sessionRows(database(), owner.id)).toEqual(sessionsBefore);
    expect(await passwordIs(owner.id, NEW_PASSWORD)).toBe(true);
  });

  it("refuses a token after its hour with 410, keeps the old password and the old sessions, and honours it just before", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const session = await signInAs(world, owner);
    const late = await issueToken(owner.id);
    await ageToken(owner.id, HOUR_SECONDS + 1);

    const refused = await reset(world, { token: late.value, newPassword: NEW_PASSWORD });

    expect(refused.status).toBe(410);
    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
    expect((await probe(world, session)).status).toBe(200);

    const timely = await issueToken(owner.id);
    await ageToken(owner.id, HOUR_SECONDS - 60);
    expect((await reset(world, { token: timely.value, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("refuses a token once a newer one was issued, and honours the newer one", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const older = await issueToken(owner.id);
    const newer = await issueToken(owner.id);

    const refused = await reset(world, { token: older.value, newPassword: NEW_PASSWORD });

    expect(refused.status).toBe(410);
    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
    expect((await reset(world, { token: newer.value, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("answers an unknown token, a malformed one, an expired one, a used one, one of another kind and one of another account with one identical 410", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const used = await issueToken(owner.id);
    await reset(world, { token: used.value, newPassword: NEW_PASSWORD });
    const other = await ownerAccount();
    const stale = await issueToken(other.id);
    await ageToken(other.id, HOUR_SECONDS + 1);
    const third = await ownerAccount();
    const verification = await issueToken(third.id, "email_verify");

    const answers: { status: number; body: string }[] = [];
    for (const token of [generateCredentialToken().value, "not-a-token", "A".repeat(43), used.value, stale.value, verification.value]) {
      const response = await reset(world, { token, newPassword: NEW_PASSWORD });
      const text = await response.text();
      answers.push({ status: response.status, body: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([name]) => name !== "requestId"))) });
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    expect(answers[0]?.status).toBe(410);
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
    expect(JSON.parse(answers[0]?.body ?? "{}")).toMatchObject({ code: "token_expired" });
    for (const stranger of [other, third]) {
      expect(await passwordIs(stranger.id, stranger.password)).toBe(true);
    }
  });

  it("does not let the token of one account reset another", async () => {
    const world = serve();
    const first = await ownerAccount();
    const second = await ownerAccount();
    const token = await issueToken(first.id);
    await issueToken(second.id);
    const secondSession = await signInAs(world, second);

    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);

    expect(await passwordIs(first.id, NEW_PASSWORD)).toBe(true);
    expect(await passwordIs(second.id, second.password)).toBe(true);
    expect((await probe(world, secondSession)).status).toBe(200);
    expect((await credentialTokens()).filter((row) => row.account_id === second.id).map((row) => row.used_at)).toEqual([null]);
  });

  it("lets one of several submissions of the same link at once through", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);

    const responses = await Promise.all(Array.from({ length: PARALLEL }, () => reset(world, { token: token.value, newPassword: NEW_PASSWORD })));

    expect(responses.map((response) => response.status).sort()).toEqual([200, ...Array.from({ length: PARALLEL - 1 }, () => 410)]);
    expect(await sessionRows(database(), owner.id)).toHaveLength(1);
  });

  it("signs an account with a second factor in with a partial session, which reaches nothing but the second factor", async () => {
    const world = serve();
    const owner = await ownerAccount();
    await setSecondFactor(owner.id);
    const token = await issueToken(owner.id);

    const response = await reset(world, { token: token.value, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "mfa" });
    expect((await sessionRows(database(), owner.id)).map((row) => row.level)).toEqual(["partial"]);
    const denied = await probe(world, issuedToken(response) ?? null);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "mfa_required" });
    expect(await passwordIs(owner.id, NEW_PASSWORD)).toBe(true);
  });

  it("applies the password policy before it touches the token: a weak password answers 422 weak_password and the link still works", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);

    for (const newPassword of ["short", "password1234", "x".repeat(257)]) {
      const response = await reset(world, { token: token.value, newPassword });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "weak_password" });
    }

    expect((await credentialTokens()).map((row) => row.used_at)).toEqual([null]);
    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("answers 422 validation_failed for a body without a password or with a field it does not know", async () => {
    const world = serve();
    const token = generateCredentialToken().value;

    for (const body of [{ token }, { newPassword: NEW_PASSWORD }, { token, newPassword: NEW_PASSWORD, extra: true }, { token: "", newPassword: NEW_PASSWORD }]) {
      const response = await reset(world, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "validation_failed" });
    }
  });

  it("ends the session of the cookie the request carried along with the others", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const carried = await signInAs(world, owner);
    const token = await issueToken(owner.id);

    const response = await reset(world, { token: token.value, newPassword: NEW_PASSWORD }, `__Host-slugbase_session=${carried}`);

    expect(response.status).toBe(200);
    expect((await probe(world, carried)).status).toBe(401);
    expect(await sessionRows(database(), owner.id)).toHaveLength(1);
  });

  it("does not reset the password of an account whose address was never verified, and answers it as an unknown token", async () => {
    const world = serve();
    const registrant = await seedAccount(database(), { password: OLD_PASSWORD });
    const token = await issueToken(registrant.id);

    const response = await reset(world, { token: token.value, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "token_expired" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await passwordIs(registrant.id, OLD_PASSWORD)).toBe(true);
    expect(await sessionRows(database(), registrant.id)).toEqual([]);
  });

  it("does not reset the password of an account that was disabled after the link was sent", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${owner.id}`;
    });

    const response = await reset(world, { token: token.value, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(410);
    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
  });

  it("keeps the old password, the old sessions and the link when the new session cannot be created", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const session = await signInAs(world, owner);
    const token = await issueToken(owner.id);
    await database().owner.unsafe(`
      CREATE FUNCTION public.refuse_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no session'; END $$;
      CREATE TRIGGER refuse_session BEFORE INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.refuse_session();`);
    try {
      const failed = await reset(world, { token: token.value, newPassword: NEW_PASSWORD });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(failed.headers.get("set-cookie")).toBeNull();
    } finally {
      await database().owner.unsafe("DROP TRIGGER refuse_session ON public.sessions; DROP FUNCTION public.refuse_session()");
    }

    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
    expect((await probe(world, session)).status).toBe(200);
    expect((await credentialTokens()).map((row) => row.used_at)).toEqual([null]);
    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("refuses a request that does not come from the application itself", async () => {
    const world = serve();
    const request = postJson(world.origin, RESET, { token: generateCredentialToken().value, newPassword: NEW_PASSWORD });
    request.headers.set("origin", "https://evil.example");

    const response = await world.server.fetch(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cross_site_request" });
  });
});

describe("the password changed notice of POST /api/v1/auth/password/reset", { timeout: TEST_TIMEOUT_MS }, () => {
  async function setLocale(accountId: string, locale: "en" | "de"): Promise<void> {
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      await tx`UPDATE accounts SET locale = ${locale} WHERE id = ${accountId}`;
    });
  }

  it("queues one passwordChanged mail job for the account whose password was reset, and none for another", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const bystander = await ownerAccount();
    const token = await issueToken(owner.id);

    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);

    expect((await mailJobs()).map((job) => job.data)).toEqual([{ template: "passwordChanged", accountId: owner.id }]);
    expect((await mailJobs()).map((job) => job.data["accountId"])).not.toContain(bystander.id);
  });

  it("queues one for an account with a second factor too, which answers next mfa", async () => {
    const world = serve();
    const owner = await ownerAccount();
    await setSecondFactor(owner.id);
    const token = await issueToken(owner.id);

    expect(await (await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).json()).toEqual({ next: "mfa" });

    expect((await mailJobs()).map((job) => job.data["template"])).toEqual(["passwordChanged"]);
  });

  it("queues none for a token that is refused: used, expired, unknown, replaced, of an unverified account or of a disabled one", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const used = await issueToken(owner.id);
    expect((await reset(world, { token: used.value, newPassword: NEW_PASSWORD })).status).toBe(200);
    const stale = await issueToken(owner.id);
    await ageToken(owner.id, HOUR_SECONDS + 1);
    const older = await issueToken(owner.id);
    await issueToken(owner.id);
    const registrant = await seedAccount(database(), { password: OLD_PASSWORD });
    const unverified = await issueToken(registrant.id);
    const disabled = await ownerAccount();
    const disabledToken = await issueToken(disabled.id);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled.id}`;
    });
    const before = (await mailJobs()).length;

    for (const token of [used, stale, older, unverified, disabledToken, generateCredentialToken()]) {
      expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(410);
    }

    expect(await mailJobs()).toHaveLength(before);
  });

  it("queues none for a weak password, which leaves the link usable for one notice afterwards", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);

    expect((await reset(world, { token: token.value, newPassword: "short" })).status).toBe(422);
    expect(await mailJobs()).toEqual([]);

    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await mailJobs()).toHaveLength(1);
  });

  it("queues exactly one when several submissions of one link race", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);

    await Promise.all(Array.from({ length: PARALLEL }, () => reset(world, { token: token.value, newPassword: NEW_PASSWORD })));

    expect(await mailJobs()).toHaveLength(1);
  });

  it("queues nothing, and still resets, when the mail port cannot send", async () => {
    const world = serve({ mail: { available: false, send: () => Promise.reject(new Error("no mail")) } });
    const owner = await ownerAccount();
    const token = await issueToken(owner.id);

    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);

    expect(await mailJobs()).toEqual([]);
    expect(await passwordIs(owner.id, NEW_PASSWORD)).toBe(true);
  });

  it("undoes the reset, the use of the link and every session when the job cannot be queued, and answers 5xx with no cookie", async () => {
    const world = serve();
    const owner = await ownerAccount();
    const session = await signInAs(world, owner);
    const token = await issueToken(owner.id);
    await database().owner.unsafe(`
      CREATE FUNCTION public.refuse_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no job'; END $$;
      CREATE TRIGGER refuse_job BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION public.refuse_job();`);
    try {
      const failed = await reset(world, { token: token.value, newPassword: NEW_PASSWORD });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(failed.headers.get("set-cookie")).toBeNull();
    } finally {
      await database().owner.unsafe("DROP TRIGGER refuse_job ON pgboss.job; DROP FUNCTION public.refuse_job()");
    }

    expect(await mailJobs()).toEqual([]);
    expect(await passwordIs(owner.id, OLD_PASSWORD)).toBe(true);
    expect((await probe(world, session)).status).toBe(200);
    expect((await credentialTokens()).map((row) => row.used_at)).toEqual([null]);
    expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await mailJobs()).toHaveLength(1);
  });

  describe("through the worker", () => {
    const mail = new InMemoryMail();
    let worker: RunningWorker | undefined;

    beforeEach(() => {
      mail.clear();
    });

    afterEach(async () => {
      await worker?.shutdown();
      worker = undefined;
    });

    async function startWorker(): Promise<void> {
      const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
      worker = await createWorker({
        config,
        adapters: { ...adapters(), mail },
        modules: [],
        logger: recordingLogger(),
        database: tenantDatabase(database()),
        pollingIntervalSeconds: POLL_SECONDS,
        shutdownTimeoutMs: 500,
      }).start();
    }

    async function until(check: () => boolean, what: string): Promise<void> {
      const deadline = Date.now() + WAIT_MS;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}`);
        }
        await sleep(50);
      }
    }

    it("sends the existing password changed email once, in the language of the account", async () => {
      const world = serve({ mail });
      const owner = await ownerAccount();
      await setLocale(owner.id, "de");
      const token = await issueToken(owner.id);

      expect((await reset(world, { token: token.value, newPassword: NEW_PASSWORD })).status).toBe(200);
      await startWorker();
      await until(() => mail.sent.length === 1, "the notice to reach the mail port");
      await sleep(POLL_SECONDS * 2000);

      expect(mail.sent).toEqual([{ template: "passwordChanged", to: owner.email, locale: "de", data: { displayName: "Test account" } }]);
    });
  });
});

describe("a reset requested before the owner verified the address (doc 02 section 2.6)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers 410 token_expired once the owner has verified, and leaves the owner's password in force", async () => {
    const world = serve();
    const registrant = await seedAccount(database(), { password: OLD_PASSWORD });
    const stale = await issueToken(registrant.id, "password_reset");
    const verification = await issueToken(registrant.id, "email_verify");
    const OWNER_PASSWORD = "the password the owner chose when verifying";

    const verified = await world.server.fetch(postJson(world.origin, VERIFY, { token: verification.value, password: OWNER_PASSWORD }));
    expect(verified.status).toBe(200);
    const refused = await reset(world, { token: stale.value, newPassword: NEW_PASSWORD });

    expect(refused.status).toBe(410);
    expect(await refused.json()).toMatchObject({ code: "token_expired" });
    expect(await passwordIs(registrant.id, OWNER_PASSWORD)).toBe(true);
    expect((await probe(world, issuedToken(verified) ?? null)).status).toBe(200);
  });
});

describe("the reset mail of a request through the worker", { timeout: TEST_TIMEOUT_MS }, () => {
  const mail = new InMemoryMail();
  let worker: RunningWorker | undefined;

  async function startWorker(): Promise<void> {
    const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
    worker = await createWorker({
      config,
      adapters: { ...adapters(), mail },
      modules: [],
      logger: recordingLogger(),
      database: tenantDatabase(database()),
      pollingIntervalSeconds: POLL_SECONDS,
      shutdownTimeoutMs: 500,
    }).start();
  }

  beforeEach(() => {
    mail.clear();
  });

  afterEach(async () => {
    await worker?.shutdown();
    worker = undefined;
  });

  async function mailJobsDone(count: number): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const rows = await database().app<{ state: string }[]>`SELECT state FROM pgboss.job WHERE name = 'mail.send'`;
      if (rows.length >= count && rows.every((row) => row.state === "completed")) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the mail jobs");
      }
      await sleep(50);
    }
  }

  function tokenOf(message: { readonly data: Readonly<Record<string, string | number | boolean>> }): string {
    return String(message.data["token"]);
  }

  it("emails an account with a verified address and a password one link that works once for an hour, and emails nobody else", async () => {
    const world = serve({ mail });
    const owner = await ownerAccount({ email: "forgot.me@example.test" });
    const withoutPassword = await seedAccount(database(), { emailVerified: true, password: null, email: "no.password@example.test" });
    const unverified = await seedAccount(database(), { email: "not.verified@example.test" });

    for (const email of [owner.email, withoutPassword.email, unverified.email, "nobody@example.test"]) {
      expect((await forgot(world, email)).status).toBe(202);
    }
    await startWorker();
    await mailJobsDone(4);

    expect(mail.sent).toHaveLength(1);
    const [message] = mail.sent;
    expect(message).toMatchObject({ template: "passwordReset", to: "forgot.me@example.test" });
    const token = message === undefined ? "" : tokenOf(message);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await credentialTokens();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ account_id: owner.id, purpose: "password_reset", used_at: null });
    expect(stored[0]?.token_hash).toEqual(createHash("sha256").update(Buffer.from(token, "base64url")).digest());
    expect(stored[0]?.lifetime_seconds).toBeCloseTo(HOUR_SECONDS, -1);

    const redeemed = await reset(world, { token, newPassword: NEW_PASSWORD });
    expect(redeemed.status).toBe(200);
    expect((await reset(world, { token, newPassword: NEW_PASSWORD })).status).toBe(410);
  });

  it("replaces the earlier link when a newer one is requested, so only the newest works", async () => {
    const world = serve({ mail });
    const owner = await ownerAccount();

    expect((await forgot(world, owner.email)).status).toBe(202);
    await startWorker();
    await mailJobsDone(1);
    expect((await forgot(world, owner.email)).status).toBe(202);
    await mailJobsDone(2);

    expect(mail.sent).toHaveLength(2);
    const [first, second] = mail.sent.map(tokenOf);
    expect(first).not.toBe(second);
    expect((await credentialTokens()).filter((row) => row.used_at === null)).toHaveLength(1);
    expect((await reset(world, { token: first ?? "", newPassword: NEW_PASSWORD })).status).toBe(410);
    expect((await reset(world, { token: second ?? "", newPassword: NEW_PASSWORD })).status).toBe(200);
  });
});
