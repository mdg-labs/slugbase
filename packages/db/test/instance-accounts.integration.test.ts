import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountDeletionRepository, apiTokenRepository, createAuthStore, instanceRepository, type AuthStore, type QueuedJob, type TenantTx } from "../src/index.ts";
import type { InstanceAccount, InstanceAccountUpdateOutcome } from "@slugbase/core";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The account operations of the instance admin (doc 05 sections 2.1, 3.3 and 7.1, doc 02 sections 2.3 and 11.2, doc 10
// T4 and T18). The failure scenarios: an account that is not an instance admin with a second factor that reaches a
// sys_instance_*_account function, which must raise and read, change or write nothing; a list that carries a hash, a
// secret or anything of a workspace; a disabled account whose session or API token still works on its next request; a
// change of the flag that leaves the target's old session alive; and the last enabled admin demoted or disabled, alone
// or by two admins who change each other at once, or by a demotion racing the admin's own deletion.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER = "22023";
const MAIL_QUEUE = "mail.send";

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
    INSERT INTO pgboss.queue VALUES ('${MAIL_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  // The instance holds the admins of the test in hand and no other: a test that counts admins starts from none.
  await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
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
  readonly verified?: boolean;
}

async function account(options: Options = {}): Promise<{ id: string; email: string }> {
  emailNumber += 1;
  const id = freshId();
  const email = `instance-accounts${String(emailNumber)}@example.test`;
  await seedAccount(db, {
    id,
    email,
    passwordHash: "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    disabledAt: options.disabled === true ? new Date() : null,
    emailVerified: options.verified !== false,
  });
  if (options.mfa === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${id}`;
    });
  }
  return { id, email };
}

const admin = async (): Promise<string> => (await account({ admin: true, mfa: true })).id;

function withTenant<T>(accountId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "req-instance-accounts" }, work);
}

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
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip_prefix: string | null;
}

/** Every event with no workspace, read as slugbase_system, which stands for the reader of the stream. */
async function instanceEvents(): Promise<InstanceEventRow[]> {
  const rows = await asSystem(
    db,
    (tx) =>
      tx<InstanceEventRow[]>`
        SELECT id, actor_account_id, action, entity_type, entity_id, metadata, ip_prefix::text AS ip_prefix
        FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`,
  );
  return [...rows];
}

interface AccountState {
  is_instance_admin: boolean;
  disabled: boolean;
}

async function stateOf(accountId: string): Promise<AccountState | undefined> {
  const rows = await asSystem(db, (tx) => tx<AccountState[]>`SELECT is_instance_admin, disabled_at IS NOT NULL AS disabled FROM accounts WHERE id = ${accountId}`);
  return rows[0];
}

async function adminCount(): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts WHERE is_instance_admin`);
  return rows[0]?.count ?? 0;
}

/** A session of the account with a token hash the test keeps. */
async function seedSession(accountId: string, level: "full" | "partial" = "full"): Promise<Buffer> {
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
      VALUES (${freshId()}, ${hash}, ${accountId}, ${level}, false, now() + interval '1 hour', now() + interval '1 day')`,
  );
  return hash;
}

/** An API token of the account in a workspace of its own; the hash is what a lookup takes. */
async function seedToken(accountId: string): Promise<Buffer> {
  const workspaceId = await seedWorkspace(db, { createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role: "admin" });
  const secret = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(`slb_${secret}`).digest();
  const outcome = await db.tenant.withTenant({ accountId, requestId: "accounts-test-token" }, (tx) =>
    apiTokenRepository(tx).create({ id: freshId(), workspaceId, name: "CI", scope: "read", tokenHash: hash, tokenPrefix: secret.slice(0, 6), expiresInDays: 90, limit: 10 }),
  );
  expect(outcome.kind).toBe("created");
  return hash;
}

const mailJob = (accountId: string): QueuedJob => ({ id: freshId(), queue: MAIL_QUEUE, data: { template: "accountDisabled", accountId } });

async function mailJobs(): Promise<Record<string, unknown>[]> {
  return (await db.owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${MAIL_QUEUE} ORDER BY id`).map((row) => row.data);
}

// The answer for the one field a test changes: `changed` when this call moved it, `unchanged` when the account already had the value.
type FieldResult = { readonly kind: "changed" | "unchanged"; readonly account: InstanceAccount } | { readonly kind: "unknown_account" } | { readonly kind: "last_instance_admin" };

function fieldResult(outcome: InstanceAccountUpdateOutcome, field: "adminChanged" | "disabledChanged"): FieldResult {
  if (outcome.kind !== "updated") {
    return { kind: outcome.kind };
  }
  return { kind: outcome[field] ? "changed" : "unchanged", account: outcome.account };
}

const setAdminIn = async (tx: TenantTx, target: string, value: boolean, eventId = freshId(), ipPrefix: string | null = null): Promise<FieldResult> =>
  fieldResult(await instanceRepository(tx).updateAccount(target, { isInstanceAdmin: value }, { admin: eventId, disabled: freshId() }, ipPrefix, []), "adminChanged");

const setDisabledIn = async (tx: TenantTx, target: string, value: boolean, jobs: readonly QueuedJob[] = [], eventId = freshId(), ipPrefix: string | null = null): Promise<FieldResult> =>
  fieldResult(await instanceRepository(tx).updateAccount(target, { disabled: value }, { admin: freshId(), disabled: eventId }, ipPrefix, jobs), "disabledChanged");

const setAdmin = (actor: string, target: string, value: boolean, eventId = freshId(), ipPrefix: string | null = null) =>
  withTenant(actor, (tx) => setAdminIn(tx, target, value, eventId, ipPrefix));

const setDisabled = (actor: string, target: string, value: boolean, jobs: readonly QueuedJob[] = [], eventId = freshId(), ipPrefix: string | null = null) =>
  withTenant(actor, (tx) => setDisabledIn(tx, target, value, jobs, eventId, ipPrefix));

describe("the system operations are entered in the registry", () => {
  it("lists the two functions this change adds", () => {
    expect(systemOperations).toEqual(expect.arrayContaining(["sys_instance_list_accounts", "sys_instance_update_account"]));
  });
});

describe("sys_instance_list_accounts", () => {
  it("lists every account with the fields the admin needs and no hash, secret or workspace content", async () => {
    const caller = await admin();
    const verified = await account({ verified: true, mfa: true });
    const unverified = await account({ verified: false });
    const disabled = await account({ disabled: true });
    const workspaceId = await seedWorkspace(db, { name: "Secret plans" });
    await seedMember(db, { workspaceId, accountId: verified.id, role: "owner" });
    const going = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });
    await seedMember(db, { workspaceId: going, accountId: verified.id, role: "member" });

    const listed = await withTenant(caller, (tx) => instanceRepository(tx).listAccounts(freshId(), null));

    expect(listed.find((item) => item.id === verified.id)).toEqual({
      id: verified.id,
      displayName: "Test account",
      email: verified.email,
      emailVerified: true,
      mfaEnabled: true,
      isInstanceAdmin: false,
      disabled: false,
      lastSignInAt: null,
      workspaceCount: 1,
    });
    expect(listed.find((item) => item.id === unverified.id)).toMatchObject({ emailVerified: false, mfaEnabled: false, workspaceCount: 0 });
    expect(listed.find((item) => item.id === disabled.id)).toMatchObject({ disabled: true });
    expect(listed.find((item) => item.id === caller)).toMatchObject({ isInstanceAdmin: true, mfaEnabled: true });
    for (const item of listed) {
      expect(Object.keys(item).sort()).toEqual(["disabled", "displayName", "email", "emailVerified", "id", "isInstanceAdmin", "lastSignInAt", "mfaEnabled", "workspaceCount"]);
    }
    expect(JSON.stringify(listed)).not.toMatch(/argon2id|Secret plans|sealed/);
  });

  it("orders the accounts oldest first", async () => {
    const caller = await admin();
    const later = await account();

    const listed = await withTenant(caller, (tx) => instanceRepository(tx).listAccounts(freshId(), null));

    const ids = listed.map((item) => item.id);
    expect(ids.indexOf(caller)).toBeLessThan(ids.indexOf(later.id));
  });

  it("writes one instance audit event for the admin with no entity and no metadata, in the same call", async () => {
    const caller = await admin();
    const before = (await instanceEvents()).length;
    const eventId = freshId();

    await withTenant(caller, (tx) => instanceRepository(tx).listAccounts(eventId, "203.0.0.0/16"));

    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ id: eventId, actor_account_id: caller, action: "instance.accounts_viewed", entity_type: null, entity_id: null, metadata: {}, ip_prefix: "203.0.0.0/16" });
  });
});

describe("the two functions repeat the instanceAdmin check in the database", () => {
  const callers: readonly [string, () => Promise<string>][] = [
    ["an account that holds no flag", async () => (await account({ mfa: true })).id],
    ["an instance admin without a second factor", async () => (await account({ admin: true })).id],
    ["a disabled instance admin with a second factor", async () => (await account({ admin: true, mfa: true, disabled: true })).id],
  ];

  it.each(callers)("raises insufficient_privilege for %s and reads, changes and writes nothing", async (_who, make) => {
    const victim = await account();
    const victimSession = await seedSession(victim.id);
    const caller = await make();
    const events = await instanceEvents();
    const sessions = (await sessionRows(db, victim.id)).length;
    const run = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(caller, work);

    expect(await refusedWith(run((tx) => instanceRepository(tx).listAccounts(freshId(), null)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(run((tx) => setAdminIn(tx, victim.id, true)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(run((tx) => setDisabledIn(tx, victim.id, true, [mailJob(victim.id)])))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await stateOf(victim.id)).toEqual({ is_instance_admin: false, disabled: false });
    expect(await instanceEvents()).toEqual(events);
    expect(await sessionRows(db, victim.id)).toHaveLength(sessions);
    expect(await store.lookupSession(victimSession)).toBeDefined();
    expect(await mailJobs()).toEqual([]);
  });

  it("raises insufficient_privilege when the transaction acts for no account", async () => {
    const victim = await account();
    const events = await instanceEvents();
    const asNobody = (work: (tx: import("postgres").TransactionSql) => Promise<unknown>): Promise<unknown> => db.app.begin((tx) => work(tx));

    expect(await refusedWith(asNobody((tx) => tx`SELECT * FROM sys_instance_list_accounts(${freshId()}::uuid, NULL::cidr)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(asNobody((tx) => tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${victim.id}::uuid, true, NULL::boolean)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(asNobody((tx) => tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${victim.id}::uuid, NULL::boolean, true)`))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await stateOf(victim.id)).toEqual({ is_instance_admin: false, disabled: false });
    expect(await instanceEvents()).toEqual(events);
  });

  it("refuses a missing event id or value as an invalid parameter, writing nothing", async () => {
    const caller = await admin();
    const target = await account();
    const events = await instanceEvents();
    const asApp = (work: (tx: import("postgres").TransactionSql) => Promise<unknown>): Promise<unknown> =>
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${caller}, true)`;
        return work(tx);
      });

    expect(await refusedWith(asApp((tx) => tx`SELECT * FROM sys_instance_update_account(NULL::uuid, ${freshId()}::uuid, NULL::cidr, ${target.id}::uuid, true, NULL::boolean)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${target.id}::uuid, NULL::boolean, NULL::boolean)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, NULL::uuid, NULL::boolean, true)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT * FROM sys_instance_list_accounts(NULL::uuid, NULL::cidr)`))).toBe(INVALID_PARAMETER);

    expect(await stateOf(target.id)).toEqual({ is_instance_admin: false, disabled: false });
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("sys_instance_update_account, the instance-admin flag", () => {
  it("grants the flag, deletes every session of the target, and writes the event for the target in the same call", async () => {
    const caller = await admin();
    const target = await account();
    const full = await seedSession(target.id);
    const partial = await seedSession(target.id, "partial");
    const bystander = await account();
    const bystanderSession = await seedSession(bystander.id);
    const eventId = freshId();

    const result = await setAdmin(caller, target.id, true, eventId, "203.0.0.0/16");

    expect(result).toMatchObject({ kind: "changed", account: { id: target.id, isInstanceAdmin: true, disabled: false } });
    expect(await stateOf(target.id)).toEqual({ is_instance_admin: true, disabled: false });
    expect(await sessionRows(db, target.id)).toEqual([]);
    expect(await store.lookupSession(full)).toBeUndefined();
    expect(await store.lookupSession(partial)).toBeUndefined();
    expect(await store.lookupSession(bystanderSession)).toBeDefined();
    expect((await instanceEvents()).at(-1)).toEqual({
      id: eventId,
      actor_account_id: caller,
      action: "instance.account_admin_granted",
      entity_type: "account",
      entity_id: target.id,
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("clears the flag when another enabled admin remains, deletes the target's sessions and writes the revoking event", async () => {
    const caller = await admin();
    const target = await account({ admin: true, mfa: true });
    const session = await seedSession(target.id);

    const result = await setAdmin(caller, target.id, false);

    expect(result).toMatchObject({ kind: "changed", account: { id: target.id, isInstanceAdmin: false } });
    expect(await store.lookupSession(session)).toBeUndefined();
    expect((await instanceEvents()).at(-1)).toMatchObject({ actor_account_id: caller, action: "instance.account_admin_revoked", entity_type: "account", entity_id: target.id });
    expect(await adminCount()).toBe(1);
  });

  it("changes nothing, deletes no session and writes no event when the account already has the value", async () => {
    const caller = await admin();
    const target = await account({ admin: true, mfa: true });
    const session = await seedSession(target.id);
    const events = await instanceEvents();

    expect(await setAdmin(caller, target.id, true)).toMatchObject({ kind: "unchanged", account: { id: target.id, isInstanceAdmin: true } });
    const plain = await account();
    expect(await setAdmin(caller, plain.id, false)).toMatchObject({ kind: "unchanged", account: { id: plain.id, isInstanceAdmin: false } });

    expect(await store.lookupSession(session)).toBeDefined();
    expect(await instanceEvents()).toEqual(events);
  });

  it("answers unknown_account for an account that does not exist, writing nothing", async () => {
    const caller = await admin();
    const events = await instanceEvents();

    expect(await setAdmin(caller, freshId(), true)).toEqual({ kind: "unknown_account" });

    expect(await instanceEvents()).toEqual(events);
  });

  it("refuses to clear the flag of the only admin, who is the caller, and leaves the flag, the sessions and the stream as they were", async () => {
    const caller = await admin();
    const session = await seedSession(caller);
    const events = await instanceEvents();

    expect(await setAdmin(caller, caller, false)).toEqual({ kind: "last_instance_admin" });

    expect(await stateOf(caller)).toEqual({ is_instance_admin: true, disabled: false });
    expect(await store.lookupSession(session)).toBeDefined();
    expect(await instanceEvents()).toEqual(events);
  });

  it("does not count a disabled admin as another admin", async () => {
    const caller = await admin();
    await account({ admin: true, mfa: true, disabled: true });
    await account({ mfa: true });

    expect(await setAdmin(caller, caller, false)).toEqual({ kind: "last_instance_admin" });
    expect(await stateOf(caller)).toEqual({ is_instance_admin: true, disabled: false });
  });

  it("lets an admin clear their own flag while another enabled admin remains", async () => {
    const caller = await admin();
    const other = await admin();

    expect(await setAdmin(caller, caller, false)).toMatchObject({ kind: "changed", account: { isInstanceAdmin: false } });
    expect(await stateOf(other)).toEqual({ is_instance_admin: true, disabled: false });
  });
});

describe("sys_instance_update_account, the disabled state", () => {
  it("disables the account: disabled_at is set, every session is deleted and the next lookup of a session or a token finds nothing", async () => {
    const caller = await admin();
    const target = await account();
    const full = await seedSession(target.id);
    const partial = await seedSession(target.id, "partial");
    const token = await seedToken(target.id);
    expect(await store.lookupSession(full)).toBeDefined();
    expect(await store.lookupApiToken(token, null)).toBeDefined();
    const bystander = await account();
    const bystanderSession = await seedSession(bystander.id);
    const eventId = freshId();

    const result = await setDisabled(caller, target.id, true, [mailJob(target.id)], eventId, "203.0.0.0/16");

    expect(result).toMatchObject({ kind: "changed", account: { id: target.id, disabled: true } });
    expect(await stateOf(target.id)).toEqual({ is_instance_admin: false, disabled: true });
    expect(await sessionRows(db, target.id)).toEqual([]);
    expect(await store.lookupSession(full)).toBeUndefined();
    expect(await store.lookupSession(partial)).toBeUndefined();
    expect(await store.lookupApiToken(token, null)).toBeUndefined();
    expect(await store.lookupSession(bystanderSession)).toBeDefined();
    expect(await mailJobs()).toEqual([{ template: "accountDisabled", accountId: target.id }]);
    expect((await instanceEvents()).at(-1)).toEqual({
      id: eventId,
      actor_account_id: caller,
      action: "instance.account_disabled",
      entity_type: "account",
      entity_id: target.id,
      metadata: {},
      ip_prefix: "203.0.0.0/16",
    });
  });

  it("refuses a new session and a sign-in lookup result for a disabled account, so it sees the generic sign-in error", async () => {
    const caller = await admin();
    const target = await account();
    await setDisabled(caller, target.id, true);

    expect(await store.createSession({ id: freshId(), accountId: target.id, level: "full", remember: false, ipPrefix: null, userAgent: null, tokenHash: freshToken().hash, replacedTokenHash: null })).toBe(false);
    expect((await store.loginLookup(target.email))?.disabledAt).toBeInstanceOf(Date);
  });

  it("enables the account again: disabled_at is cleared, nothing is queued and the event says enabled", async () => {
    const caller = await admin();
    const target = await account({ disabled: true });

    const result = await setDisabled(caller, target.id, false, [mailJob(target.id)]);

    expect(result).toMatchObject({ kind: "changed", account: { id: target.id, disabled: false } });
    expect(await stateOf(target.id)).toEqual({ is_instance_admin: false, disabled: false });
    expect((await instanceEvents()).at(-1)).toMatchObject({ action: "instance.account_enabled", entity_type: "account", entity_id: target.id });
    expect(await store.createSession({ id: freshId(), accountId: target.id, level: "full", remember: false, ipPrefix: null, userAgent: null, tokenHash: freshToken().hash, replacedTokenHash: null })).toBe(true);
  });

  it("queues the mail only for a disabling that changed the state: not for an account already disabled, not for an unknown one", async () => {
    const caller = await admin();
    const target = await account({ disabled: true });
    const events = await instanceEvents();

    expect(await setDisabled(caller, target.id, true, [mailJob(target.id)])).toMatchObject({ kind: "unchanged", account: { disabled: true } });
    expect(await setDisabled(caller, freshId(), true, [mailJob(target.id)])).toEqual({ kind: "unknown_account" });

    expect(await mailJobs()).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
  });

  it("undoes the disabling when the mail job cannot be queued", async () => {
    const caller = await admin();
    const target = await account();
    const session = await seedSession(target.id);
    const events = await instanceEvents();

    await expect(setDisabled(caller, target.id, true, [{ id: freshId(), queue: "no.such.queue", data: {} }])).rejects.toBeDefined();

    expect(await stateOf(target.id)).toEqual({ is_instance_admin: false, disabled: false });
    expect(await store.lookupSession(session)).toBeDefined();
    expect(await instanceEvents()).toEqual(events);
  });

  it("refuses to disable the only enabled admin, who is the caller, and changes, deletes and queues nothing", async () => {
    const caller = await admin();
    const session = await seedSession(caller);
    const events = await instanceEvents();

    expect(await setDisabled(caller, caller, true, [mailJob(caller)])).toEqual({ kind: "last_instance_admin" });

    expect(await stateOf(caller)).toEqual({ is_instance_admin: true, disabled: false });
    expect(await store.lookupSession(session)).toBeDefined();
    expect(await mailJobs()).toEqual([]);
    expect(await instanceEvents()).toEqual(events);
  });

  it("lets an admin disable another admin, and then refuses to clear or disable the last enabled one", async () => {
    const caller = await admin();
    const other = await admin();

    expect(await setDisabled(caller, other, true)).toMatchObject({ kind: "changed", account: { disabled: true, isInstanceAdmin: true } });

    expect(await setAdmin(caller, caller, false)).toEqual({ kind: "last_instance_admin" });
    expect(await setDisabled(caller, caller, true)).toEqual({ kind: "last_instance_admin" });
    expect(await stateOf(caller)).toEqual({ is_instance_admin: true, disabled: false });
  });
});

describe("sys_instance_update_account, both fields in one call", () => {
  const both = (actor: string, target: string, change: { isInstanceAdmin?: boolean; disabled?: boolean }, jobs: readonly QueuedJob[] = []) =>
    withTenant(actor, (tx) => instanceRepository(tx).updateAccount(target, change, { admin: freshId(), disabled: freshId() }, null, jobs));

  it("changes the flag and the disabled state of another account, with one event each, one deletion of its sessions and the mail queued once", async () => {
    const caller = await admin();
    const target = await account({ admin: true, mfa: true });
    const session = await seedSession(target.id);
    const events = (await instanceEvents()).length;

    const result = await both(caller, target.id, { isInstanceAdmin: false, disabled: true }, [mailJob(target.id)]);

    expect(result).toMatchObject({ kind: "updated", adminChanged: true, disabledChanged: true, account: { id: target.id, isInstanceAdmin: false, disabled: true } });
    expect(await stateOf(target.id)).toEqual({ is_instance_admin: false, disabled: true });
    expect(await store.lookupSession(session)).toBeUndefined();
    expect((await instanceEvents()).slice(events).map((event) => [event.action, event.actor_account_id, event.entity_id])).toEqual([
      ["instance.account_admin_revoked", caller, target.id],
      ["instance.account_disabled", caller, target.id],
    ]);
    expect(await mailJobs()).toHaveLength(1);
  });

  it("reports only the field that moved, and queues no mail when the account was already disabled", async () => {
    const caller = await admin();
    const target = await account({ mfa: true, disabled: true });
    const events = (await instanceEvents()).length;

    const result = await both(caller, target.id, { isInstanceAdmin: true, disabled: true }, [mailJob(target.id)]);

    expect(result).toMatchObject({ kind: "updated", adminChanged: true, disabledChanged: false, account: { isInstanceAdmin: true, disabled: true } });
    expect((await instanceEvents()).slice(events).map((event) => event.action)).toEqual(["instance.account_admin_granted"]);
    expect(await mailJobs()).toEqual([]);
  });

  it.each([
    ["clears their flag and leaves the account enabled", { isInstanceAdmin: false, disabled: false }, { is_instance_admin: false, disabled: false }, ["instance.account_admin_revoked"]],
    ["clears their flag and disables the account", { isInstanceAdmin: false, disabled: true }, { is_instance_admin: false, disabled: true }, ["instance.account_admin_revoked", "instance.account_disabled"]],
    ["keeps their flag and disables the account", { isInstanceAdmin: true, disabled: true }, { is_instance_admin: true, disabled: true }, ["instance.account_disabled"]],
    ["only disables the account", { disabled: true }, { is_instance_admin: true, disabled: true }, ["instance.account_disabled"]],
  ] as const)("lets an admin who changes their own account, while another enabled admin remains, %s", async (_what, change, state, actions) => {
    await admin();
    const caller = await admin();
    const session = await seedSession(caller);
    const events = (await instanceEvents()).length;

    const result = await both(caller, caller, change);

    expect(result).toMatchObject({ kind: "updated", account: { id: caller, isInstanceAdmin: state.is_instance_admin, disabled: state.disabled } });
    expect(await stateOf(caller)).toEqual(state);
    expect((await instanceEvents()).slice(events).map((event) => event.action)).toEqual(actions);
    expect(await store.lookupSession(session)).toBeUndefined();
  });

  it.each([
    ["the flag it clears", { isInstanceAdmin: false, disabled: true }, "isInstanceAdmin"],
    ["the flag it clears, though the disabled state is not asked to change", { isInstanceAdmin: false, disabled: false }, "isInstanceAdmin"],
    ["the disabling, when the flag stays", { isInstanceAdmin: true, disabled: true }, "disabled"],
  ] as const)("refuses the only enabled admin who changes their own account, naming %s, and changes, deletes and queues nothing", async (_what, change, field) => {
    const caller = await admin();
    const session = await seedSession(caller);
    const events = await instanceEvents();

    expect(await both(caller, caller, change, [mailJob(caller)])).toEqual({ kind: "last_instance_admin", field });

    expect(await stateOf(caller)).toEqual({ is_instance_admin: true, disabled: false });
    expect(await store.lookupSession(session)).toBeDefined();
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it("answers unknown_account for an account that does not exist, writing nothing", async () => {
    const caller = await admin();
    const events = await instanceEvents();

    expect(await both(caller, freshId(), { isInstanceAdmin: true, disabled: true })).toEqual({ kind: "unknown_account" });
    expect(await instanceEvents()).toEqual(events);
  });
});

/** How many backends of this database wait for a lock. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilWaiting(backends: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) < backends) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function settle<T>(work: Promise<T>): Promise<{ readonly value: T } | { readonly error: unknown }> {
  return work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function errorCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string") {
      return code;
    }
    current = cause;
  }
  return undefined;
}

describe("changes to the set of admins that race", () => {
  it(
    "two admins who clear each other's flag at once leave one: the second waits for the first's rows and is refused once the first's change is committed",
    async () => {
      const first = await admin();
      const second = await admin();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const firstDone = new Promise<void>((resolve) => {
        held = resolve;
      });
      // The first admin's demotion of the second has done its work and holds the lock of the set of admins; it commits only once the other is waiting.
      const demotingSecond = settle(
        withTenant(first, async (tx) => {
          const result = await setAdminIn(tx, second, false);
          held();
          await released;
          return result;
        }),
      );
      await firstDone;
      let demotingFirst: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      try {
        demotingFirst = settle(setAdmin(second, first, false));
        await waitUntilWaiting(1, "the second demotion");
      } finally {
        release();
      }

      const [one, other] = await Promise.all([demotingSecond, demotingFirst]);

      expect(one).toMatchObject({ value: { kind: "changed" } });
      // The second admin is no admin any more by the time it holds its rows, which is what it is refused for.
      expect(other).toHaveProperty("error");
      expect(errorCode((other as { error: unknown }).error)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await adminCount()).toBe(1);
      expect(await stateOf(first)).toEqual({ is_instance_admin: true, disabled: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an admin who disables the other while the other clears the first's flag leave one enabled admin: the disabled admin is refused as a caller",
    async () => {
      const first = await admin();
      const second = await admin();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const firstDone = new Promise<void>((resolve) => {
        held = resolve;
      });
      const disablingSecond = settle(
        withTenant(first, async (tx) => {
          const result = await setDisabledIn(tx, second, true);
          held();
          await released;
          return result;
        }),
      );
      await firstDone;
      let demotingFirst: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      try {
        demotingFirst = settle(setAdmin(second, first, false));
        await waitUntilWaiting(1, "the demotion");
      } finally {
        release();
      }

      const [disabled, demoted] = await Promise.all([disablingSecond, demotingFirst]);

      // The second admin's own check passed before the disabling committed; once it holds its rows it is disabled and refused.
      expect(disabled).toMatchObject({ value: { kind: "changed" } });
      expect(demoted).toHaveProperty("error");
      expect(errorCode((demoted as { error: unknown }).error)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await stateOf(first)).toEqual({ is_instance_admin: true, disabled: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "admins who clear each other's flag, with nothing holding either back, never deadlock and never leave fewer than one admin",
    async () => {
      for (let round = 0; round < 10; round += 1) {
        const first = await admin();
        const second = await admin();
        // The suite's other admins are not in the way: only these two hold the flag.
        await db.owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin AND id NOT IN (${first}, ${second})`;
        });

        const outcomes = await Promise.all([settle(setAdmin(first, second, false)), settle(setAdmin(second, first, false))]);

        for (const outcome of outcomes) {
          if ("error" in outcome) {
            expect(errorCode(outcome.error)).toBe(INSUFFICIENT_PRIVILEGE);
          }
        }
        const changed = outcomes.filter((outcome) => "value" in outcome && outcome.value.kind === "changed");
        expect(changed).toHaveLength(1);
        expect(await adminCount()).toBe(1);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an admin who clears their own flag while the other admin deletes their account is refused once the deletion commits",
    async () => {
      const demoting = await admin();
      const deleting = await admin();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const deletionDone = new Promise<void>((resolve) => {
        held = resolve;
      });
      // The deletion has read the demoting admin as another admin, holds the lock of the set of admins and has deleted the row.
      const deletion = settle(
        withTenant(deleting, async (tx) => {
          const repository = accountDeletionRepository(tx);
          const { blocking, soleMember, lastInstanceAdmin } = await repository.scope();
          if (lastInstanceAdmin || blocking.length > 0) {
            return false;
          }
          const deleted = await repository.delete(
            soleMember.map((workspace) => workspace.id),
            [],
          );
          held();
          await released;
          return deleted;
        }),
      );
      await deletionDone;
      let demotion: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      try {
        demotion = settle(setAdmin(demoting, demoting, false));
        await waitUntilWaiting(1, "the demotion");
      } finally {
        release();
      }

      const [deleted, demoted] = await Promise.all([deletion, demotion]);

      expect(deleted).toEqual({ value: true });
      expect(demoted).toEqual({ value: { kind: "last_instance_admin" } });
      expect(await stateOf(deleting)).toBeUndefined();
      expect(await stateOf(demoting)).toEqual({ is_instance_admin: true, disabled: false });
      expect(await adminCount()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
