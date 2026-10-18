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
import { issuedToken, seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// The first OIDC login of an identity nobody has linked, through the whole callback over the migrated database
// (doc 02 sections 2.2, 2.3 and 2.8, doc 01 section 13.5, doc 10 T17 and T20). The provider is a FakeIdentity.
// The failure scenarios (T20, Q32): a provider that asserts an address it has not verified gets no session, no
// link and no account; an address that somebody registered and nobody verified is not linked to a verified
// address at a provider; a provider the operator did not configure links nothing; an account is created only for
// a provider that has AUTO_CREATE on, for an address its ALLOWED_DOMAINS allow and the registration policy
// accepts, and every refusal ends on the same generic failure as any other.

const SESSION_COOKIE = "__Host-slugbase_session";
const PREAUTH_COOKIE = "__Host-slugbase_oidc";
const ISSUER = "https://idp.example.test";
const START = "/api/v1/auth/oidc/idp/start";
const FAILED = "/login?error=oidc_failed";
const HOOK_TIMEOUT_MS = 120_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The account.created event is queued in the transaction that creates the account, so the queues exist, as they do
  // once the image entrypoint has run migrate.
  await runMigrations({ url: urlOf(database().owner) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  await database().owner`DELETE FROM pgboss.job WHERE name IN ('event.account.created', 'event.workspace.created')`;
  await database().owner`TRUNCATE accounts, workspaces CASCADE`;
});

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly fake: FakeIdentity;
  readonly logs: ReturnType<typeof recordingLogger>;
}

/** A provider configured by the operator with the given keys; auto-create is off unless a test turns it on. */
function provider(keys: Record<string, string> = {}): Record<string, string> {
  return {
    OIDC_IDP_CLIENT_ID: "client-id-1",
    OIDC_IDP_CLIENT_SECRET: "a-client-secret",
    OIDC_IDP_ISSUER_URL: ISSUER,
    ...keys,
  };
}

function serve(env: Record<string, string> = provider(), modules: readonly ServerModule[] = []): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
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
      secretBox: testSecretBox(testKey("oidc-1")),
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

/** Runs a first login to its callback: starts the handshake, plays the person approving it, and follows the redirect. */
async function login(world: World, grant: FakeIdentityGrant, headers: Record<string, string> = {}): Promise<Response> {
  const started = await world.server.fetch(new Request(new URL(`${START}?returnTo=/go/docs`, world.origin)));
  const authorizationUrl = started.headers.get("location") ?? "";
  const preAuth = cookieValue(started, PREAUTH_COOKIE);
  if (started.status !== 302 || preAuth === undefined) {
    throw new Error(`the handshake did not start: ${String(started.status)}`);
  }
  const callbackUrl = world.fake.approve(authorizationUrl, grant);
  const request = new Headers(headers);
  request.set("cookie", `${PREAUTH_COOKIE}=${preAuth}`);
  return world.server.fetch(new Request(callbackUrl, { headers: request }));
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  locale: string;
  verified: boolean;
  is_instance_admin: boolean;
}

async function accountRows(): Promise<AccountRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`
      SELECT id, email, display_name, password_hash, locale, email_verified_at IS NOT NULL AS verified, is_instance_admin
      FROM accounts ORDER BY created_at, id`;
  });
  return [...rows];
}

interface IdentityRow {
  account_id: string;
  provider: string;
  subject: string;
  email_at_link: string;
}

async function identityRows(): Promise<IdentityRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<IdentityRow[]>`SELECT account_id, provider, subject, email_at_link FROM account_identities ORDER BY created_at, id`;
  });
  return [...rows];
}

async function workspaceCountOf(accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: string }[]>`SELECT count(*)::text AS n FROM workspace_members WHERE account_id = ${accountId} AND role = 'owner'`;
  });
  return Number(rows[0]?.n);
}

async function eventsQueued(): Promise<{ accountId: unknown; path: unknown }[]> {
  const rows = await database().owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = 'event.account.created' ORDER BY id`;
  return rows.map((row) => ({ accountId: row.data["accountId"], path: row.data["path"] }));
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

async function verifiedAccount(email: string, options: { verified?: boolean; disabled?: boolean; password?: string | null } = {}): Promise<SeededAccount> {
  return seedAccount(database(), { email, emailVerified: options.verified ?? true, disabled: options.disabled ?? false, ...(options.password === undefined ? {} : { password: options.password }) });
}

function refusing(seen: { email: string; path: string }[]): ServerModule {
  return {
    name: "policy",
    hooks: {
      registrationPolicy: (input) => {
        seen.push({ email: input.email, path: input.path });
        return HookResult.refuse("blocked_domain");
      },
    },
    register: () => ({}),
  };
}

describe("a first login by verified email", () => {
  it("links the identity to the account that holds the address, records the address asserted, and signs in with a full session", async () => {
    const world = serve();
    const holder = await verifiedAccount("Holder@Example.test");

    const response = await login(world, { subject: "new-subject", email: "holder@example.test", emailVerified: true }, { "user-agent": "first login agent" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/go/docs");
    const token = issuedToken(response);
    expect(token).toBeDefined();
    expect(await identityRows()).toEqual([{ account_id: holder.id, provider: "idp", subject: "new-subject", email_at_link: "holder@example.test" }]);
    const sessions = await sessionRows(database(), holder.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ level: "full", user_agent: "first login agent" });
    expect((await world.server.fetch(new Request(new URL("/api/v1/me/sessions", world.origin), { headers: { cookie: `${SESSION_COOKIE}=${token ?? ""}` } }))).status).toBe(200);
    expect(await accountRows()).toHaveLength(1);
  });

  it("asks for no SlugBase code: an account with a second factor gets a full session", async () => {
    const world = serve();
    const holder = await verifiedAccount("mfa-holder@example.test");
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.alloc(40, 3)}, mfa_secret_key_id = 'oidc-1', mfa_enabled_at = now() WHERE id = ${holder.id}`;
    });

    const response = await login(world, { subject: "mfa-subject", email: holder.email, emailVerified: true });

    expect(response.headers.get("location")).toBe("/go/docs");
    expect((await sessionRows(database(), holder.id)).map((row) => row.level)).toEqual(["full"]);
  });

  it("signs the next login in through the link alone, whatever the provider asserts about the address then", async () => {
    const world = serve();
    const holder = await verifiedAccount("again@example.test");
    expect((await login(world, { subject: "again-subject", email: holder.email, emailVerified: true })).headers.get("location")).toBe("/go/docs");

    const second = await login(world, { subject: "again-subject", email: "changed@example.test", emailVerified: false });

    expect(second.headers.get("location")).toBe("/go/docs");
    expect(await identityRows()).toHaveLength(1);
    expect(await sessionRows(database(), holder.id)).toHaveLength(2);
  });

  it("links an existing account without asking the registration policy: linking is not registering", async () => {
    const seen: { email: string; path: string }[] = [];
    const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }), [refusing(seen)]);
    const holder = await verifiedAccount("policy-holder@example.test");

    const response = await login(world, { subject: "policy-subject", email: holder.email, emailVerified: true });

    expect(response.headers.get("location")).toBe("/go/docs");
    expect(seen).toEqual([]);
    expect(await identityRows()).toHaveLength(1);
    expect(await accountRows()).toHaveLength(1);
  });

  describe("ends without a link, an account or a session, on /login with the one generic failure code", () => {
    it.each<[string, Partial<FakeIdentityGrant>]>([
      ["an address the provider did not verify", { emailVerified: false }],
      ["an address with no verification claim at all", {}],
    ])("for %s, even when it is the address of a verified account", async (_name, claims) => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));
      const victim = await verifiedAccount("victim@example.test");

      expectFailed(await login(world, { subject: "attacker-subject", email: victim.email, ...claims }));

      expect(await identityRows()).toEqual([]);
      expect(await sessionRows(database(), victim.id)).toEqual([]);
      expect(await accountRows()).toHaveLength(1);
      expect(world.logs.entries.at(-1)).toMatchObject({ fields: { provider: "idp", reason: "unverified_email" } });
    });

    it("for a provider that asserts no address", async () => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));
      expectFailed(await login(world, { subject: "no-address", emailVerified: true }));
      expect(await accountRows()).toEqual([]);
      expect(await identityRows()).toEqual([]);
    });

    it("for an address that somebody registered and nobody verified: a verified address at the provider does not reach it", async () => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));
      const registered = await verifiedAccount("registered-first@example.test", { verified: false });

      expectFailed(await login(world, { subject: "owner-subject", email: registered.email, emailVerified: true }));

      expect(await identityRows()).toEqual([]);
      expect(await sessionRows(database(), registered.id)).toEqual([]);
      expect(await accountRows()).toHaveLength(1);
    });

    it("for a disabled account", async () => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));
      const disabled = await verifiedAccount("disabled@example.test", { disabled: true });

      expectFailed(await login(world, { subject: "disabled-subject", email: disabled.email, emailVerified: true }));

      expect(await identityRows()).toEqual([]);
      expect(await accountRows()).toHaveLength(1);
    });

    it("for an identity another account already holds, whichever address it asserts", async () => {
      const world = serve();
      const other = await verifiedAccount("other-holder@example.test");
      const holder = await verifiedAccount("wants-it@example.test");
      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${other.id}, true)`;
        await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${other.id}`;
        await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES ('0192f3a0-dddd-7000-8000-00000000f001', ${other.id}, 'idp', 'held-subject', ${other.email})`;
      });

      expectFailed(await login(world, { subject: "held-subject", email: holder.email, emailVerified: true }));

      expect((await identityRows()).map((row) => row.account_id)).toEqual([other.id]);
      expect(await sessionRows(database(), holder.id)).toEqual([]);
    });

    it("for a provider the operator did not configure: no handshake starts and nothing is linked", async () => {
      const world = serve();
      const victim = await verifiedAccount("configured-only@example.test");

      const started = await world.server.fetch(new Request(new URL("/api/v1/auth/oidc/rogue/start", world.origin)));
      expectFailed(started);

      const forged = await world.server.fetch(new Request(new URL(`/api/v1/auth/oidc/rogue/callback?code=x&state=${"A".repeat(43)}`, world.origin), { headers: { cookie: `${PREAUTH_COOKIE}=${"A".repeat(43)}` } }));
      expectFailed(forged);
      expect(await identityRows()).toEqual([]);
      expect(await sessionRows(database(), victim.id)).toEqual([]);
    });
  });
});

describe("a first login that creates an account", () => {
  it("is refused when the provider has auto-create off, which is the default", async () => {
    const world = serve();

    expectFailed(await login(world, { subject: "off-subject", email: "newcomer@example.test", emailVerified: true }));

    expect(await accountRows()).toEqual([]);
    expect(await identityRows()).toEqual([]);
    expect(await eventsQueued()).toEqual([]);
  });

  it("is refused for an address the provider did not verify, with auto-create on", async () => {
    const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));

    expectFailed(await login(world, { subject: "unverified-subject", email: "newcomer@example.test", emailVerified: false }));

    expect(await accountRows()).toEqual([]);
  });

  it("creates a verified account without a password and signs it in, with a personal workspace and the account.created event when public registration is on", async () => {
    const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", PUBLIC_REGISTRATION: "true" }));

    const response = await login(world, { subject: "created-subject", email: "Newcomer@Example.test", emailVerified: true, displayName: "Ada Lovelace" }, { "accept-language": "de-DE,de;q=0.9" });

    expect(response.headers.get("location")).toBe("/go/docs");
    const token = issuedToken(response);
    expect(token).toBeDefined();
    const accounts = await accountRows();
    expect(accounts).toHaveLength(1);
    const created = accounts[0];
    expect(created).toMatchObject({ email: "Newcomer@Example.test", display_name: "Ada Lovelace", password_hash: null, locale: "de", verified: true, is_instance_admin: false });
    const accountId = created?.id ?? "";
    expect(await identityRows()).toEqual([{ account_id: accountId, provider: "idp", subject: "created-subject", email_at_link: "Newcomer@Example.test" }]);
    expect((await sessionRows(database(), accountId)).map((row) => row.level)).toEqual(["full"]);
    expect(await workspaceCountOf(accountId)).toBe(1);
    expect(await eventsQueued()).toEqual([{ accountId, path: "oidc" }]);
    expect((await world.server.fetch(new Request(new URL("/api/v1/me/sessions", world.origin), { headers: { cookie: `${SESSION_COOKIE}=${token ?? ""}` } }))).status).toBe(200);
  });

  it("creates the account without a workspace when public registration is off: it waits to be invited", async () => {
    const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", PUBLIC_REGISTRATION: "false" }));

    const response = await login(world, { subject: "invited-later", email: "waiting@example.test", emailVerified: true });

    expect(response.headers.get("location")).toBe("/go/docs");
    const accountId = (await accountRows())[0]?.id ?? "";
    expect(await workspaceCountOf(accountId)).toBe(0);
    expect(await eventsQueued()).toEqual([{ accountId, path: "oidc" }]);
    expect(await sessionRows(database(), accountId)).toHaveLength(1);
  });

  it("names the account after the address when the provider sends no name", async () => {
    const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }));
    await login(world, { subject: "nameless", email: "nameless.person@example.test", emailVerified: true });
    expect((await accountRows())[0]).toMatchObject({ display_name: "nameless.person", locale: "en" });
  });

  describe("honours ALLOWED_DOMAINS", () => {
    it("creates for a listed domain, whatever case the address is in", async () => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", OIDC_IDP_ALLOWED_DOMAINS: "other.test, example.test" }));
      expect((await login(world, { subject: "listed", email: "Person@EXAMPLE.test", emailVerified: true })).headers.get("location")).toBe("/go/docs");
      expect(await accountRows()).toHaveLength(1);
    });

    it.each(["person@outside.test", "person@sub.example.test", "person@example.test.evil.test"])("refuses %s, creating nothing", async (email) => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", OIDC_IDP_ALLOWED_DOMAINS: "example.test" }));

      expectFailed(await login(world, { subject: "unlisted", email, emailVerified: true }));

      expect(await accountRows()).toEqual([]);
      expect(await identityRows()).toEqual([]);
      expect(await eventsQueued()).toEqual([]);
    });

    it("does not stop a verified address at an unlisted domain from linking to the account that holds it", async () => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", OIDC_IDP_ALLOWED_DOMAINS: "example.test" }));
      const holder = await verifiedAccount("member@elsewhere.test");

      expect((await login(world, { subject: "linked-elsewhere", email: holder.email, emailVerified: true })).headers.get("location")).toBe("/go/docs");
      expect(await identityRows()).toHaveLength(1);
    });
  });

  describe("consults the registration policy through the shared gate with the oidc path", () => {
    it("asks it with the normalised address before anything is written, and a refusal ends in the generic failure", async () => {
      const seen: { email: string; path: string }[] = [];
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", PUBLIC_REGISTRATION: "true" }), [refusing(seen)]);

      const refused = await login(world, { subject: "refused-subject", email: "Blocked@Example.test", emailVerified: true });
      const other = await login(world, { subject: "other-subject" });

      expectFailed(refused);
      expect(seen).toEqual([{ email: "Blocked@Example.test", path: "oidc" }]);
      expect(await accountRows()).toEqual([]);
      expect(await identityRows()).toEqual([]);
      expect(await eventsQueued()).toEqual([]);
      expect(await sessionsOfEveryone()).toBe(0);
      expect(refused.headers.getSetCookie().map((header) => header.split("=")[0])).toEqual(other.headers.getSetCookie().map((header) => header.split("=")[0]));
      expect(await refused.text()).toBe(await other.text());
    });

    it("answers 503 and creates nothing when a hook fails", async () => {
      const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true" }), [
        {
          name: "broken-policy",
          hooks: {
            registrationPolicy: () => {
              throw new Error("the policy service is down");
            },
          },
          register: () => ({}),
        },
      ]);

      const response = await login(world, { subject: "hook-subject", email: "newcomer@example.test", emailVerified: true });

      expect(response.status).toBe(503);
      expect(cookieValue(response, SESSION_COOKIE)).toBeUndefined();
      expect(await accountRows()).toEqual([]);
      expect(await identityRows()).toEqual([]);
    });

    it("is not asked when the provider does not create accounts, or the address is outside its domains", async () => {
      const seen: { email: string; path: string }[] = [];
      const off = serve(provider(), [refusing(seen)]);
      expectFailed(await login(off, { subject: "no-gate-1", email: "newcomer@example.test", emailVerified: true }));
      const outside = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", OIDC_IDP_ALLOWED_DOMAINS: "other.test" }), [refusing(seen)]);
      expectFailed(await login(outside, { subject: "no-gate-2", email: "newcomer@example.test", emailVerified: true }));
      expect(seen).toEqual([]);
    });
  });

  it("creates the account once when two callbacks for the same new identity arrive together", async () => {
    const world = serve(provider({ OIDC_IDP_AUTO_CREATE: "true", PUBLIC_REGISTRATION: "true" }));

    const responses = await Promise.all([
      login(world, { subject: "twice-subject", email: "twice@example.test", emailVerified: true }),
      login(world, { subject: "twice-subject", email: "twice@example.test", emailVerified: true }),
    ]);

    expect(await accountRows()).toHaveLength(1);
    expect(await identityRows()).toHaveLength(1);
    expect(await eventsQueued()).toHaveLength(1);
    expect(responses.filter((response) => response.headers.get("location") === "/go/docs").length).toBeGreaterThanOrEqual(1);
  });
});
