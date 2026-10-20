import { INSTANCE_AUDIT_ACTION_NAMES } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, instanceRepository, type AuthStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The deployment-level audit stream and the first system operations of the instance admin (doc 05 sections 2.9
// and 3.3, doc 10 T3 and T15). The failure scenarios: an account that is not an instance admin with a second
// factor (a member, an admin without one, a disabled admin) that reaches a sys_instance_* function directly, a
// workspace member or the application role that reads or writes an event with no workspace, and a first-run
// setup that leaves no event.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER = "22023";

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
  store = createAuthStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

interface Options {
  readonly admin?: boolean;
  readonly mfa?: boolean;
  readonly disabled?: boolean;
}

async function account(options: Options = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, {
    id,
    email: `instance${String(emailNumber)}@example.test`,
    passwordHash: "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    disabledAt: options.disabled === true ? new Date() : null,
  });
  if (options.mfa === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${id}`;
    });
  }
  return id;
}

const withTenant = <T>(accountId: string, work: Parameters<TestDatabase["tenant"]["withTenant"]>[1]): Promise<T> =>
  db.tenant.withTenant({ accountId, requestId: "req-instance" }, work) as Promise<T>;

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

interface InstanceEventRow {
  id: string;
  actor_account_id: string | null;
  actor_label: string;
  action: string;
  metadata: Record<string, unknown>;
  ip_prefix: string | null;
}

/** Every event with no workspace, read as slugbase_system, which stands for the reader of the stream. */
async function instanceEvents(): Promise<InstanceEventRow[]> {
  const rows = await asSystem(
    db,
    (tx) =>
      tx<InstanceEventRow[]>`
        SELECT id, actor_account_id, actor_label, action, metadata, ip_prefix::text AS ip_prefix
        FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`,
  );
  return [...rows];
}

/** Runs `work` as slugbase_app in a transaction with the tenant settings of withTenant and nothing else. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

describe("the system operations are entered in the registry", () => {
  it("lists the three functions this change adds", () => {
    expect(systemOperations).toEqual(expect.arrayContaining(["sys_instance_status", "sys_list_instance_audit", "sys_setup_audit"]));
  });
});

describe("sys_instance_status", () => {
  it("counts the instance and writes the instance audit event of the admin in the same call", async () => {
    const admin = await account({ admin: true, mfa: true });
    const before = (await instanceEvents()).length;
    const eventId = freshId();

    const counts = await withTenant<{ accounts: number; workspaces: number; activeSessions: number }>(admin, (tx) => instanceRepository(tx).status(eventId, "203.0.0.0/16"));

    expect(counts.accounts).toBeGreaterThanOrEqual(1);
    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({
      id: eventId,
      actor_account_id: admin,
      actor_label: "Test account",
      action: "instance.status_viewed",
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("counts the workspaces that are not being deleted and the complete sessions that have not expired", async () => {
    const admin = await account({ admin: true, mfa: true });
    const owner = await account();
    const baseline = await withTenant<{ workspaces: number; activeSessions: number; accounts: number }>(admin, (tx) => instanceRepository(tx).status(freshId(), null));

    const live = await seedWorkspace(db, { name: "Counted", createdBy: owner });
    await seedMember(db, { workspaceId: live, accountId: owner, role: "owner" });
    const going = await seedWorkspace(db, { name: "Going", createdBy: owner });
    await seedMember(db, { workspaceId: going, accountId: owner, role: "owner" });
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${going}`);

    // A complete session, an expired one, and a pending-factor one: only the first counts.
    const insertSession = (level: string, expiresInSeconds: number) =>
      asSystem(
        db,
        (tx) => tx`
          INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
          VALUES (${freshId()}, ${freshToken().hash}, ${owner}, ${level}, false,
                  now() + ${expiresInSeconds} * interval '1 second', now() + ${expiresInSeconds} * interval '1 second')`,
      );
    await insertSession("full", 3600);
    await insertSession("full", -60);
    await insertSession("partial", 300);

    const counts = await withTenant<{ workspaces: number; activeSessions: number; accounts: number }>(admin, (tx) => instanceRepository(tx).status(freshId(), null));
    expect(counts.workspaces - baseline.workspaces).toBe(1);
    expect(counts.activeSessions - baseline.activeSessions).toBe(1);
    expect(counts.accounts - baseline.accounts).toBe(0);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("raises for %s, and writes no event", async (_name, options) => {
    const caller = await account(options);
    const before = await instanceEvents();

    expect(await refusedWith(withTenant(caller, (tx) => instanceRepository(tx).status(freshId(), null)))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await instanceEvents()).toEqual(before);
  });

  it("raises when no account is set for the transaction", async () => {
    const before = await instanceEvents();
    expect(await refusedWith(db.app`SELECT * FROM sys_instance_status(${freshId()}::uuid, NULL::cidr)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await instanceEvents()).toEqual(before);
  });

  it("takes the account from the transaction and never from an argument: an admin's id cannot be named by another caller", async () => {
    const admin = await account({ admin: true, mfa: true });
    const member = await account({ mfa: true });
    // The function has no account argument; a transaction acting as the member stays the member whatever else it sends.
    expect(await refusedWith(appAs({ accountId: member }, (tx) => tx`SELECT * FROM sys_instance_status(${freshId()}::uuid, NULL::cidr)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs({ accountId: admin }, (tx) => tx`SELECT * FROM sys_instance_status(${freshId()}::uuid, NULL::cidr)`))).toBeUndefined();
  });

  it("needs an event id", async () => {
    const admin = await account({ admin: true, mfa: true });
    expect(await refusedWith(appAs({ accountId: admin }, (tx) => tx`SELECT * FROM sys_instance_status(NULL::uuid, NULL::cidr)`))).toBe(INVALID_PARAMETER);
  });
});

describe("the instance audit stream", () => {
  it("is read by an instance admin through sys_list_instance_audit, newest first, in pages by position", async () => {
    const admin = await account({ admin: true, mfa: true });
    const ids = [freshId(), freshId(), freshId()];
    for (const id of ids) {
      await withTenant(admin, (tx) => instanceRepository(tx).status(id, null));
    }

    const first = await withTenant<Awaited<ReturnType<ReturnType<typeof instanceRepository>["listAudit"]>>>(admin, (tx) => instanceRepository(tx).listAudit(2));
    expect(first.map((event) => event.id)).toEqual([ids[2], ids[1]]);
    expect(first[0]).toMatchObject({ actorAccountId: admin, actorLabel: "Test account", action: "instance.status_viewed", ipPrefix: null });

    const next = await withTenant<Awaited<ReturnType<ReturnType<typeof instanceRepository>["listAudit"]>>>(admin, (tx) => instanceRepository(tx).listAudit(1, ids[1]));
    expect(next.map((event) => event.id)).toEqual([ids[0]]);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
  ] satisfies [string, Options][])("raises for %s", async (_name, options) => {
    const caller = await account(options);
    expect(await refusedWith(withTenant(caller, (tx) => instanceRepository(tx).listAudit(10)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("refuses a limit outside 1 to 200 and a position that is no event of the stream", async () => {
    const admin = await account({ admin: true, mfa: true });
    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).listAudit(0)))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).listAudit(201)))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).listAudit(10, freshId())))).toBe(INVALID_PARAMETER);
  });

  it("writes only the actions the catalog names", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).status(freshId(), null));
    const actions = new Set((await instanceEvents()).map((event) => event.action));
    for (const action of actions) {
      expect(INSTANCE_AUDIT_ACTION_NAMES).toContain(action);
    }
  });

  it("is invisible to a workspace member and to slugbase_app except through the function", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).status(freshId(), null));
    const owner = await account();
    const workspaceId = await seedWorkspace(db, { name: "Members only", createdBy: owner });
    await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
    expect((await instanceEvents()).length).toBeGreaterThan(0);

    // A member acting in its workspace, and the admin acting in no workspace, read no row of the table with no workspace.
    for (const settings of [{ accountId: owner, workspaceId }, { accountId: admin }]) {
      const rows = await appAs(settings, (tx) => tx<{ id: string }[]>`SELECT id FROM audit_events WHERE workspace_id IS NULL`);
      expect(rows).toEqual([]);
      const all = await appAs(settings, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'instance.%'`);
      expect(all).toEqual([{ n: "0" }]);
    }
  });

  it("cannot be written by slugbase_app: no policy admits an event with no workspace, in a workspace or outside one", async () => {
    const owner = await account();
    const workspaceId = await seedWorkspace(db, { name: "Writers", createdBy: owner });
    await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
    const before = await instanceEvents();
    const insert = (tx: postgres.TransactionSql) =>
      tx`INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action) VALUES (${freshId()}, NULL, 'system', 'forged', 'instance.status_viewed')`;

    expect(await refusedWith(appAs({ accountId: owner, workspaceId }, insert))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs({ accountId: owner }, insert))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await instanceEvents()).toEqual(before);
  });

  it("cannot be changed or deleted by slugbase_app, which has no privilege that does", async () => {
    const [row] = await db.owner<Record<string, boolean>[]>`
      SELECT has_table_privilege('slugbase_app', 'public.audit_events', 'UPDATE') AS can_update,
             has_table_privilege('slugbase_app', 'public.audit_events', 'DELETE') AS can_delete`;
    expect(row).toEqual({ can_update: false, can_delete: false });
  });
});

describe("the second factor check of the instanceAdmin policy", () => {
  it("reads whether the account of the transaction has a second factor enrolled", async () => {
    const enrolled = await account({ admin: true, mfa: true });
    const bare = await account({ admin: true });
    expect(await withTenant(enrolled, (tx) => instanceRepository(tx).secondFactorEnrolled())).toBe(true);
    expect(await withTenant(bare, (tx) => instanceRepository(tx).secondFactorEnrolled())).toBe(false);
  });

  it("reads a pending enrolment as off", async () => {
    const id = await account({ admin: true });
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${id}`;
    });
    expect(await withTenant(id, (tx) => instanceRepository(tx).secondFactorEnrolled())).toBe(false);
  });
});

describe("first-run setup", () => {
  it("records instance.setup_completed for the account it made, once, in the setup's own transaction", async () => {
    await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
    const accountId = freshId();
    const eventId = freshId();
    const outcome = await store.completeSetup({
      accountId,
      workspaceId: freshId(),
      sessionId: freshId(),
      email: "setup-admin@example.test",
      displayName: "Setup Admin",
      passwordHash: "$argon2id$stub",
      locale: "en",
      workspaceName: "First workspace",
      tokenRequired: false,
      tokenHash: null,
      sessionTokenHash: freshToken().hash,
      ipPrefix: "203.0.0.0/16",
      userAgent: "Vitest",
      instanceEventId: eventId,
    });

    expect(outcome).toBe("completed");
    expect(await instanceEvents()).toEqual([
      { id: eventId, actor_account_id: accountId, actor_label: "Setup Admin", action: "instance.setup_completed", metadata: {}, ip_prefix: "203.0.0.0/16" },
    ]);
  });

  it("records nothing for a setup that is refused", async () => {
    // The instance is set up by the previous test; a second setup changes nothing.
    const before = await instanceEvents();
    const outcome = await store.completeSetup({
      accountId: freshId(),
      workspaceId: freshId(),
      sessionId: freshId(),
      email: "second-admin@example.test",
      displayName: "Second Admin",
      passwordHash: "$argon2id$stub",
      locale: "en",
      workspaceName: "Second workspace",
      tokenRequired: false,
      tokenHash: null,
      sessionTokenHash: freshToken().hash,
      ipPrefix: null,
      userAgent: null,
      instanceEventId: freshId(),
    });
    expect(outcome).toBe("setup_completed");
    expect(await instanceEvents()).toEqual(before);
  });

  it("leaves no account, workspace or session when the instance event cannot be recorded", async () => {
    await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
    // An event of this action already stands in the stream, which sys_setup_audit answers by recording nothing.
    await asSystem(
      db,
      (tx) => tx`INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action) VALUES (${freshId()}, NULL, 'system', 'earlier', 'instance.setup_completed')`,
    );
    const request = {
      accountId: freshId(),
      workspaceId: freshId(),
      sessionId: freshId(),
      email: "blocked-admin@example.test",
      displayName: "Blocked Admin",
      passwordHash: "$argon2id$stub",
      locale: "en",
      workspaceName: "Blocked workspace",
      tokenRequired: false,
      tokenHash: null,
      sessionTokenHash: freshToken().hash,
      ipPrefix: null,
      userAgent: null,
      instanceEventId: freshId(),
    };

    await expect(store.completeSetup(request)).rejects.toThrow("sys_setup_audit did not record");

    const [row] = await asSystem(db, (tx) => tx<{ accounts: string; workspaces: string; sessions: string }[]>`
      SELECT (SELECT count(*) FROM accounts)::text AS accounts, (SELECT count(*) FROM workspaces)::text AS workspaces, (SELECT count(*) FROM sessions)::text AS sessions`);
    expect(row).toEqual({ accounts: "0", workspaces: "0", sessions: "0" });
    expect(await store.setupPending()).toBe(true);
    await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
  });

  it("lets nobody forge the event through sys_setup_audit: once recorded, or before setup, it writes nothing", async () => {
    const before = await instanceEvents();
    const again = await db.app<{ recorded: boolean }[]>`SELECT sys_setup_audit(${freshId()}::uuid, NULL::cidr) AS recorded`;
    expect(again).toEqual([{ recorded: false }]);
    expect(await instanceEvents()).toEqual(before);

    await db.owner`TRUNCATE accounts, workspaces, instance_state CASCADE`;
    const early = await db.app<{ recorded: boolean }[]>`SELECT sys_setup_audit(${freshId()}::uuid, NULL::cidr) AS recorded`;
    expect(early).toEqual([{ recorded: false }]);
    expect(await instanceEvents()).toEqual([]);
  });
});
