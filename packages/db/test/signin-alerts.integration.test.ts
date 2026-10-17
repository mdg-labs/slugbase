import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountProfileRepository, createAuthStore, type AuthStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";

// The system operations behind the "new sign-in" email (doc 02 section 12, doc 05 section 3.3): what a
// sign-in may ask of the sessions of its account. The failure
// scenarios are a session that counts as a known device when it cannot be used any more (expired, older
// than the password change, only half signed in), another account's session counting as the account's, a
// sign-in alert asked for the very first session, and a session created without the job that announces it.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "probe.send";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const HOME = "203.0.0.0/16";
const AWAY = "198.51.0.0/16";

let db: TestDatabase;
let store: AuthStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: 4 });
  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes and reads.
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let counter = 0;
async function account(overrides: { disabledAt?: Date } = {}): Promise<string> {
  counter += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `alerts${String(counter)}@example.test`, passwordHash: "$argon2id$stub", ...overrides });
  return id;
}

async function signIn(accountId: string, ipPrefix: string | null, userAgent: string | null): Promise<string> {
  const id = freshId();
  expect(
    await store.createSession({ id, accountId, level: "full", remember: false, ipPrefix, userAgent, tokenHash: freshToken().hash, replacedTokenHash: null }),
  ).toBe(true);
  return id;
}

async function insertSession(
  accountId: string,
  { level = "full", ipPrefix = HOME, userAgent = FIREFOX, expired = false }: { level?: string; ipPrefix?: string | null; userAgent?: string | null; expired?: boolean } = {},
): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at, ip_prefix, user_agent)
      VALUES (${id}, ${freshToken().hash}, ${accountId}, ${level}, false,
              now() + ${expired ? "-1 hour" : "1 hour"}::interval, now() + ${expired ? "-1 hour" : "1 day"}::interval, ${ipPrefix}, ${userAgent})`,
  );
  return id;
}

function tenant<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "signin-alerts-test" }, work);
}

describe("the sign-in alert system operations", () => {
  const operations = ["sys_signin_alert_context"];

  it("are SECURITY DEFINER functions of slugbase_system with a pinned search_path, callable by slugbase_app only, and in the registry", async () => {
    const rows = await db.owner<{ name: string; definer: boolean; owner: string; config: string[]; app: boolean; public: boolean }[]>`
      SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (${operations})
      ORDER BY p.proname`;
    expect(rows.map((row) => row.name)).toEqual(operations);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ definer: true, owner: "slugbase_system", app: true, public: false });
      expect(row.config, row.name).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(systemOperations, row.name).toContain(row.name);
    }
  });
});

describe("signInAlertContext", () => {
  it("says the first session of an account is not a return: no earlier sign-in, no live session", async () => {
    const id = await account();
    expect(await store.signInAlertContext(id, HOME)).toEqual({ alertsOn: true, signedInBefore: false, userAgentsOnNetwork: [] });
  });

  it("lists the user agent of each live session created from the same prefix, once each", async () => {
    const id = await account();
    await signIn(id, HOME, FIREFOX);
    await signIn(id, HOME, FIREFOX);
    await signIn(id, HOME, CHROME);
    await signIn(id, AWAY, "Elsewhere/1.0");
    const context = await store.signInAlertContext(id, HOME);
    expect(context?.signedInBefore).toBe(true);
    expect([...(context?.userAgentsOnNetwork ?? [])].sort()).toEqual([CHROME, FIREFOX].sort());
    expect(await store.signInAlertContext(id, AWAY)).toMatchObject({ userAgentsOnNetwork: ["Elsewhere/1.0"] });
    expect(await store.signInAlertContext(id, "192.0.0.0/16")).toMatchObject({ signedInBefore: true, userAgentsOnNetwork: [] });
  });

  it("matches an unknown prefix with an unknown prefix and a missing user agent with null", async () => {
    const id = await account();
    await signIn(id, null, null);
    await signIn(id, HOME, FIREFOX);
    expect(await store.signInAlertContext(id, null)).toMatchObject({ userAgentsOnNetwork: [null] });
    expect(await store.signInAlertContext(id, HOME)).toMatchObject({ userAgentsOnNetwork: [FIREFOX] });
  });

  it("does not count a session that cannot be used any more, or is not fully signed in", async () => {
    const id = await account();
    await signIn(id, AWAY, FIREFOX);
    await insertSession(id, { expired: true, userAgent: "Expired/1.0" });
    await insertSession(id, { level: "partial", userAgent: "Partial/1.0" });
    expect(await store.signInAlertContext(id, HOME)).toMatchObject({ signedInBefore: true, userAgentsOnNetwork: [] });
  });

  it("does not count a session older than the account's password change", async () => {
    const id = await account();
    await insertSession(id, { userAgent: "Before/1.0" });
    expect(await store.signInAlertContext(id, HOME)).toMatchObject({ userAgentsOnNetwork: ["Before/1.0"] });
    await asSystem(db, (tx) => tx`UPDATE accounts SET password_changed_at = now() + interval '1 second' WHERE id = ${id}`);
    expect(await store.signInAlertContext(id, HOME)).toMatchObject({ userAgentsOnNetwork: [] });
  });

  it("never counts a session of another account", async () => {
    const mine = await account();
    const theirs = await account();
    await signIn(theirs, HOME, FIREFOX);
    expect(await store.signInAlertContext(mine, HOME)).toEqual({ alertsOn: true, signedInBefore: false, userAgentsOnNetwork: [] });
  });

  it("reports the account's switch", async () => {
    const id = await account();
    await tenant(id, (tx) => accountProfileRepository(tx).updateProfile({ signinAlerts: false }));
    expect((await store.signInAlertContext(id, HOME))?.alertsOn).toBe(false);
  });

  it("answers nothing for an account that does not exist or is disabled", async () => {
    expect(await store.signInAlertContext(freshId(), HOME)).toBeUndefined();
    expect(await store.signInAlertContext(await account({ disabledAt: new Date() }), HOME)).toBeUndefined();
  });
});

describe("createSession and its jobs", () => {
  interface JobRow {
    id: string;
    name: string;
    data: Record<string, unknown>;
  }

  async function sessionExists(id: string): Promise<boolean> {
    return (await asSystem(db, (tx) => tx`SELECT 1 FROM sessions WHERE id = ${id}`)).length === 1;
  }

  async function queued(ids: readonly string[]): Promise<JobRow[]> {
    return db.app<JobRow[]>`SELECT id, name, data FROM pgboss.job WHERE id IN ${db.app(ids)} ORDER BY id`;
  }

  function session(accountId: string, jobs: readonly { id: string; queue: string; data: Record<string, string> }[]) {
    return { id: freshId(), accountId, level: "full" as const, remember: false, ipPrefix: HOME, userAgent: FIREFOX, tokenHash: freshToken().hash, replacedTokenHash: null, jobs };
  }

  it("queues the jobs in the transaction that creates the session", async () => {
    const accountId = await account();
    const job = { id: freshId(), queue: QUEUE, data: { template: "probe" } };
    const created = session(accountId, [job]);
    expect(await store.createSession(created)).toBe(true);
    expect(await sessionExists(created.id)).toBe(true);
    expect(await queued([job.id])).toEqual([{ id: job.id, name: QUEUE, data: { template: "probe" } }]);
  });

  it("creates no session when a job cannot be queued, and rejects", async () => {
    const accountId = await account();
    const good = { id: freshId(), queue: QUEUE, data: { template: "probe" } };
    const created = session(accountId, [good, { id: freshId(), queue: "probe.missing", data: { template: "probe" } }]);
    await expect(store.createSession(created)).rejects.toThrow("probe.missing");
    expect(await sessionExists(created.id)).toBe(false);
    expect(await queued([good.id])).toEqual([]);
    expect((await store.signInAlertContext(accountId, HOME))?.signedInBefore).toBe(false);
  });

  it("queues nothing for a session that was not created", async () => {
    const accountId = await account({ disabledAt: new Date() });
    const job = { id: freshId(), queue: QUEUE, data: { template: "probe" } };
    expect(await store.createSession(session(accountId, [job]))).toBe(false);
    expect(await queued([job.id])).toEqual([]);
  });
});
