import type { AuditRecord } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type CompleteSetup } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows, sha256 } from "./support/auth-fixture.ts";

// First-run setup (doc 05 sections 2.2 and 3.3, doc 02 section 2.2, doc 10
// section 2.1 and T8): instance_state and workspace_settings, and the system
// operations that create the first account exactly once. The failure scenario
// is the setup lock: after setup, or with several calls at once, a second
// account must not appear.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;

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
  store = createAuthStore({ url: appUrl(db), poolSize: PARALLEL_CALLS });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

// Every test starts on an instance that has never been set up.
beforeEach(async () => {
  await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
});

/**
 * Deletes every account the way the owner can: one own row at a time, as the policy of `accounts` allows. The workspaces go first, with
 * their memberships: an account that is the only owner of a workspace that stays cannot be deleted (the workspace would have no owner).
 */
async function deleteAccounts(): Promise<void> {
  await asSystem(db, (tx) => tx`DELETE FROM workspaces`);
  const ids = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts`);
  for (const { id } of ids) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`DELETE FROM accounts WHERE id = ${id}`;
    });
  }
}

let emailNumber = 0;

function request(overrides: Partial<CompleteSetup> = {}): CompleteSetup {
  emailNumber += 1;
  return {
    accountId: freshId(),
    workspaceId: freshId(),
    sessionId: freshId(),
    email: `Admin${String(emailNumber)}@Example.test`,
    displayName: "First Admin",
    passwordHash: "$argon2id$stub",
    locale: "en",
    workspaceName: "First workspace",
    tokenRequired: false,
    tokenHash: null,
    sessionTokenHash: freshToken().hash,
    ipPrefix: "203.0.0.0/16",
    userAgent: "Vitest",
    instanceEventId: freshId(),
    ...overrides,
  };
}

interface Counts {
  accounts: number;
  workspaces: number;
  members: number;
  settings: number;
  sessions: number;
  completed: number;
  tokenHashes: number;
}

async function counts(): Promise<Counts> {
  const rows = await asSystem(
    db,
    (tx) => tx<Counts[]>`
      SELECT (SELECT count(*) FROM accounts)::int AS accounts,
             (SELECT count(*) FROM workspaces)::int AS workspaces,
             (SELECT count(*) FROM workspace_members)::int AS members,
             (SELECT count(*) FROM workspace_settings)::int AS settings,
             (SELECT count(*) FROM sessions)::int AS sessions,
             (SELECT count(*) FROM instance_state WHERE setup_completed_at IS NOT NULL)::int AS completed,
             (SELECT count(*) FROM instance_state WHERE setup_token_hash IS NOT NULL)::int AS "tokenHashes"`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the count query returned no row");
  }
  return row;
}

const NOTHING: Counts = { accounts: 0, workspaces: 0, members: 0, settings: 0, sessions: 0, completed: 0, tokenHashes: 0 };

describe("the setup tables", () => {
  it("have the columns of doc 05 section 2.2", async () => {
    const columns = async (table: string) => {
      const rows = await db.owner<{ name: string; type: string; nullable: boolean; fallback: string | null }[]>`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS fallback
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ${`public.${table}`}::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`;
      return rows.map((row) => `${row.name} ${row.type}${row.nullable ? "" : " NOT NULL"}${row.fallback === null ? "" : ` DEFAULT ${row.fallback}`}`);
    };
    expect(await columns("instance_state")).toEqual([
      "id smallint NOT NULL",
      "setup_completed_at timestamp with time zone",
      "setup_by uuid",
      "setup_token_hash bytea",
    ]);
    expect(await columns("workspace_settings")).toEqual([
      "workspace_id uuid NOT NULL",
      "ai_enabled boolean NOT NULL DEFAULT true",
      "updated_at timestamp with time zone NOT NULL DEFAULT now()",
      "updated_by uuid",
    ]);
  });

  it("allow instance_state one row, with id 1 and a 32-byte token hash", async () => {
    await asSystem(db, (tx) => tx`INSERT INTO instance_state (id) VALUES (1)`);
    await expect(asSystem(db, (tx) => tx`INSERT INTO instance_state (id) VALUES (1)`)).rejects.toMatchObject({ code: "23505" });
    await expect(asSystem(db, (tx) => tx`INSERT INTO instance_state (id) VALUES (2)`)).rejects.toMatchObject({ code: "23514" });
    await expect(asSystem(db, (tx) => tx`UPDATE instance_state SET setup_token_hash = ${Buffer.alloc(8)}`)).rejects.toMatchObject({ code: "23514" });
  });

  it("keep instance_state away from the application role, which reaches it through the functions only", async () => {
    const privileges = await db.owner<{ privilege: string }[]>`
      SELECT p AS privilege FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      WHERE has_table_privilege('slugbase_app', 'public.instance_state', p)`;
    expect([...privileges]).toEqual([]);
    await expect(db.app`SELECT * FROM instance_state`).rejects.toMatchObject({ code: "42501" });
  });

  it("give workspace_settings forced row-level security, a read for the application role, a write of the setting columns alone and an updated_at trigger", async () => {
    const [security] = await db.owner<{ enabled: boolean; forced: boolean; policies: string[] }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT array_agg(p.polname ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.workspace_settings'::regclass`;
    expect(security).toEqual({ enabled: true, forced: true, policies: ["workspace_settings_tenant", "workspace_settings_tenant_update"] });
    const privileges = await db.owner<{ privilege: string }[]>`
      SELECT p AS privilege FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      WHERE has_table_privilege('slugbase_app', 'public.workspace_settings', p)`;
    expect(privileges.map((row) => row.privilege)).toEqual(["SELECT"]);
    const triggers = await db.owner<{ name: string }[]>`
      SELECT t.tgname AS name FROM pg_trigger t WHERE t.tgrelid = 'public.workspace_settings'::regclass AND NOT t.tgisinternal`;
    expect(triggers.map((row) => row.name)).toEqual(["workspace_settings_set_updated_at"]);
  });

  it("show a workspace's settings to that workspace only, and delete them with the workspace", async () => {
    const [a, b] = [freshId(), freshId()];
    const admin = freshId();
    await seedAccount(db, { id: admin, email: "settings@example.test", passwordHash: "$argon2id$stub" });
    await asSystem(db, async (tx) => {
      await tx`INSERT INTO workspaces (id, name) VALUES (${a}, 'A'), (${b}, 'B')`;
      await tx`INSERT INTO workspace_settings (workspace_id, ai_enabled) VALUES (${a}, true), (${b}, false)`;
    });
    const seen = async (workspaceId: string | null) => {
      const rows = await db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${admin}, true), set_config('app.workspace_id', ${workspaceId ?? ""}, true)`;
        return tx<{ workspace_id: string }[]>`SELECT workspace_id FROM workspace_settings ORDER BY workspace_id`;
      });
      return rows.map((row) => row.workspace_id);
    };
    expect(await seen(a)).toEqual([a]);
    expect(await seen(b)).toEqual([b]);
    expect(await seen(null)).toEqual([]);
    await asSystem(db, (tx) => tx`DELETE FROM workspaces WHERE id = ${a}`);
    expect((await counts()).settings).toBe(1);
  });
});

describe("sys_create_account", () => {
  it("is a registered system operation", () => {
    expect(systemOperations).toContain("sys_create_account");
  });

  it("creates the account and answers false, creating nothing, for an email that is taken in any case", async () => {
    const first = freshId();
    const created = await db.app`
      SELECT sys_create_account(${first}::uuid, 'Taken@Example.test', 'First', '$argon2id$stub', 'en', false) AS created`;
    expect(created[0]?.created).toBe(true);
    const again = await db.app`
      SELECT sys_create_account(${freshId()}::uuid, 'taken@example.TEST', 'Second', '$argon2id$stub', 'de', true) AS created`;
    expect(again[0]?.created).toBe(false);
    const rows = await asSystem(
      db,
      (tx) => tx<{ id: string; verified: boolean; admin: boolean; name: string }[]>`
        SELECT id, email_verified_at IS NOT NULL AS verified, is_instance_admin AS admin, display_name AS name FROM accounts`,
    );
    expect([...rows]).toEqual([{ id: first, verified: false, admin: false, name: "First" }]);
  });

  it("verifies the email when asked to, and refuses a missing argument", async () => {
    await db.app`SELECT sys_create_account(${freshId()}::uuid, 'verified@example.test', 'V', '$argon2id$stub', 'en', true)`;
    const rows = await asSystem(db, (tx) => tx<{ verified: boolean }[]>`SELECT email_verified_at IS NOT NULL AS verified FROM accounts`);
    expect(rows[0]?.verified).toBe(true);
    await expect(db.app`SELECT sys_create_account(${freshId()}::uuid, NULL, 'V', '$argon2id$stub', 'en', true)`).rejects.toMatchObject({ code: "22023" });
  });
});

describe("sys_create_workspace", () => {
  it("is a registered system operation", () => {
    expect(systemOperations).toContain("sys_create_workspace");
  });

  it("creates the workspace, the owner membership and the settings row together", async () => {
    const owner = freshId();
    await seedAccount(db, { id: owner, email: "owner@example.test", passwordHash: "$argon2id$stub" });
    const id = freshId();
    const created = await db.app`SELECT sys_create_workspace(${owner}::uuid, ${id}::uuid, 'Made') AS created`;
    expect(created[0]?.created).toBe(true);
    const rows = await asSystem(
      db,
      (tx) => tx<{ name: string; created_by: string; role: string; ai_enabled: boolean; updated_by: string }[]>`
        SELECT w.name, w.created_by, m.role::text AS role, s.ai_enabled, s.updated_by
        FROM workspaces w
        JOIN workspace_members m ON m.workspace_id = w.id
        JOIN workspace_settings s ON s.workspace_id = w.id
        WHERE w.id = ${id}`,
    );
    expect([...rows]).toEqual([{ name: "Made", created_by: owner, role: "owner", ai_enabled: true, updated_by: owner }]);
  });

  it("answers false, writing nothing, for an unknown or a disabled account", async () => {
    const disabled = freshId();
    await seedAccount(db, { id: disabled, email: "off@example.test", passwordHash: "$argon2id$stub", disabledAt: new Date() });
    for (const accountId of [freshId(), disabled]) {
      const created = await db.app`SELECT sys_create_workspace(${accountId}::uuid, ${freshId()}::uuid, 'Nope') AS created`;
      expect(created[0]?.created).toBe(false);
    }
    expect(await counts()).toEqual({ ...NOTHING, accounts: 1 });
  });

  it("leaves no workspace and no membership when a later row is refused", async () => {
    const owner = freshId();
    await seedAccount(db, { id: owner, email: "owner2@example.test", passwordHash: "$argon2id$stub" });
    await expect(db.app`SELECT sys_create_workspace(${owner}::uuid, ${freshId()}::uuid, ${"x".repeat(65)})`).rejects.toMatchObject({ code: "23514" });
    expect(await counts()).toEqual({ ...NOTHING, accounts: 1 });
  });
});

describe("sys_setup_status and sys_setup_token_set", () => {
  it("are registered system operations", () => {
    expect(systemOperations).toContain("sys_setup_status");
    expect(systemOperations).toContain("sys_setup_token_set");
  });

  it("report setup as pending on an empty instance and closed once an account exists", async () => {
    expect(await store.setupPending()).toBe(true);
    await seedAccount(db, { id: freshId(), email: "someone@example.test", passwordHash: "$argon2id$stub" });
    expect(await store.setupPending()).toBe(false);
  });

  it("replace the stored token hash while setup is pending, and store none once setup is closed", async () => {
    const storedHash = async () => (await asSystem(db, (tx) => tx<{ hash: Buffer }[]>`SELECT setup_token_hash AS hash FROM instance_state`))[0]?.hash;
    const first = freshToken().hash;
    expect(await store.setSetupToken(first)).toBe(true);
    expect((await storedHash())?.equals(first)).toBe(true);
    const second = freshToken().hash;
    expect(await store.setSetupToken(second)).toBe(true);
    expect((await storedHash())?.equals(second)).toBe(true);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM instance_state`)).toHaveLength(1);

    await seedAccount(db, { id: freshId(), email: "late@example.test", passwordHash: "$argon2id$stub" });
    await db.owner`DELETE FROM instance_state`;
    expect(await store.setSetupToken(freshToken().hash)).toBe(false);
    expect((await counts()).tokenHashes).toBe(0);
  });

  it("leave exactly one valid token, the last stored, when several servers start together", async () => {
    const hashes = Array.from({ length: PARALLEL_CALLS }, () => freshToken().hash);
    const stored = await Promise.all(hashes.map((hash) => store.setSetupToken(hash)));
    expect(stored.every(Boolean)).toBe(true);
    const rows = await asSystem(db, (tx) => tx<{ hash: Buffer }[]>`SELECT setup_token_hash AS hash FROM instance_state`);
    expect(rows).toHaveLength(1);
    expect(hashes.filter((hash) => hash.equals(rows[0]?.hash ?? Buffer.alloc(0)))).toHaveLength(1);
  });

  it("leaves no instant without a valid token while a new one replaces the old", async () => {
    const old = freshToken();
    expect(await store.setSetupToken(old.hash)).toBe(true);
    const readers = Array.from({ length: 20 }, async () => {
      const rows = await asSystem(db, (tx) => tx<{ hash: Buffer | null }[]>`SELECT setup_token_hash AS hash FROM instance_state`);
      return rows[0]?.hash ?? null;
    });
    const replaced = freshToken();
    const [, ...seen] = await Promise.all([store.setSetupToken(replaced.hash), ...readers]);
    expect(seen.every((hash) => hash !== null)).toBe(true);
  });

  it("makes the replaced token stop working and the new one work in sys_complete_setup", async () => {
    const old = freshToken();
    const fresh = freshToken();
    await store.setSetupToken(old.hash);
    await store.setSetupToken(fresh.hash);
    expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: old.hash }))).toBe("forbidden");
    expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: fresh.hash }))).toBe("completed");
  });

  it("refuse a hash that is not 32 bytes", async () => {
    await expect(db.app`SELECT sys_setup_token_set(${Buffer.alloc(31)}::bytea)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT sys_setup_token_set(NULL::bytea)`).rejects.toMatchObject({ code: "22023" });
  });
});

describe("sys_complete_setup", () => {
  it("is a registered system operation", () => {
    expect(systemOperations).toContain("sys_complete_setup");
  });

  it("creates the verified instance admin, its workspace with the owner membership and settings, and a session in that workspace", async () => {
    const setup = request();
    expect(await store.completeSetup(setup)).toBe("completed");

    const accounts = await asSystem(
      db,
      (tx) => tx<{ id: string; email: string; verified: boolean; admin: boolean; hash: string; signed_in: boolean }[]>`
        SELECT id, email, email_verified_at IS NOT NULL AS verified, is_instance_admin AS admin, password_hash AS hash,
               last_sign_in_at IS NOT NULL AS signed_in
        FROM accounts`,
    );
    expect([...accounts]).toEqual([
      { id: setup.accountId, email: setup.email, verified: true, admin: true, hash: setup.passwordHash, signed_in: true },
    ]);
    const workspace = await asSystem(
      db,
      (tx) => tx<{ name: string; created_by: string; role: string; ai_enabled: boolean }[]>`
        SELECT w.name, w.created_by, m.role::text AS role, s.ai_enabled
        FROM workspaces w
        JOIN workspace_members m ON m.workspace_id = w.id AND m.account_id = ${setup.accountId}
        JOIN workspace_settings s ON s.workspace_id = w.id
        WHERE w.id = ${setup.workspaceId}`,
    );
    expect([...workspace]).toEqual([{ name: "First workspace", created_by: setup.accountId, role: "owner", ai_enabled: true }]);
    const state = await asSystem(
      db,
      (tx) => tx<{ id: number; by: string; hash: Buffer | null; done: boolean }[]>`
        SELECT id, setup_by AS by, setup_token_hash AS hash, setup_completed_at IS NOT NULL AS done FROM instance_state`,
    );
    expect([...state]).toEqual([{ id: 1, by: setup.accountId, hash: null, done: true }]);
    const [session] = await sessionRows(db, setup.accountId);
    expect(session).toMatchObject({ id: setup.sessionId, level: "full", remember: false, ip_prefix: "203.0.0.0/16", user_agent: "Vitest" });
    expect(session?.token_hash.equals(setup.sessionTokenHash)).toBe(true);
    const active = await asSystem(db, (tx) => tx<{ active: string | null }[]>`SELECT active_workspace_id AS active FROM sessions WHERE id = ${setup.sessionId}`);
    expect(active[0]?.active).toBe(setup.workspaceId);

    const principal = await store.lookupSession(setup.sessionTokenHash);
    expect(principal).toMatchObject({ accountId: setup.accountId, level: "full", activeWorkspaceId: setup.workspaceId, isInstanceAdmin: true });
    expect(await store.setupPending()).toBe(false);
  });

  it("answers setup_completed and writes nothing once setup is done, whatever the body", async () => {
    expect(await store.completeSetup(request())).toBe("completed");
    const before = await counts();
    expect(before).toEqual({ accounts: 1, workspaces: 1, members: 1, settings: 1, sessions: 1, completed: 1, tokenHashes: 0 });

    expect(await store.completeSetup(request())).toBe("setup_completed");
    expect(await store.completeSetup(request({ email: "another@example.test", tokenRequired: true, tokenHash: freshToken().hash }))).toBe("setup_completed");
    expect(await counts()).toEqual(before);
  });

  it("answers setup_completed and writes nothing when an account exists although setup was never recorded", async () => {
    await seedAccount(db, { id: freshId(), email: "registered@example.test", passwordHash: "$argon2id$stub" });
    expect(await store.completeSetup(request())).toBe("setup_completed");
    expect(await counts()).toEqual({ ...NOTHING, accounts: 1 });
  });

  it("stays closed when every account is deleted after a setup", async () => {
    expect(await store.completeSetup(request())).toBe("completed");
    await deleteAccounts();
    expect(await store.setupPending()).toBe(false);
    expect(await store.completeSetup(request())).toBe("setup_completed");
    expect((await counts()).accounts).toBe(0);
  });

  it("creates exactly one account when many calls arrive at once", async () => {
    const outcomes = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.completeSetup(request())));
    expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "setup_completed")).toHaveLength(PARALLEL_CALLS - 1);
    expect(await counts()).toEqual({ accounts: 1, workspaces: 1, members: 1, settings: 1, sessions: 1, completed: 1, tokenHashes: 0 });
  });

  describe("with a setup token required", () => {
    const token = freshToken();

    beforeEach(async () => {
      expect(await store.setSetupToken(token.hash)).toBe(true);
    });

    it("answers forbidden and writes nothing for a missing or a wrong token", async () => {
      expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: null }))).toBe("forbidden");
      expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: freshToken().hash }))).toBe("forbidden");
      expect(await counts()).toEqual({ ...NOTHING, tokenHashes: 1 });
      expect(await store.setupPending()).toBe(true);
    });

    it("answers forbidden when no token was ever stored", async () => {
      await db.owner`DELETE FROM instance_state`;
      expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: token.hash }))).toBe("forbidden");
      expect(await counts()).toEqual(NOTHING);
    });

    it("completes with the right token and clears the stored hash, so it cannot be used again", async () => {
      expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: token.hash }))).toBe("completed");
      expect((await counts()).tokenHashes).toBe(0);
      expect(await store.completeSetup(request({ tokenRequired: true, tokenHash: token.hash }))).toBe("setup_completed");
      expect((await counts()).accounts).toBe(1);
    });

    it("ignores the token when the deployment does not require one", async () => {
      expect(await store.completeSetup(request({ tokenRequired: false, tokenHash: null }))).toBe("completed");
    });

    it("lets one of many calls with the right token complete, and the calls with a wrong one fail", async () => {
      const outcomes = await Promise.all(
        Array.from({ length: PARALLEL_CALLS }, (_unused, index) =>
          store.completeSetup(request({ tokenRequired: true, tokenHash: index % 2 === 0 ? token.hash : sha256("wrong") })),
        ),
      );
      expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
      expect(outcomes.flatMap((outcome, index) => (index % 2 === 1 && outcome !== "forbidden" && outcome !== "setup_completed" ? [index] : []))).toEqual([]);
      expect(outcomes.filter((outcome, index) => index % 2 === 0 && outcome === "forbidden")).toEqual([]);
      expect((await counts()).accounts).toBe(1);
    });
  });

  it("leaves nothing behind when a step after the account fails", async () => {
    // The workspace name is refused by its check constraint after the account row is written.
    await expect(store.completeSetup(request({ workspaceName: "x".repeat(65) }))).rejects.toMatchObject({ code: "23514" });
    expect(await counts()).toEqual(NOTHING);
    expect(await store.setupPending()).toBe(true);
    expect(await store.completeSetup(request())).toBe("completed");
  });

  it("refuses hashes of the wrong length before it reaches the database", async () => {
    await expect(store.completeSetup(request({ sessionTokenHash: Buffer.alloc(31) }))).rejects.toThrow(RangeError);
    await expect(store.completeSetup(request({ tokenHash: Buffer.alloc(31) }))).rejects.toThrow(RangeError);
    await expect(store.setSetupToken(Buffer.alloc(31))).rejects.toThrow(RangeError);
  });
});

describe("the jobs of a setup", () => {
  const QUEUE = "event.account.created";

  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes and reads.
  beforeAll(async () => {
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

  beforeEach(async () => {
    await db.owner`TRUNCATE pgboss.job`;
  });

  function jobFor(accountId: string, queue = QUEUE) {
    return { id: freshId(), queue, data: { eventId: freshId(), accountId, path: "setup" } };
  }

  async function queued(): Promise<{ id: string; name: string; data: Record<string, unknown> }[]> {
    return db.app<{ id: string; name: string; data: Record<string, unknown> }[]>`SELECT id, name, data FROM pgboss.job ORDER BY id`;
  }

  it("queues them in the transaction that creates the account", async () => {
    const setup = request();
    const job = jobFor(setup.accountId);

    expect(await store.completeSetup({ ...setup, jobs: [job] })).toBe("completed");

    expect(await queued()).toEqual([{ id: job.id, name: QUEUE, data: job.data }]);
  });

  it("queues none when setup is already completed, and none when the token is wrong", async () => {
    const token = freshToken();
    await store.setSetupToken(token.hash);
    expect(await store.completeSetup({ ...request({ tokenRequired: true, tokenHash: freshToken().hash }), jobs: [jobFor(freshId())] })).toBe("forbidden");
    expect(await queued()).toEqual([]);

    expect(await store.completeSetup({ ...request({ tokenRequired: true, tokenHash: token.hash }), jobs: [jobFor(freshId())] })).toBe("completed");
    expect(await queued()).toHaveLength(1);
    await db.owner`TRUNCATE pgboss.job`;

    expect(await store.completeSetup({ ...request(), jobs: [jobFor(freshId())] })).toBe("setup_completed");
    expect(await queued()).toEqual([]);
  });

  it("queues exactly one set of jobs when many calls arrive at once", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: PARALLEL_CALLS }, () => {
        const setup = request();
        return store.completeSetup({ ...setup, jobs: [jobFor(setup.accountId)] });
      }),
    );
    expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
    expect(await queued()).toHaveLength(1);
  });

  it("leaves no account when a job cannot be queued, because its queue does not exist", async () => {
    const setup = request();

    await expect(store.completeSetup({ ...setup, jobs: [jobFor(setup.accountId, "event.missing.queue")] })).rejects.toMatchObject({
      name: "QueueMissingError",
    });

    expect(await counts()).toEqual(NOTHING);
    expect(await queued()).toEqual([]);
    expect(await store.setupPending()).toBe(true);
  });

  it("leaves no job when a step after the account fails", async () => {
    const setup = request({ workspaceName: "x".repeat(65) });

    await expect(store.completeSetup({ ...setup, jobs: [jobFor(setup.accountId)] })).rejects.toMatchObject({ code: "23514" });

    expect(await counts()).toEqual(NOTHING);
    expect(await queued()).toEqual([]);
  });
});

describe("the audit events of a setup", () => {
  function eventFor(setup: CompleteSetup, overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      id: freshId(),
      workspaceId: setup.workspaceId,
      actorType: "account",
      actorAccountId: setup.accountId,
      actorLabel: setup.displayName,
      actorTokenId: null,
      action: "workspace.created",
      entityType: "workspace",
      entityId: setup.workspaceId,
      metadata: { name: setup.workspaceName },
      ipPrefix: setup.ipPrefix,
      ...overrides,
    };
  }

  async function auditRows(): Promise<{ id: string; workspace_id: string; actor_account_id: string | null; action: string; metadata: unknown }[]> {
    return asSystem(db, (tx) => tx`SELECT id, workspace_id, actor_account_id, action, metadata FROM audit_events WHERE workspace_id IS NOT NULL ORDER BY id`);
  }

  async function instanceRows(): Promise<{ id: string; actor_account_id: string | null; action: string }[]> {
    return asSystem(db, (tx) => tx`SELECT id, actor_account_id, action FROM audit_events WHERE workspace_id IS NULL ORDER BY id`);
  }

  it("writes the events it carries in the transaction that creates the workspace", async () => {
    const setup = request();
    const event = eventFor(setup);

    expect(await store.completeSetup({ ...setup, audit: [event] })).toBe("completed");

    expect(await auditRows()).toEqual([
      { id: event.id, workspace_id: setup.workspaceId, actor_account_id: setup.accountId, action: "workspace.created", metadata: { name: "First workspace" } },
    ]);
    expect(await instanceRows()).toEqual([{ id: setup.instanceEventId, actor_account_id: setup.accountId, action: "instance.setup_completed" }]);
  });

  it("writes none when setup is already completed, and none when the token is wrong", async () => {
    expect(await store.completeSetup(request({ audit: [] }))).toBe("completed");
    const second = request();
    expect(await store.completeSetup({ ...second, audit: [eventFor(second)] })).toBe("setup_completed");
    expect(await auditRows()).toEqual([]);
    expect(await instanceRows()).toHaveLength(1);

    await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
    const guarded = request({ tokenRequired: true, tokenHash: freshToken().hash });
    expect(await store.completeSetup({ ...guarded, audit: [eventFor(guarded)] })).toBe("forbidden");
    expect(await auditRows()).toEqual([]);
    expect(await instanceRows()).toEqual([]);
  });

  it("leaves no account when an event names another workspace than the one the setup creates", async () => {
    const setup = request();
    const foreign = eventFor(setup, { workspaceId: freshId() });

    await expect(store.completeSetup({ ...setup, audit: [foreign] })).rejects.toBeInstanceOf(RangeError);

    expect(await counts()).toEqual(NOTHING);
    expect(await auditRows()).toEqual([]);
  });

  it("leaves no account, workspace or session when an event cannot be written", async () => {
    const setup = request();
    const invalid = eventFor(setup, { action: "x".repeat(65) as AuditRecord["action"] });

    await expect(store.completeSetup({ ...setup, audit: [invalid] })).rejects.toMatchObject({ code: "23514" });

    expect(await counts()).toEqual(NOTHING);
    expect(await auditRows()).toEqual([]);
    expect(await store.setupPending()).toBe(true);
  });
});
