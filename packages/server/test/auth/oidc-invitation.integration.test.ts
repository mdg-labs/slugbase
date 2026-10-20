import { createHash } from "node:crypto";
import { generateCredentialToken, type SecretBoxPort } from "@slugbase/core";
import { FakeIdentity, type FakeIdentityGrant } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server, type ServerModule } from "../../src/create-server.ts";
import { HookResult } from "../../src/hooks/index.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { urlOf } from "../migrate/support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { issuedToken, seedAccount, seedMembership, seedWorkspace, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// Accepting an invitation through an OIDC provider, through the whole callback over the migrated database (doc 02
// sections 2.8 and 3.4, Q31, Q32, doc 04 section 4.5, doc 05 section 2.1, doc 10 T9, T19 and T20). The provider is a
// FakeIdentity. The failure scenarios: a provider that returns another address than the invited one, or the invited one
// unverified or with no verification claim, leaves the invitation unredeemed, the identity unlinked and no account,
// membership or session behind; an account created that the registration policy refused or over an address an unverified
// account holds; the token kept in the handshake record in the clear, in the authorization address or in the return path;
// a handshake used twice; a start that is not counted against the redemption limits. Every refusal ends on the same
// generic failure as any other.

const SESSION_COOKIE = "__Host-slugbase_session";
const PREAUTH_COOKIE = "__Host-slugbase_oidc";
const ISSUER = "https://idp.example.test";
const START = "/api/v1/auth/oidc/idp/start";
const FAILED = "/login?error=oidc_failed";
const HOOK_TIMEOUT_MS = 120_000;
// What the browser sends for the provider button on the invitation page, a navigation of the application's own page.
const FROM_THE_APPLICATION = { "sec-fetch-site": "same-origin" };

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The events are queued in the transaction that accepts, so the queues exist, as they do once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name IN ('event.account.created', 'event.workspace.created', 'event.member.joined')`;
  await database().owner`TRUNCATE accounts, workspaces CASCADE`;
});

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly fake: FakeIdentity;
  readonly logs: ReturnType<typeof recordingLogger>;
}

function provider(keys: Record<string, string> = {}): Record<string, string> {
  return {
    OIDC_IDP_CLIENT_ID: "client-id-1",
    OIDC_IDP_CLIENT_SECRET: "a-client-secret",
    OIDC_IDP_ISSUER_URL: ISSUER,
    ...keys,
  };
}

function serve(
  env: Record<string, string> = provider(),
  modules: readonly ServerModule[] = [],
  options: { readonly secretBox?: SecretBoxPort } = {},
): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_TOKEN_REDEEM_IP: "1000/hour",
    RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "1000/hour",
    ...env,
  });
  const fake = new FakeIdentity({ providers: [{ id: "idp", displayName: "Example IdP", issuer: ISSUER, clientId: "client-id-1" }] });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
      tenantResolver: createAccountOnlyTenantResolver(),
      secretBox: options.secretBox ?? testSecretBox(testKey("oidc-1")),
      identity: { available: true, listProviders: () => fake.listProviders(), begin: (request) => fake.begin(request), complete: (request) => fake.complete(request) },
    },
    modules,
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, fake, logs };
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*);`).exec(header);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

interface Invitation {
  readonly id: string;
  readonly workspaceId: string;
  readonly token: string;
}

let invitationNumber = 0;

/** A workspace with an owner and a pending invitation of the address into it, found by the hash of a token the test holds. */
async function invitation(email: string, options: { readonly role?: "admin" | "member"; readonly expiresInSeconds?: number } = {}): Promise<Invitation> {
  invitationNumber += 1;
  const workspaceId = await seedWorkspace(database(), { name: "Invited into" });
  const owner = await seedAccount(database(), { email: `invitation-owner${String(invitationNumber)}@example.test`, emailVerified: true });
  await seedMembership(database(), { workspaceId, accountId: owner.id, role: "owner" });
  const token = generateCredentialToken();
  const id = `0192f3a0-eeee-7000-8000-${invitationNumber.toString(16).padStart(12, "0")}`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, ${options.role ?? "member"}, ${token.hash}, ${owner.id}, now() + ${options.expiresInSeconds ?? 86_400} * interval '1 second')`;
  });
  return { id, workspaceId, token: token.value };
}

function startUrl(token: string, extra = ""): string {
  return `${START}?intent=invite&invitation=${token}&returnTo=/${extra}`;
}

/** Starts the handshake and plays the person approving it. */
async function approved(world: World, query: string, grant: FakeIdentityGrant, headers: Record<string, string> = {}) {
  const started = await world.server.fetch(new Request(new URL(query, world.origin), { headers: { ...FROM_THE_APPLICATION, ...headers } }));
  const authorizationUrl = started.headers.get("location") ?? "";
  const preAuth = cookieValue(started, PREAUTH_COOKIE);
  if (started.status !== 302 || preAuth === undefined) {
    throw new Error(`the handshake did not start: ${String(started.status)} ${authorizationUrl}`);
  }
  return { callbackUrl: world.fake.approve(authorizationUrl, grant), preAuth, authorizationUrl, state: new URL(authorizationUrl).searchParams.get("state") ?? "" };
}

function callbackWith(world: World, callbackUrl: string, preAuth: string, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Headers(headers);
  request.set("cookie", [request.get("cookie"), `${PREAUTH_COOKIE}=${preAuth}`].filter((part) => part !== null).join("; "));
  return world.server.fetch(new Request(callbackUrl, { headers: request }));
}

/** Runs the whole handshake of the invite intent for a provider that answers with the grant. */
async function accepted(world: World, token: string, grant: FakeIdentityGrant, headers: Record<string, string> = {}): Promise<Response> {
  const { callbackUrl, preAuth } = await approved(world, startUrl(token), grant);
  return callbackWith(world, callbackUrl, preAuth, headers);
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  locale: string;
  verified: boolean;
}

async function accountRows(): Promise<AccountRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`
      SELECT id, email, display_name, password_hash, locale, email_verified_at IS NOT NULL AS verified
      FROM accounts ORDER BY created_at, id`;
  });
  return [...rows];
}

async function identityRows(): Promise<{ account_id: string; provider: string; subject: string; email_at_link: string }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string; provider: string; subject: string; email_at_link: string }[]>`
      SELECT account_id, provider, subject, email_at_link FROM account_identities ORDER BY created_at, id`;
  });
  return [...rows];
}

async function membersOf(workspaceId: string): Promise<Record<string, string>> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  });
  return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
}

async function invitationState(id: string): Promise<{ status: string; accepted_by: string | null }> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ status: string; accepted_by: string | null }[]>`SELECT status, accepted_by FROM workspace_invitations WHERE id = ${id}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

async function stateRecords(): Promise<{ intent: string; return_to: string; invitation_token_hash: Buffer | null; text: string }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ intent: string; return_to: string; invitation_token_hash: Buffer | null; text: string }[]>`
      SELECT intent, return_to, invitation_token_hash, s::text AS text FROM oidc_login_states s`;
  });
  return [...rows];
}

async function jobData(name: string): Promise<Record<string, unknown>[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY id`;
  return rows.map((row) => row.data);
}

async function auditEvents(workspaceId: string): Promise<{ action: string; actor_account_id: string | null; actor_label: string; metadata: unknown }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ action: string; actor_account_id: string | null; actor_label: string; metadata: unknown }[]>`
      SELECT action, actor_account_id, actor_label, metadata FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
}

async function personalWorkspaceCount(accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: string }[]>`SELECT count(*)::text AS n FROM workspace_members WHERE account_id = ${accountId} AND role = 'owner'`;
  });
  return Number(rows[0]?.n);
}

async function sessionsOfEveryone(): Promise<number> {
  const accounts = await accountRows();
  return (await Promise.all(accounts.map((row) => sessionRows(database(), row.id)))).reduce((sum, rows) => sum + rows.length, 0);
}

function expectFailed(response: Response): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(FAILED);
  expect(cookieValue(response, SESSION_COOKIE)).toBeUndefined();
  expect(response.headers.getSetCookie().filter((header) => header.startsWith(`${PREAUTH_COOKIE}=;`))).toHaveLength(1);
}

/** What a refused acceptance must leave as it was, besides the accounts the test seeded itself. */
async function expectUntouched(target: Invitation, accounts: number): Promise<void> {
  expect(await invitationState(target.id)).toEqual({ status: "pending", accepted_by: null });
  expect(await identityRows()).toEqual([]);
  expect(Object.values(await membersOf(target.workspaceId))).toEqual(["owner"]);
  expect(await accountRows()).toHaveLength(accounts);
  expect(await sessionsOfEveryone()).toBe(0);
  expect(await jobData("event.account.created")).toEqual([]);
  expect(await jobData("event.member.joined")).toEqual([]);
}

function recording(seen: { email: string; path: string }[], answer: "allow" | "refuse"): ServerModule {
  return {
    name: "policy",
    hooks: {
      registrationPolicy: (input) => {
        seen.push({ email: input.email, path: input.path });
        return answer === "allow" ? HookResult.allow() : HookResult.refuse("blocked_domain");
      },
    },
    register: () => ({}),
  };
}

async function verifiedAccount(email: string, options: { verified?: boolean; disabled?: boolean; password?: string | null } = {}): Promise<SeededAccount> {
  return seedAccount(database(), { email, emailVerified: options.verified ?? true, disabled: options.disabled ?? false, ...(options.password === undefined ? {} : { password: options.password }) });
}

describe("accepting an invitation through a provider", () => {
  it("creates the verified account of the invited address even where the provider does not create accounts, links the identity, joins the workspace with the invited role and signs in with the workspace active", async () => {
    const seen: { email: string; path: string }[] = [];
    const world = serve(provider({ EMAIL_VERIFICATION_REQUIRED: "true" }), [recording(seen, "allow")]);
    const target = await invitation("New.Person@Example.test", { role: "admin" });

    const response = await accepted(world, target.token, { subject: "new-subject", email: "new.person@example.test", emailVerified: true, displayName: "Grace Hopper" }, { "accept-language": "de" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.getSetCookie().filter((header) => header.startsWith(`${PREAUTH_COOKIE}=;`))).toHaveLength(1);
    const cookie = issuedToken(response);
    expect(cookie).toBeDefined();
    const accounts = await accountRows();
    expect(accounts).toHaveLength(2);
    const created = accounts.find((row) => row.email === "New.Person@Example.test");
    expect(created).toMatchObject({ display_name: "Grace Hopper", password_hash: null, locale: "de", verified: true });
    expect(await identityRows()).toEqual([{ account_id: created?.id, provider: "idp", subject: "new-subject", email_at_link: "new.person@example.test" }]);
    expect((await membersOf(target.workspaceId))[created?.id ?? ""]).toBe("admin");
    expect(await invitationState(target.id)).toEqual({ status: "accepted", accepted_by: created?.id });
    expect(await personalWorkspaceCount(created?.id ?? "")).toBe(0);
    expect(seen).toEqual([{ email: "New.Person@Example.test", path: "invitation" }]);

    const me = await world.server.fetch(new Request(new URL("/api/v1/me", world.origin), { headers: { cookie: `${SESSION_COOKIE}=${cookie ?? ""}` } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      account: { id: created?.id, email: "New.Person@Example.test", emailVerified: true, hasPassword: false },
      activeWorkspaceId: target.workspaceId,
      memberships: [{ workspaceId: target.workspaceId, role: "admin" }],
    });
    const createdJobs = await jobData("event.account.created");
    expect(createdJobs.map((data) => ({ accountId: data["accountId"], path: data["path"] }))).toEqual([{ accountId: created?.id, path: "invitation" }]);
    expect((await jobData("event.member.joined")).map((data) => ({ workspaceId: data["workspaceId"], accountId: data["accountId"], role: data["role"] }))).toEqual([
      { workspaceId: target.workspaceId, accountId: created?.id, role: "admin" },
    ]);
    expect((await auditEvents(target.workspaceId)).filter((event) => event.actor_account_id === created?.id)).toEqual([
      { action: "member.joined", actor_account_id: created?.id, actor_label: "Grace Hopper", metadata: { role: "admin" } },
    ]);
  });

  it("signs the account the identity is linked to in and joins it, creating no account and linking nothing twice", async () => {
    const seen: { email: string; path: string }[] = [];
    const world = serve(provider(), [recording(seen, "refuse")]);
    const holder = await verifiedAccount("Linked@Example.test");
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${holder.id}, true)`;
      await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES ('0192f3a0-dddd-7000-8000-00000000e001', ${holder.id}, 'idp', 'linked-subject', ${holder.email})`;
    });
    const target = await invitation("linked@example.test");

    const response = await accepted(world, target.token, { subject: "linked-subject", email: "LINKED@example.test", emailVerified: true });

    expect(response.headers.get("location")).toBe("/");
    expect(issuedToken(response)).toBeDefined();
    expect(await accountRows()).toHaveLength(2);
    expect(await identityRows()).toHaveLength(1);
    expect((await membersOf(target.workspaceId))[holder.id]).toBe("member");
    expect(await invitationState(target.id)).toEqual({ status: "accepted", accepted_by: holder.id });
    expect((await sessionRows(database(), holder.id)).map((row) => row.level)).toEqual(["full"]);
    expect(seen).toEqual([]);
    expect(await jobData("event.account.created")).toEqual([]);
  });

  it("links the identity to the verified account that holds the invited address, signs it in and joins it, without asking the registration policy", async () => {
    const seen: { email: string; path: string }[] = [];
    const world = serve(provider(), [recording(seen, "refuse")]);
    const holder = await verifiedAccount("holder@example.test");
    const target = await invitation("Holder@Example.test");

    const response = await accepted(world, target.token, { subject: "holder-subject", email: "holder@example.test", emailVerified: true });

    expect(response.headers.get("location")).toBe("/");
    expect(issuedToken(response)).toBeDefined();
    expect(await accountRows()).toHaveLength(2);
    expect(await identityRows()).toEqual([{ account_id: holder.id, provider: "idp", subject: "holder-subject", email_at_link: "holder@example.test" }]);
    expect((await membersOf(target.workspaceId))[holder.id]).toBe("member");
    expect(await invitationState(target.id)).toEqual({ status: "accepted", accepted_by: holder.id });
    expect(seen).toEqual([]);
  });

  it("replaces the session the browser carried", async () => {
    const world = serve();
    const earlier = await verifiedAccount("earlier@example.test");
    const login = await world.server.fetch(
      new Request(new URL("/api/v1/auth/login", world.origin), {
        method: "POST",
        headers: { "content-type": "application/json", origin: world.origin },
        body: JSON.stringify({ email: earlier.email, password: earlier.password, remember: false }),
      }),
    );
    const carried = issuedToken(login);
    expect(carried).toBeDefined();
    expect(await sessionRows(database(), earlier.id)).toHaveLength(1);
    const target = await invitation("replacer@example.test");

    const response = await accepted(world, target.token, { subject: "replacer-subject", email: "replacer@example.test", emailVerified: true }, { cookie: `${SESSION_COOKIE}=${carried ?? ""}` });

    expect(response.headers.get("location")).toBe("/");
    expect(await sessionRows(database(), earlier.id)).toEqual([]);
  });

  describe("accepts nothing, links nothing and creates nothing, and ends on /login with the one generic failure code", () => {
    it.each<[string, Partial<FakeIdentityGrant>]>([
      ["another address than the invited one", { email: "somebody.else@example.test", emailVerified: true }],
      ["an address that only starts like the invited one", { email: "invited@example.test.evil", emailVerified: true }],
      ["the invited address, unverified", { email: "invited@example.test", emailVerified: false }],
      ["the invited address with no verification claim", { email: "invited@example.test" }],
      ["no address at all", { emailVerified: true }],
    ])("for a provider that returns %s", async (_name, claims) => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));
      const target = await invitation("invited@example.test");

      expectFailed(await accepted(world, target.token, { subject: "attacker-subject", ...claims }));

      await expectUntouched(target, 1);
    });

    it("for a provider that returns the address of an account that is not the invited one, even though that account holds the identity", async () => {
      const world = serve();
      const holder = await verifiedAccount("moved.on@example.test");
      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${holder.id}, true)`;
        await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES ('0192f3a0-dddd-7000-8000-00000000e002', ${holder.id}, 'idp', 'moved-subject', ${holder.email})`;
      });
      const target = await invitation("invited@example.test");

      expectFailed(await accepted(world, target.token, { subject: "moved-subject", email: "invited@example.test", emailVerified: true }));

      expect(await invitationState(target.id)).toEqual({ status: "pending", accepted_by: null });
      expect(Object.values(await membersOf(target.workspaceId))).toEqual(["owner"]);
      expect(await sessionRows(database(), holder.id)).toEqual([]);
      expect(await identityRows()).toHaveLength(1);
    });

    it("for an invited address that an account holds without having verified it, and for one a disabled account holds", async () => {
      const world = serve();
      await verifiedAccount("unverified@example.test", { verified: false });
      await verifiedAccount("disabled@example.test", { disabled: true });
      const first = await invitation("unverified@example.test");
      const second = await invitation("disabled@example.test");

      expectFailed(await accepted(world, first.token, { subject: "s1", email: "unverified@example.test", emailVerified: true }));
      expectFailed(await accepted(world, second.token, { subject: "s2", email: "disabled@example.test", emailVerified: true }));

      for (const target of [first, second]) {
        expect(await invitationState(target.id)).toEqual({ status: "pending", accepted_by: null });
        expect(Object.values(await membersOf(target.workspaceId))).toEqual(["owner"]);
      }
      expect(await identityRows()).toEqual([]);
      expect(await sessionsOfEveryone()).toBe(0);
    });

    it("for an address the registration policy refuses, which it was asked about for the path invitation", async () => {
      const seen: { email: string; path: string }[] = [];
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }), [recording(seen, "refuse")]);
      const target = await invitation("Refused@Example.test");

      expectFailed(await accepted(world, target.token, { subject: "refused-subject", email: "refused@example.test", emailVerified: true }));

      await expectUntouched(target, 1);
      expect(seen).toEqual([{ email: "Refused@Example.test", path: "invitation" }]);
    });

    it("for an invitation that was revoked, replaced or has expired by the time the callback arrives", async () => {
      const world = serve();
      const revoked = await invitation("revoked@example.test");
      const replaced = await invitation("replaced@example.test");
      const expiring = await invitation("expiring@example.test");
      const handshakes = [
        await approved(world, startUrl(revoked.token), { subject: "r1", email: "revoked@example.test", emailVerified: true }),
        await approved(world, startUrl(replaced.token), { subject: "r2", email: "replaced@example.test", emailVerified: true }),
        await approved(world, startUrl(expiring.token), { subject: "r3", email: "expiring@example.test", emailVerified: true }),
      ];
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${revoked.id}`;
        await tx`UPDATE workspace_invitations SET token_hash = ${createHash("sha256").update("another").digest()} WHERE id = ${replaced.id}`;
        await tx`UPDATE workspace_invitations SET expires_at = now() - interval '1 second' WHERE id = ${expiring.id}`;
      });

      for (const handshake of handshakes) {
        expectFailed(await callbackWith(world, handshake.callbackUrl, handshake.preAuth));
      }

      expect(await accountRows()).toHaveLength(3);
      expect(await identityRows()).toEqual([]);
      expect(await sessionsOfEveryone()).toBe(0);
      for (const target of [revoked, replaced, expiring]) {
        expect(Object.values(await membersOf(target.workspaceId))).toEqual(["owner"]);
      }
    });

    it("the second time a handshake is finished: the state works once, and the token with it", async () => {
      const world = serve();
      const target = await invitation("twice@example.test");
      const { callbackUrl, preAuth } = await approved(world, startUrl(target.token), { subject: "twice-subject", email: "twice@example.test", emailVerified: true });

      expect((await callbackWith(world, callbackUrl, preAuth)).headers.get("location")).toBe("/");
      const accounts = await accountRows();
      expectFailed(await callbackWith(world, callbackUrl, preAuth));

      expect(await accountRows()).toEqual(accounts);
      expect(await identityRows()).toHaveLength(1);
      expect(await stateRecords()).toEqual([]);
    });

    it("for a callback from a browser that does not hold the pre-auth cookie, which leaves the handshake and the invitation as they were", async () => {
      const world = serve();
      const target = await invitation("foreign@example.test");
      const { callbackUrl } = await approved(world, startUrl(target.token), { subject: "foreign-subject", email: "foreign@example.test", emailVerified: true });

      const response = await world.server.fetch(new Request(callbackUrl));

      expect(response.headers.get("location")).toBe(FAILED);
      expect(cookieValue(response, SESSION_COOKIE)).toBeUndefined();
      expect(await stateRecords()).toHaveLength(1);
      await expectUntouched(target, 1);
    });
  });

  describe("the handshake", () => {
    it("keeps the hash of the token with the state, and the token nowhere: not in the record, the authorization address, the return path or a cookie", async () => {
      const world = serve();
      const target = await invitation("kept@example.test");

      const started = await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: FROM_THE_APPLICATION }));

      expect(started.status).toBe(302);
      const location = started.headers.get("location") ?? "";
      expect(location.startsWith(ISSUER)).toBe(true);
      expect(location).not.toContain(target.token);
      expect(started.headers.getSetCookie().join("\n")).not.toContain(target.token);
      const [record, ...rest] = await stateRecords();
      expect(rest).toEqual([]);
      expect(record?.intent).toBe("invite");
      expect(record?.return_to).toBe("/");
      expect(record?.invitation_token_hash).toEqual(createHash("sha256").update(Buffer.from(target.token, "base64url")).digest());
      expect(record?.text).not.toContain(target.token);
    });

    it("reads no path to come back to, so the token cannot reach the record that way: the browser ends on Home", async () => {
      const world = serve();
      const target = await invitation("path@example.test");
      const { callbackUrl, preAuth } = await approved(world, `${START}?intent=invite&invitation=${target.token}&returnTo=/invite/${target.token}`, {
        subject: "path-subject",
        email: "path@example.test",
        emailVerified: true,
      });
      const [record, ...rest] = await stateRecords();
      expect(rest).toEqual([]);
      expect(record?.return_to).toBe("/");
      expect(record?.text).not.toContain(target.token);

      const response = await callbackWith(world, callbackUrl, preAuth);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
    });

    it("does not start from a page of another site, a sibling subdomain or a browser that says nothing about where the navigation came from", async () => {
      const world = serve(provider({ RATE_LIMIT_TOKEN_REDEEM_IP: "1/hour" }));
      const target = await invitation("cross-site@example.test");

      for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, {}]) {
        const response = await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers }));

        expect(response.status, JSON.stringify(headers)).toBe(302);
        expect(response.headers.get("location"), JSON.stringify(headers)).toBe(FAILED);
        expect(cookieValue(response, PREAUTH_COOKIE), JSON.stringify(headers)).toBe("");
        expect(cookieValue(response, SESSION_COOKIE), JSON.stringify(headers)).toBeUndefined();
        expect(world.logs.entries.at(-1), JSON.stringify(headers)).toMatchObject({ fields: { reason: "cross_site_start" } });
      }

      expect(await stateRecords()).toEqual([]);
      // The refused starts took nothing from the one redemption the address may make in the hour.
      expect((await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: FROM_THE_APPLICATION }))).status).toBe(302);
    });

    it("starts from the application's own page and from the address bar", async () => {
      const world = serve();
      const target = await invitation("same-origin@example.test");

      for (const site of ["same-origin", "none"]) {
        const response = await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: { "sec-fetch-site": site } }));

        expect(response.status, site).toBe(302);
        expect(new URL(response.headers.get("location") ?? "").origin, site).toBe(new URL(ISSUER).origin);
        expect(cookieValue(response, PREAUTH_COOKIE), site).not.toBe("");
        expect(cookieValue(response, PREAUTH_COOKIE), site).toBeDefined();
      }
      expect(await stateRecords()).toHaveLength(2);
    });

    it("does not start for a text that is not an invitation token, and stores nothing", async () => {
      const world = serve();

      for (const text of ["short", "x".repeat(43), "a".repeat(42), "%2e".repeat(20)]) {
        const response = await world.server.fetch(new Request(new URL(`${START}?intent=invite&invitation=${text}`, world.origin), { headers: FROM_THE_APPLICATION }));
        expect(response.status, text).toBe(302);
        expect(response.headers.get("location"), text).toBe(FAILED);
      }
      expect(await stateRecords()).toEqual([]);
    });

    it("refuses the invite intent without a token and a token on any other intent as a malformed query", async () => {
      const world = serve();
      const target = await invitation("shape@example.test");

      for (const query of ["?intent=invite", `?invitation=${target.token}`, `?intent=login&invitation=${target.token}`]) {
        const response = await world.server.fetch(new Request(new URL(`${START}${query}`, world.origin)));
        expect(response.status, query).toBe(422);
      }
      expect(await stateRecords()).toEqual([]);
    });

    it("starts for a token nobody issued and ends on the generic failure at the callback, without telling it from any other", async () => {
      const world = serve();
      const unknown = generateCredentialToken().value;
      const { callbackUrl, preAuth } = await approved(world, startUrl(unknown), { subject: "unknown-subject", email: "unknown@example.test", emailVerified: true });

      expectFailed(await callbackWith(world, callbackUrl, preAuth));

      expect(await accountRows()).toEqual([]);
      expect(await identityRows()).toEqual([]);
    });
  });

  describe("counts the redemption against the token_redeem limits", () => {
    it("per client address, for starts of the invite intent only", async () => {
      const world = serve(provider({ RATE_LIMIT_TOKEN_REDEEM_IP: "2/hour" }));
      const target = await invitation("limited@example.test");

      expect((await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: FROM_THE_APPLICATION }))).status).toBe(302);
      expect((await world.server.fetch(new Request(new URL(startUrl("not-a-token"), world.origin), { headers: FROM_THE_APPLICATION }))).status).toBe(302);
      const limited = await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: FROM_THE_APPLICATION }));

      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
      expect(limited.headers.get("ratelimit")).toContain("token_redeem");
      // A sign-in start is another bucket and is not affected.
      expect((await world.server.fetch(new Request(new URL(`${START}?returnTo=/`, world.origin)))).status).toBe(302);
      expect((await stateRecords()).filter((record) => record.intent === "invite")).toHaveLength(1);
    });

    it("per account as well, when the browser holds a complete session", async () => {
      const world = serve(provider({ RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "1/hour" }));
      const person = await verifiedAccount("signed-in@example.test");
      const login = await world.server.fetch(
        new Request(new URL("/api/v1/auth/login", world.origin), {
          method: "POST",
          headers: { "content-type": "application/json", origin: world.origin },
          body: JSON.stringify({ email: person.email, password: person.password, remember: false }),
        }),
      );
      const cookie = `${SESSION_COOKIE}=${issuedToken(login) ?? ""}`;
      const target = await invitation("account-limited@example.test");

      expect((await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: { cookie, ...FROM_THE_APPLICATION } }))).status).toBe(302);
      expect((await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: { cookie, ...FROM_THE_APPLICATION } }))).status).toBe(429);
      expect((await world.server.fetch(new Request(new URL(startUrl(target.token), world.origin), { headers: FROM_THE_APPLICATION }))).status).toBe(302);
    });

    it("answers 503 and stores nothing when the limiter cannot decide", async () => {
      const world = serve();
      const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()) });
      const broken = createServer({
        config,
        adapters: {
          ...adapters(config),
          rateLimit: { available: true, consume: () => Promise.reject(new Error("the limiter is down")) },
          tenantResolver: createAccountOnlyTenantResolver(),
          secretBox: testSecretBox(testKey("oidc-1")),
          identity: { available: true, listProviders: () => world.fake.listProviders(), begin: (request) => world.fake.begin(request), complete: (request) => world.fake.complete(request) },
        },
        modules: [],
        migrations: [],
        logger: recordingLogger(),
        database: tenantDatabase(database()),
        authStore: store,
      });
      const target = await invitation("down@example.test");

      const response = await broken.fetch(new Request(new URL(startUrl(target.token), config.APP_ORIGIN), { headers: FROM_THE_APPLICATION }));

      expect(response.status).toBe(503);
      expect(await stateRecords()).toEqual([]);
    });
  });
});
