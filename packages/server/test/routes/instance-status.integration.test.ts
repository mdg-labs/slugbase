import { unconfigured, type Adapters, type IdentityPort } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer } from "../../src/create-server.ts";
import { seedAccount, sessionRows } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { HOOK_TIMEOUT_MS, SESSION_COOKIE, bearer, send, workspaceHarness, type World } from "../workspaces/support.ts";

// GET /api/v1/instance/status through the whole chain over the migrated database (doc 04 section 10.10, doc 02
// section 11.3, doc 10 T3 and T15). The failure scenarios: a caller the instanceAdmin policy excludes that is
// answered the status (an API token, a session waiting for its second factor, an account without the flag, an
// admin without a second factor), a status that leaks a credential, and a viewed status that leaves no event in
// the instance audit stream.

const STATUS = "/api/v1/instance/status";
const LOGIN = "/api/v1/auth/login";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

interface Body {
  readonly version: string;
  readonly migrations: { expected: number; applied: number };
  readonly ports: { mail: boolean; ai: boolean; errorReporting: boolean };
  readonly oidcProviders: readonly { slug: string; name: string }[];
  readonly signIn: { publicRegistration: boolean; emailVerificationRequired: boolean };
  readonly counts: { accounts: number; workspaces: number; activeSessions: number };
  readonly jobs: { queueDepth: number; failed: number };
}

const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

interface CallerOptions {
  /** The account holds the instance-admin flag. */
  readonly flag: boolean;
  /** The account has a second factor enrolled. */
  readonly mfa: boolean;
  /** The account signs in after the factor is enrolled, so its session is the pending one; otherwise the factor is enrolled after the full session exists. */
  readonly partial?: boolean;
}

interface Caller {
  readonly accountId: string;
  readonly cookie: string;
}

async function enrolSecondFactor(accountId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${accountId}`;
  });
}

async function caller(world: World, options: CallerOptions): Promise<Caller> {
  const account = await seedAccount(database(), { emailVerified: true, instanceAdmin: options.flag });
  if (options.mfa && options.partial === true) {
    await enrolSecondFactor(account.id);
  }
  const response = await send(world, "POST", LOGIN, {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  if (options.mfa && options.partial !== true) {
    await enrolSecondFactor(account.id);
  }
  return { accountId: account.id, cookie: `${SESSION_COOKIE}=${token}` };
}

interface EventRow {
  actor_account_id: string | null;
  action: string;
}

async function instanceEvents(): Promise<EventRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`SELECT actor_account_id, action FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`;
  });
  return [...rows];
}

async function reset(): Promise<void> {
  await database().owner`TRUNCATE pgboss.job`;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM audit_events WHERE workspace_id IS NULL`;
  });
}

beforeEach(reset);

describe("GET /instance/status", () => {
  it("answers an instance admin with a second factor on a complete session, and writes the instance audit event of the view", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });

    const response = await send(world, "GET", STATUS, { cookie: admin.cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(Object.keys(body).sort()).toEqual(["counts", "jobs", "migrations", "oidcProviders", "ports", "signIn", "version"]);
    expect(body.version).toBe("0.0.0-development");
    expect(body.migrations.expected).toBeGreaterThan(0);
    expect(body.migrations.applied).toBe(body.migrations.expected);
    expect(body.counts.accounts).toBeGreaterThanOrEqual(1);
    expect(body.counts.activeSessions).toBeGreaterThanOrEqual(1);
    expect(await instanceEvents()).toEqual([{ actor_account_id: admin.accountId, action: "instance.status_viewed" }]);
  });

  it("reports which ports are configured, the OIDC providers by slug and name, and the registration settings in force", async () => {
    const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "true" });
    const identity: IdentityPort = {
      available: true,
      listProviders: () => Promise.resolve([{ id: "idp", displayName: "Example IdP" }]),
      begin: () => Promise.reject(new Error("not used")),
      complete: () => Promise.reject(new Error("not used")),
    };
    const configured: Adapters = {
      ...adapters(config),
      tenantResolver: createAccountOnlyTenantResolver(),
      identity,
      mail: { ...unconfigured().mail, available: true },
    };
    const world = { server: createServer({ config, adapters: configured, modules: [], migrations: [], logger: recordingLogger(), database: tenantDatabase(database()) }), origin: config.APP_ORIGIN };
    const admin = await caller(world, { flag: true, mfa: true });

    const body = (await (await send(world, "GET", STATUS, { cookie: admin.cookie })).json()) as Body;

    expect(body.ports).toEqual({ mail: true, ai: false, errorReporting: false });
    expect(body.oidcProviders).toEqual([{ slug: "idp", name: "Example IdP" }]);
    expect(body.signIn).toEqual({ publicRegistration: true, emailVerificationRequired: true });
  });

  it("counts the queue and the failed jobs of the background worker", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });
    const insertJob = async (state: string, startAfter: string): Promise<void> => {
      await database().owner`
        INSERT INTO pgboss.job (id, name, data, state, start_after, keep_until, expire_seconds, deletion_seconds, retry_limit, retry_delay, retry_backoff, retry_delay_max, policy, dead_letter, heartbeat_seconds)
        SELECT gen_random_uuid(), q.name, '{}'::jsonb, ${state}::pgboss.job_state, ${startAfter}::timestamptz, now() + interval '1 day', q.expire_seconds, q.deletion_seconds,
               q.retry_limit, q.retry_delay, q.retry_backoff, q.retry_delay_max, q.policy, q.dead_letter, q.heartbeat_seconds
        FROM pgboss.queue q WHERE q.name = 'invitation.send'`;
    };
    for (const [state, startAfter] of [
      ["created", "2020-01-01"],
      ["retry", "2020-01-01"],
      ["created", "2999-01-01"],
      ["active", "2020-01-01"],
      ["completed", "2020-01-01"],
      ["failed", "2020-01-01"],
      ["failed", "2020-01-01"],
    ] as const) {
      await insertJob(state, startAfter);
    }

    const body = (await (await send(world, "GET", STATUS, { cookie: admin.cookie })).json()) as Body;

    expect(body.jobs).toEqual({ queueDepth: 2, failed: 2 });
  });

  it("returns no credential, URL with credentials or secret", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });

    const text = await (await send(world, "GET", STATUS, { cookie: admin.cookie })).text();

    for (const forbidden of ["postgres://", "slugbase_app_dev_only", "SESSION_SECRET", serverConfig().SESSION_SECRET, "password", "secret", "token"]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  describe("refuses everyone the instanceAdmin policy excludes, writing no event and counting nothing", () => {
    it("answers 401 unauthenticated without a credential", async () => {
      const world = harness.serve();
      const response = await send(world, "GET", STATUS, {});
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("unauthenticated");
      expect(await instanceEvents()).toEqual([]);
    });

    it("answers 401 mfa_required to a session still waiting for its second factor, even of an admin", async () => {
      const world = harness.serve();
      const pending = await caller(world, { flag: true, mfa: true, partial: true });
      const sessions = await sessionRows(database(), pending.accountId);
      expect(sessions.map((session) => session.level)).toEqual(["partial"]);

      const response = await send(world, "GET", STATUS, { cookie: pending.cookie });

      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("mfa_required");
      expect(await instanceEvents()).toEqual([]);
    });

    it("answers 403 forbidden to an API token, even of an admin with a second factor", async () => {
      const world = harness.serve();
      const admin = await harness.person(world);
      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${admin.account.id}, true)`;
        await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${admin.account.id}`;
      });
      await enrolSecondFactor(admin.account.id);
      const { workspaceId } = await harness.workspaceOf([{ person: admin, role: "owner" }]);
      const value = await harness.token(workspaceId, admin, "read-write");

      const response = await send(world, "GET", STATUS, bearer(value));

      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("forbidden");
      expect(await instanceEvents()).toEqual([]);
    });

    it("answers 403 forbidden to an account that holds no flag, even with a second factor", async () => {
      const world = harness.serve();
      const member = await caller(world, { flag: false, mfa: true });
      const response = await send(world, "GET", STATUS, { cookie: member.cookie });
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("forbidden");
      expect(await instanceEvents()).toEqual([]);
    });

    it("answers 403 forbidden to an instance admin who has no second factor enrolled", async () => {
      const world = harness.serve();
      const admin = await caller(world, { flag: true, mfa: false });
      const response = await send(world, "GET", STATUS, { cookie: admin.cookie });
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("forbidden");
      expect(await instanceEvents()).toEqual([]);
    });

    it("answers 403 forbidden to everyone on a deployment where no account holds the flag", async () => {
      const world = harness.serve();
      const withFactor = await caller(world, { flag: false, mfa: true });
      const without = await caller(world, { flag: false, mfa: false });
      for (const { cookie } of [withFactor, without]) {
        expect((await send(world, "GET", STATUS, { cookie })).status).toBe(403);
      }
    });

    it("lets an admin whose second factor was removed after sign-in no further: the factor is read on every request", async () => {
      const world = harness.serve();
      const admin = await caller(world, { flag: true, mfa: true });
      expect((await send(world, "GET", STATUS, { cookie: admin.cookie })).status).toBe(200);

      await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${admin.accountId}, true)`;
        await tx`UPDATE accounts SET mfa_enabled_at = NULL, mfa_secret = NULL, mfa_secret_key_id = NULL WHERE id = ${admin.accountId}`;
      });

      expect((await send(world, "GET", STATUS, { cookie: admin.cookie })).status).toBe(403);
    });
  });

  it("rejects a write method on the path", async () => {
    const world = harness.serve();
    const admin = await caller(world, { flag: true, mfa: true });
    expect((await send(world, "POST", STATUS, { cookie: admin.cookie }, {})).status).toBe(404);
  });
});
