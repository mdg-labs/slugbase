import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, instanceRepository, type AuthStore, type QueuedJob } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The instance settings and the test email of the instance admin (doc 05 sections 2.2 and 3.3, doc 02 section
// 11.3, doc 10 T3). The failure scenarios: an account that is not an instance admin with a second factor that reaches
// sys_instance_update_settings or sys_instance_test_mail directly, the application role that writes the table
// itself, and a value outside the limits of the columns.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER = "22023";
const CHECK_VIOLATION = "23514";

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
    INSERT INTO pgboss.queue VALUES ('mail.send', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`DELETE FROM instance_settings`;
});

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

const testMailJob = (accountId = freshId()): QueuedJob => ({ id: freshId(), queue: "mail.send", data: { template: "testMail", accountId } });

async function queuedMail(jobId: string): Promise<number> {
  const rows = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE id = ${jobId}::uuid`;
  return rows[0]?.count ?? 0;
}

const UNSET = { allowWorkspaceCreation: null, displayName: null, signInNotice: null };

describe("the system operations are entered in the registry", () => {
  it("lists the three functions this change adds", () => {
    expect(systemOperations).toEqual(expect.arrayContaining(["sys_instance_settings", "sys_instance_update_settings", "sys_instance_test_mail"]));
  });
});

describe("the instance settings", () => {
  it("are all unset while no row exists, for the instance admin's repository and for the anonymous store alike", async () => {
    const admin = await account({ admin: true, mfa: true });
    expect(await withTenant(admin, (tx) => instanceRepository(tx).settings())).toEqual(UNSET);
    expect(await store.instanceSettings()).toEqual(UNSET);
  });

  it("are changed one at a time, keep the settings an update leaves out, and clear with null", async () => {
    const admin = await account({ admin: true, mfa: true });
    const first = await withTenant<unknown>(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Acme Links" }, freshId(), null));
    expect(first).toEqual({ ...UNSET, displayName: "Acme Links" });

    const second = await withTenant<unknown>(admin, (tx) => instanceRepository(tx).updateSettings({ allowWorkspaceCreation: true, signInNotice: "Planned maintenance on Friday." }, freshId(), null));
    expect(second).toEqual({ allowWorkspaceCreation: true, displayName: "Acme Links", signInNotice: "Planned maintenance on Friday." });

    const third = await withTenant<unknown>(admin, (tx) => instanceRepository(tx).updateSettings({ allowWorkspaceCreation: false, displayName: null }, freshId(), null));
    expect(third).toEqual({ allowWorkspaceCreation: false, displayName: null, signInNotice: "Planned maintenance on Friday." });

    expect(await store.instanceSettings()).toEqual(third);
    expect(await withTenant(admin, (tx) => instanceRepository(tx).settings())).toEqual(third);
    const rows = await asSystem(db, (tx) => tx<{ count: number; updated_by: string }[]>`SELECT count(*)::int AS count, min(updated_by::text) AS updated_by FROM instance_settings`);
    expect(rows[0]).toEqual({ count: 1, updated_by: admin });
  });

  it("write one instance audit event that names the settings changed and carries no value", async () => {
    const admin = await account({ admin: true, mfa: true });
    const before = (await instanceEvents()).length;
    const eventId = freshId();

    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Secret-looking name", signInNotice: null, allowWorkspaceCreation: true }, eventId, "203.0.0.0/16"));

    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({
      id: eventId,
      actor_account_id: admin,
      actor_label: "Test account",
      action: "instance.settings_changed",
      metadata: { settings: "allowWorkspaceCreation,displayName,signInNotice" },
      ip_prefix: "203.0.0.0/16",
    });
    expect(JSON.stringify(events.at(-1))).not.toContain("Secret-looking name");
  });

  it("are read back by the repository of the stream as an event the catalog describes", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Acme" }, freshId(), null));
    await withTenant(admin, (tx) => instanceRepository(tx).recordTestMail(freshId(), null, testMailJob()));

    const events = await withTenant<readonly { action: string; metadata: Record<string, string> }[]>(admin, (tx) => instanceRepository(tx).listAudit(2));

    expect(events.map(({ action, metadata }) => ({ action, metadata }))).toEqual([
      { action: "instance.test_mail_queued", metadata: {} },
      { action: "instance.settings_changed", metadata: { settings: "displayName" } },
    ]);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("are not changed by %s, which raises and writes nothing", async (_name, options) => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Kept", allowWorkspaceCreation: false }, freshId(), null));
    const caller = await account(options);
    const events = await instanceEvents();

    expect(await refusedWith(withTenant(caller, (tx) => instanceRepository(tx).updateSettings({ displayName: "Hijacked", allowWorkspaceCreation: true }, freshId(), null)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );

    expect(await store.instanceSettings()).toEqual({ allowWorkspaceCreation: false, displayName: "Kept", signInNotice: null });
    expect(await instanceEvents()).toEqual(events);
  });

  it("raise when no account is set for the transaction", async () => {
    const events = await instanceEvents();
    expect(
      await refusedWith(db.app`SELECT * FROM sys_instance_update_settings(${freshId()}::uuid, NULL::cidr, true, true, false, NULL, false, NULL)`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await instanceEvents()).toEqual(events);
  });

  it("refuse a call that changes no setting, and a value outside the limits of the columns, and write nothing", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Limits", signInNotice: "kept" }, freshId(), null));
    const events = await instanceEvents();

    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).updateSettings({}, freshId(), null)))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ signInNotice: "x".repeat(501) }, freshId(), null)))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "" }, freshId(), null)))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "y".repeat(101) }, freshId(), null)))).toBe(CHECK_VIOLATION);
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ signInNotice: "n".repeat(500) }, freshId(), null));

    expect((await store.instanceSettings()).displayName).toBe("Limits");
    expect(await instanceEvents()).toHaveLength(events.length + 1);
  });

  it("cannot be written by the application role itself, only read", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Direct" }, freshId(), null));

    expect(await refusedWith(db.app`UPDATE instance_settings SET display_name = 'Hijacked'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(db.app`INSERT INTO instance_settings (id, display_name) VALUES (1, 'Hijacked') ON CONFLICT (id) DO UPDATE SET display_name = 'Hijacked'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(db.app`DELETE FROM instance_settings`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await store.instanceSettings()).displayName).toBe("Direct");
  });

  it("hold exactly one row", async () => {
    expect(await refusedWith(asSystem(db, (tx) => tx`INSERT INTO instance_settings (id) VALUES (2)`))).toBe(CHECK_VIOLATION);
  });
});

describe("sys_instance_settings", () => {
  it("answers the settings and writes the instance audit event of the admin in the same call, with no metadata", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Acme", signInNotice: "Hello" }, freshId(), null));
    const before = (await instanceEvents()).length;
    const eventId = freshId();

    const settings = await withTenant(admin, (tx) => instanceRepository(tx).viewSettings(eventId, "203.0.0.0/16"));

    expect(settings).toEqual({ allowWorkspaceCreation: null, displayName: "Acme", signInNotice: "Hello" });
    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({
      id: eventId,
      actor_account_id: admin,
      actor_label: "Test account",
      action: "instance.settings_viewed",
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("answers every setting null, and still writes the event, while no row exists", async () => {
    const admin = await account({ admin: true, mfa: true });
    const before = (await instanceEvents()).length;

    expect(await withTenant(admin, (tx) => instanceRepository(tx).viewSettings(freshId(), null))).toEqual(UNSET);
    expect(await instanceEvents()).toHaveLength(before + 1);
  });

  it("is read back by the repository of the stream as an event the catalog describes", async () => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).viewSettings(freshId(), null));

    const events = await withTenant<readonly { action: string; metadata: Record<string, string> }[]>(admin, (tx) => instanceRepository(tx).listAudit(1));

    expect(events.map(({ action, metadata }) => ({ action, metadata }))).toEqual([{ action: "instance.settings_viewed", metadata: {} }]);
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
    ["an account with neither", {}],
  ] satisfies [string, Options][])("raises for %s, which reads nothing and writes no event", async (_name, options) => {
    const admin = await account({ admin: true, mfa: true });
    await withTenant(admin, (tx) => instanceRepository(tx).updateSettings({ displayName: "Kept" }, freshId(), null));
    const caller = await account(options);
    const before = await instanceEvents();

    expect(await refusedWith(withTenant(caller, (tx) => instanceRepository(tx).viewSettings(freshId(), null)))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await instanceEvents()).toEqual(before);
  });

  it("raises when no account is set for the transaction", async () => {
    const before = await instanceEvents();
    expect(await refusedWith(db.app`SELECT * FROM sys_instance_settings(${freshId()}::uuid, NULL::cidr)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await instanceEvents()).toEqual(before);
  });
});

describe("sys_instance_test_mail", () => {
  it("writes the instance audit event of the admin and queues the message in the same transaction", async () => {
    const admin = await account({ admin: true, mfa: true });
    const before = (await instanceEvents()).length;
    const eventId = freshId();
    const job = testMailJob(admin);

    await withTenant(admin, (tx) => instanceRepository(tx).recordTestMail(eventId, "203.0.0.0/16", job));
    expect(await queuedMail(job.id)).toBe(1);

    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({
      id: eventId,
      actor_account_id: admin,
      actor_label: "Test account",
      action: "instance.test_mail_queued",
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it.each([
    ["a member who holds no flag", { mfa: true }],
    ["an admin who has no second factor enrolled", { admin: true }],
    ["a disabled admin", { admin: true, mfa: true, disabled: true }],
  ] satisfies [string, Options][])("raises for %s, and writes no event and queues no message", async (_name, options) => {
    const caller = await account(options);
    const before = await instanceEvents();
    const job = testMailJob(caller);

    expect(await refusedWith(withTenant(caller, (tx) => instanceRepository(tx).recordTestMail(freshId(), null, job)))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await instanceEvents()).toEqual(before);
    expect(await queuedMail(job.id)).toBe(0);
  });
});
