import type { InstanceAccountDeletionScope } from "@slugbase/core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountDeletionRepository, instanceRepository, type TenantTx } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The deletion of an account by an instance admin (doc 05 sections 3.3 and 7.1, doc 02 sections 2.10 and 11.2, doc 10
// T1 and T18): sys_instance_account_deletion_scope and sys_instance_delete_account. The failure scenarios: a caller that
// is not an instance admin with a second factor that reaches either function; a sole owner of a workspace with other
// members that is deleted and leaves the workspace without an owner; the last instance admin that is deleted, alone
// or by a request that races another admin's demotion or deletion; a row that still holds the deleted account's
// address, or its identifier anywhere but in the one instance event that records the deletion; an event that names the
// account's address; and a deletion that races a backup-code sign-in, a demotion or a self-deletion and ends in a
// deadlock error or in no admin.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const INSUFFICIENT_PRIVILEGE = "42501";
const DEADLOCK_DETECTED = "40P01";
const WORKSPACE_QUEUE = "workspace.delete";
const EVENT_QUEUE = "event.account.deleted";
const PREFIX = "10.1.0.0/16";
const SECRET = Buffer.from("sealed-totp-secret");

let db: TestDatabase;
/** The superuser of the test server on the test database, which reads every table whatever its row-level security. */
let reader: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  const url = new URL(process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev");
  url.pathname = `/${db.name}`;
  reader = postgres(url.toString(), { max: 1, onnotice: () => undefined });
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
    INSERT INTO pgboss.queue VALUES
      ('${WORKSPACE_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL),
      ('${EVENT_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await reader.end({ timeout: 5 });
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  await asSystem(db, (tx) => tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`);
});

let counter = 0;

interface Person {
  readonly id: string;
  readonly email: string;
}

interface Options {
  readonly admin?: boolean;
  readonly mfa?: boolean;
  readonly disabled?: boolean;
}

async function person(options: Options = {}): Promise<Person> {
  counter += 1;
  const id = freshId();
  const email = `instance-deletion-${String(counter)}@example.test`;
  await seedAccount(db, { id, email, passwordHash: "$argon2id$stub", isInstanceAdmin: options.admin === true, disabledAt: options.disabled === true ? new Date() : null, emailVerified: true });
  if (options.mfa === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${SECRET}, mfa_secret_key_id = 'key-1', mfa_last_step = 42 WHERE id = ${id}`;
    });
  }
  return { id, email };
}

/** An instance admin with a second factor: the only account the instance operations admit. */
const admin = (options: Omit<Options, "admin" | "mfa"> = {}): Promise<Person> => person({ ...options, admin: true, mfa: true });

async function instanceAdmins(): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts WHERE is_instance_admin ORDER BY id`);
  return rows.map((row) => row.id);
}

async function workspaceOf(name: string, ...members: readonly (readonly [Person, Role])[]): Promise<string> {
  const workspaceId = await seedWorkspace(db, { name });
  for (const [member, role] of members) {
    await seedMember(db, { workspaceId, accountId: member.id, role });
  }
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
  });
  return workspaceId;
}

/** Rows that are the account's own and cascade from it: an identity, an emailed token, two backup codes and a session. */
async function seedPersonalRows(subject: Person): Promise<void> {
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${freshId()}, ${subject.id}, 'idp', ${`sub-${subject.id}`}, ${subject.email})`;
    await tx`
      INSERT INTO credential_tokens (id, purpose, account_id, token_hash, target_email, expires_at)
      VALUES (${freshId()}, 'email_change', ${subject.id}, ${freshToken().hash}, ${subject.email}, now() + interval '1 day')`;
    await tx`INSERT INTO mfa_backup_codes (id, account_id, code_hash) VALUES (${freshId()}, ${subject.id}, ${Buffer.from("hash-1")}), (${freshId()}, ${subject.id}, ${Buffer.from("hash-2")})`;
    await tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
      VALUES (${freshId()}, ${freshToken().hash}, ${subject.id}, 'full', false, now() + interval '1 day', now() + interval '2 days')`;
  });
}

async function seedMemberEvent(workspaceId: string, actor: Person, target: Person): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
      VALUES (${id}, ${workspaceId}, 'account', ${actor.id}, 'Grace', 'member.removed', 'member', ${target.id}, ${JSON.stringify({ content: "transfer", transferTo: target.id })}::text::jsonb, ${PREFIX})`,
  );
  return id;
}

/** An earlier instance event about the account, as `sys_instance_update_account` writes one. */
async function seedInstanceEvent(actor: Person, target: Person): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata)
      VALUES (${id}, NULL, 'account', ${actor.id}, 'Test account', 'instance.account_disabled', 'account', ${target.id}, '{}'::jsonb)`,
  );
  return id;
}

function withTenant<T>(accountId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "instance-account-deletion-test" }, work);
}

function eventJob(accountId: string) {
  const eventId = freshId();
  return { id: eventId, queue: EVENT_QUEUE, data: { eventId, accountId } };
}

interface Attempt {
  readonly outcome: string;
  readonly scope: InstanceAccountDeletionScope;
  readonly sole: readonly string[];
}

/** What the route does: the scope, then the deletion with the jobs the sole workspaces and the event need. */
async function deleteAs(callerId: string, target: Person): Promise<Attempt & { readonly eventId: string }> {
  const eventId = freshId();
  return withTenant(callerId, async (tx) => {
    const repository = instanceRepository(tx);
    const scope = await repository.accountDeletionScope(target.id);
    if (scope.kind !== "ok") {
      return { outcome: scope.kind, scope, sole: [], eventId };
    }
    if (scope.blocking.length > 0) {
      return { outcome: "last_owner", scope, sole: [], eventId };
    }
    const sole = scope.soleMember.map((workspace) => workspace.id);
    const outcome = await repository.deleteAccount({ accountId: target.id, soleWorkspaceIds: sole, eventId, ipPrefix: PREFIX }, [
      ...sole.map((workspaceId) => ({ id: freshId(), queue: WORKSPACE_QUEUE, data: { workspaceId } })),
      eventJob(target.id),
    ]);
    return { outcome, scope, sole, eventId };
  });
}

async function queued(name: string): Promise<Record<string, unknown>[]> {
  const rows = await db.owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY id`;
  return rows.map((row) => row.data);
}

const TABLES = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name";

/** One digest of the rows of every table of the schema, so a change anywhere shows. */
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const { table_name } of await reader.unsafe<{ table_name: string }[]>(TABLES)) {
    const [row] = await reader.unsafe<{ digest: string }[]>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM public."${table_name}" t`);
    result[table_name] = row?.digest ?? "";
  }
  return result;
}

/** The tables with a row that mentions `needle` in any column. */
async function tablesHolding(needle: string): Promise<string[]> {
  const holding: string[] = [];
  for (const { table_name } of await reader.unsafe<{ table_name: string }[]>(TABLES)) {
    const [row] = await reader.unsafe<{ found: number }[]>(`SELECT count(*)::int AS found FROM public."${table_name}" t WHERE t::text ILIKE '%' || $1 || '%'`, [needle]);
    if ((row?.found ?? 0) > 0) {
      holding.push(table_name);
    }
  }
  return holding;
}

interface InstanceEvent {
  readonly id: string;
  readonly actor_account_id: string | null;
  readonly actor_label: string;
  readonly action: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly ip_prefix: string | null;
}

/** The instance events of `action` that name one of `accountIds` as their entity, so the events of other tests are not seen. */
async function instanceEvents(action: string, ...accountIds: readonly string[]): Promise<InstanceEvent[]> {
  return asSystem(
    db,
    (tx) => tx<InstanceEvent[]>`
      SELECT id, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix::text AS ip_prefix
      FROM audit_events WHERE workspace_id IS NULL AND action = ${action} AND entity_id IN ${tx(accountIds)} ORDER BY created_at, id`,
  );
}

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

async function refusedWith(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return errorCode(error);
  }
  return undefined;
}

describe("deleting another account as an instance admin", () => {
  it("deletes the account the way DELETE /me does, leaves its identifier only in the instance event and its address nowhere, and queues the jobs and the event", async () => {
    const caller = await admin();
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const ownToo = await workspaceOf("Ada's second", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "admin"]);
    await seedPersonalRows(ada);
    await seedPersonalRows(grace);
    const earlier = await seedInstanceEvent(caller, ada);
    const removed = await seedMemberEvent(shared, grace, ada);
    expect(await tablesHolding(ada.email)).toEqual(expect.arrayContaining(["accounts", "account_identities", "credential_tokens"]));
    expect(await tablesHolding(ada.id)).toEqual(expect.arrayContaining(["accounts", "audit_events", "mfa_backup_codes", "sessions", "workspace_members"]));

    const { outcome, sole, eventId } = await deleteAs(caller.id, ada);

    expect(outcome).toBe("deleted");
    expect(sole).toEqual([own, ownToo].sort());
    // the address is gone everywhere; the identifier survives in one row: the instance event that records the deletion
    expect(await tablesHolding(ada.email)).toEqual([]);
    expect(await tablesHolding(ada.id)).toEqual(["audit_events"]);
    const events = await instanceEvents("instance.account_deleted", ada.id);
    expect(events).toEqual([
      { id: eventId, actor_account_id: caller.id, actor_label: "Test account", action: "instance.account_deleted", entity_type: "account", entity_id: ada.id, metadata: {}, ip_prefix: PREFIX },
    ]);
    // the earlier events about the account lose its identifier, as they do when the account deletes itself
    const lost = await asSystem(db, (tx) => tx<{ id: string; entity_id: string | null; metadata: Record<string, unknown> }[]>`SELECT id, entity_id, metadata FROM audit_events WHERE id IN (${earlier}, ${removed}) ORDER BY id`);
    expect(Object.fromEntries(lost.map((event) => [event.id, event]))).toMatchObject({
      [earlier]: { entity_id: null },
      [removed]: { entity_id: null, metadata: { content: "transfer" } },
    });
    expect(lost.find((event) => event.id === removed)?.metadata).not.toHaveProperty("transferTo");
    // the sole workspaces are marked, the shared one keeps its other members, and the other account is untouched
    const marked = await asSystem(db, (tx) => tx<{ id: string; deleting: boolean }[]>`SELECT id, deleting_at IS NOT NULL AS deleting FROM workspaces ORDER BY id`);
    expect(Object.fromEntries(marked.map((row) => [row.id, row.deleting]))).toMatchObject({ [own]: true, [ownToo]: true, [shared]: false });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspace_members WHERE workspace_id = ${shared} AND account_id = ${grace.id}`)).toHaveLength(1);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM account_identities WHERE account_id = ${grace.id}`)).toHaveLength(1);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM mfa_backup_codes WHERE account_id = ${grace.id}`)).toHaveLength(2);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM accounts WHERE id = ${caller.id}`)).toHaveLength(1);
    expect((await queued(WORKSPACE_QUEUE)).map((data) => data["workspaceId"]).sort()).toEqual([own, ownToo].sort());
    expect((await queued(EVENT_QUEUE)).map((data) => data["accountId"])).toEqual([ada.id]);
  });

  it("deletes a disabled account and another instance admin while an enabled admin remains", async () => {
    const caller = await admin();
    const disabled = await person({ disabled: true });
    const other = await admin();
    await seedPersonalRows(disabled);

    expect((await deleteAs(caller.id, disabled)).outcome).toBe("deleted");
    expect((await deleteAs(caller.id, other)).outcome).toBe("deleted");

    expect(await instanceAdmins()).toEqual([caller.id]);
    expect((await instanceEvents("instance.account_deleted", disabled.id, other.id)).map((event) => event.entity_id).sort()).toEqual([disabled.id, other.id].sort());
  });

  it("answers an account that does not exist with unknown_account and writes and queues nothing", async () => {
    const caller = await admin();
    const before = await snapshot();

    const { outcome } = await deleteAs(caller.id, { id: freshId(), email: "nobody@example.test" });

    expect(outcome).toBe("unknown_account");
    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });

  it("blocks a sole owner of a workspace that has other members, names that workspace, and changes, writes and queues nothing", async () => {
    const caller = await admin();
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const shared = await workspaceOf("Ada's team", [ada, "owner"], [grace, "admin"]);
    const second = await workspaceOf("Ada's club", [ada, "owner"], [grace, "member"]);
    await seedPersonalRows(ada);
    const before = await snapshot();

    const attempt = await deleteAs(caller.id, ada);

    expect(attempt.outcome).toBe("last_owner");
    expect(attempt.scope).toMatchObject({ kind: "ok", blocking: [{ id: shared }, { id: second }].sort((a, b) => a.id.localeCompare(b.id)), soleMember: [{ id: own }] });
    expect(await snapshot()).toEqual(before);
    // the function refuses too, whatever the caller read: the rule is the database's
    const direct = await withTenant(caller.id, (tx) => instanceRepository(tx).deleteAccount({ accountId: ada.id, soleWorkspaceIds: [own], eventId: freshId(), ipPrefix: null }, [eventJob(ada.id)]));
    expect(direct).toBe("unavailable");
    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
    expect(await instanceEvents("instance.account_deleted", ada.id)).toEqual([]);
    // once another member is an owner of each, the account may go and the workspaces keep an owner
    await asSystem(db, (tx) => tx`UPDATE workspace_members SET role = 'owner' WHERE workspace_id IN (${shared}, ${second}) AND account_id = ${grace.id}`);
    expect((await deleteAs(caller.id, ada)).outcome).toBe("deleted");
    const owners = await asSystem(db, (tx) => tx<{ workspace_id: string }[]>`SELECT workspace_id FROM workspace_members WHERE role = 'owner' AND workspace_id IN (${shared}, ${second})`);
    expect(owners.map((row) => row.workspace_id).sort()).toEqual([shared, second].sort());
  });

  it("refuses a list of sole workspaces that is not the scope, and changes and writes nothing", async () => {
    const caller = await admin();
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    const graces = await workspaceOf("Grace's own", [grace, "owner"]);
    const before = await snapshot();

    for (const ids of [[], [own, graces], [graces], [shared], [own, shared]]) {
      const answer = await withTenant(caller.id, (tx) => instanceRepository(tx).deleteAccount({ accountId: ada.id, soleWorkspaceIds: ids, eventId: freshId(), ipPrefix: null }, [eventJob(ada.id)]));
      expect(answer).toBe("unavailable");
    }
    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
    const accepted = await withTenant(caller.id, (tx) => instanceRepository(tx).deleteAccount({ accountId: ada.id, soleWorkspaceIds: [own, own], eventId: freshId(), ipPrefix: null }, []));
    expect(accepted).toBe("deleted");
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspaces WHERE id = ${graces} AND deleting_at IS NULL`)).toHaveLength(1);
  });

  it("is one transaction: a failure after the deletion leaves the account, its workspaces, the instance stream and the queue as they were", async () => {
    const caller = await admin();
    const ada = await person();
    await workspaceOf("Ada's own", [ada, "owner"]);
    await seedPersonalRows(ada);
    const before = await snapshot();

    await expect(
      withTenant(caller.id, async (tx) => {
        const repository = instanceRepository(tx);
        const scope = await repository.accountDeletionScope(ada.id);
        const sole = scope.kind === "ok" ? scope.soleMember.map((workspace) => workspace.id) : [];
        expect(await repository.deleteAccount({ accountId: ada.id, soleWorkspaceIds: sole, eventId: freshId(), ipPrefix: PREFIX }, [eventJob(ada.id)])).toBe("deleted");
        throw new Error("the request failed after the deletion");
      }),
    ).rejects.toThrow("the request failed after the deletion");

    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });
});

describe("the last instance admin", () => {
  it("is refused when it asks to delete its own account, and the account, the flag and every row stay", async () => {
    const only = await admin();
    const member = await person();
    const own = await workspaceOf("Admin's own", [only, "owner"]);
    await workspaceOf("Shared", [member, "owner"], [only, "member"]);
    await seedPersonalRows(only);
    const before = await snapshot();

    const attempt = await deleteAs(only.id, only);

    expect(attempt.outcome).toBe("last_instance_admin");
    // the function refuses too, whatever the caller read
    const direct = await withTenant(only.id, (tx) => instanceRepository(tx).deleteAccount({ accountId: only.id, soleWorkspaceIds: [own], eventId: freshId(), ipPrefix: null }, [eventJob(only.id)]));
    expect(direct).toBe("last_instance_admin");
    expect(await snapshot()).toEqual(before);
    expect(await instanceAdmins()).toEqual([only.id]);
    expect(await queued(WORKSPACE_QUEUE)).toEqual([]);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });

  it("counts only enabled admins as another: a disabled admin does not make the enabled one deletable", async () => {
    const enabled = await admin();
    await admin({ disabled: true });
    const before = await snapshot();

    expect((await deleteAs(enabled.id, enabled)).outcome).toBe("last_instance_admin");
    expect(await snapshot()).toEqual(before);
    expect(await instanceAdmins()).toHaveLength(2);
  });

  it("refuses the calling admin's own account as self while another enabled admin remains, and leaves it to DELETE /me", async () => {
    const caller = await admin();
    await admin();
    const before = await snapshot();

    const attempt = await deleteAs(caller.id, caller);

    expect(attempt.outcome).toBe("self");
    expect(await withTenant(caller.id, (tx) => instanceRepository(tx).deleteAccount({ accountId: caller.id, soleWorkspaceIds: [], eventId: freshId(), ipPrefix: null }, []))).toBe("self");
    expect(await snapshot()).toEqual(before);
  });

  it("survives an admin who deletes the other while that one demotes it: the demotion raises once the other is gone, and one admin stays", async () => {
    const first = await admin();
    const second = await admin();
    await workspaceOf("Second's own", [second, "owner"]);
    let scoped: () => void = () => undefined;
    const holdsLocks = new Promise<void>((resolve) => {
      scoped = resolve;
    });
    let proceed: () => void = () => undefined;
    const mayDelete = new Promise<void>((resolve) => {
      proceed = resolve;
    });

    // The first admin reads the scope of the second, and so holds the rows of both and the advisory key, and waits for the second's demotion to queue.
    const deleting = settle(
      withTenant(first.id, async (tx) => {
        const repository = instanceRepository(tx);
        const scope = await repository.accountDeletionScope(second.id);
        scoped();
        await mayDelete;
        const sole = scope.kind === "ok" ? scope.soleMember.map((workspace) => workspace.id) : [];
        return repository.deleteAccount({ accountId: second.id, soleWorkspaceIds: sole, eventId: freshId(), ipPrefix: null }, []);
      }),
    );
    await holdsLocks;
    let demoting: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
    try {
      demoting = settle(
        withTenant(second.id, (tx) =>
          instanceRepository(tx).updateAccount(first.id, { isInstanceAdmin: false }, { admin: freshId(), disabled: freshId(), verified: freshId() }, null, []),
        ),
      );
      await waitUntilWaiting(1, "the demotion");
    } finally {
      proceed();
    }

    const [deleted, demoted] = await Promise.all([deleting, demoting]);

    expect(deleted).toEqual({ value: "deleted" });
    expect(errorCode((demoted as { error: unknown }).error)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await instanceAdmins()).toEqual([first.id]);
  });

  it("survives an admin who deletes the other while that other deletes itself: the self-deletion reads the deletion and is refused", async () => {
    const caller = await admin();
    const other = await admin();
    let scoped: () => void = () => undefined;
    const holdsLocks = new Promise<void>((resolve) => {
      scoped = resolve;
    });
    let proceed: () => void = () => undefined;
    const mayDelete = new Promise<void>((resolve) => {
      proceed = resolve;
    });

    const deleting = settle(
      withTenant(caller.id, async (tx) => {
        const repository = instanceRepository(tx);
        await repository.accountDeletionScope(other.id);
        scoped();
        await mayDelete;
        return repository.deleteAccount({ accountId: other.id, soleWorkspaceIds: [], eventId: freshId(), ipPrefix: null }, []);
      }),
    );
    await holdsLocks;
    let selfDeleting: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
    try {
      // The caller also deletes itself through DELETE /me, in a second transaction of its own.
      selfDeleting = settle(
        withTenant(caller.id, async (tx) => {
          const repository = accountDeletionRepository(tx);
          const scope = await repository.scope();
          return { lastInstanceAdmin: scope.lastInstanceAdmin, deleted: scope.lastInstanceAdmin ? false : await repository.delete([], []) };
        }),
      );
      await waitUntilWaiting(1, "the self-deletion");
    } finally {
      proceed();
    }

    expect(await deleting).toEqual({ value: "deleted" });
    expect(await selfDeleting).toEqual({ value: { lastInstanceAdmin: true, deleted: false } });
    expect(await instanceAdmins()).toEqual([caller.id]);
  });
});

describe("the advisory key of the set of admins", () => {
  /** Holds the transaction-level advisory lock of the set of admins until `release` is called, as another path that changes the set does. */
  async function holdingTheKey<T>(whileHeld: () => Promise<T>, waits: boolean): Promise<T> {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = settle(
      db.owner.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('slugbase.instance_admins'))`;
        held();
        await released;
      }),
    );
    await holding;
    const work = settle(whileHeld());
    try {
      if (waits) {
        await waitUntilWaiting(1, "the deletion");
      }
    } finally {
      release();
    }
    const [, outcome] = await Promise.all([holder, work]);
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  it("is taken for the deletion of an instance admin, which waits for whoever holds it and then deletes", async () => {
    const caller = await admin();
    const target = await admin();

    const attempt = await holdingTheKey(() => deleteAs(caller.id, target), true);

    expect(attempt.outcome).toBe("deleted");
    expect(await instanceAdmins()).toEqual([caller.id]);
  }, TEST_TIMEOUT_MS);

  it("is not taken for the deletion of an account that is not an admin, which does not wait", async () => {
    const caller = await admin();
    const target = await person();

    const attempt = await holdingTheKey(() => deleteAs(caller.id, target), false);

    expect(attempt.outcome).toBe("deleted");
  }, TEST_TIMEOUT_MS);
});

describe("who may delete", () => {
  it("raises insufficient_privilege for a caller that is not an instance admin with a second factor, in both functions, and changes nothing", async () => {
    const target = await person();
    const callers = {
      plain: await person(),
      withoutSecondFactor: await person({ admin: true }),
      disabledAdmin: await admin({ disabled: true }),
    };
    await admin();
    const before = await snapshot();

    for (const caller of Object.values(callers)) {
      expect(await refusedWith(withTenant(caller.id, (tx) => instanceRepository(tx).accountDeletionScope(target.id)))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await refusedWith(withTenant(caller.id, (tx) => instanceRepository(tx).deleteAccount({ accountId: target.id, soleWorkspaceIds: [], eventId: freshId(), ipPrefix: null }, [eventJob(target.id)]))),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // no account at all in the transaction
    expect(await refusedWith(db.app.begin((tx) => tx`SELECT * FROM sys_instance_account_deletion_scope(${target.id}::uuid)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(db.app.begin((tx) => tx`SELECT sys_instance_delete_account(${freshId()}::uuid, NULL::cidr, ${target.id}::uuid, '{}'::uuid[])`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });

  it("gives slugbase_app no call of the clean-up itself: it is reached only through the functions that vouch for the caller", async () => {
    const target = await person();
    const before = await snapshot();
    expect(await refusedWith(db.app`SELECT public.account_delete(${target.id}::uuid, '{}'::uuid[])`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await snapshot()).toEqual(before);
  });
});

describe("the order of the locks of a deletion", () => {
  /**
   * A backup-code sign-in holds the account's code rows and then asks for its row (sys_session_promote). The test holds the
   * codes, lets the deletion queue, and then asks for the account row, as the sign-in does: a deletion that had locked the
   * account row first would wait for the codes while the sign-in waits for the row.
   */
  async function against(subject: Person, startDeletion: () => Promise<unknown>): Promise<{ readonly signIn: unknown; readonly deletion: unknown }> {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const signIn = settle(
      db.owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`SELECT 1 FROM mfa_backup_codes WHERE account_id = ${subject.id} ORDER BY id FOR UPDATE`;
        held();
        await released;
        await tx`SELECT 1 FROM accounts WHERE id = ${subject.id} FOR UPDATE`;
      }),
    );
    await holding;
    let deletion: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
    try {
      deletion = settle(startDeletion());
      await waitUntilWaiting(1, "the deletion");
    } finally {
      release();
    }
    const [signInOutcome, deletionOutcome] = await Promise.all([signIn, deletion]);
    for (const outcome of [signInOutcome, deletionOutcome]) {
      if ("error" in outcome) {
        expect(errorCode(outcome.error)).not.toBe(DEADLOCK_DETECTED);
      }
    }
    return { signIn: signInOutcome, deletion: deletionOutcome };
  }

  it("waits for a backup-code sign-in on the account the way every writer of those rows does, so an admin's deletion and the sign-in both complete", async () => {
    const caller = await admin();
    const subject = await person({ mfa: true });
    await seedPersonalRows(subject);
    await workspaceOf("Subject's own", [subject, "owner"]);

    const { signIn, deletion } = await against(subject, () => deleteAs(caller.id, subject));

    expect(signIn).toEqual({ value: undefined });
    expect(deletion).toMatchObject({ value: { outcome: "deleted" } });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM accounts WHERE id = ${subject.id}`)).toHaveLength(0);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM mfa_backup_codes WHERE account_id = ${subject.id}`)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("waits for a backup-code sign-in on the account when the account deletes itself, so both complete", async () => {
    const subject = await person({ mfa: true });
    await seedPersonalRows(subject);
    await workspaceOf("Subject's own", [subject, "owner"]);

    const { signIn, deletion } = await against(subject, () =>
      withTenant(subject.id, async (tx) => {
        const repository = accountDeletionRepository(tx);
        const { soleMember } = await repository.scope();
        return repository.delete(
          soleMember.map((workspace) => workspace.id),
          [],
        );
      }),
    );

    expect(signIn).toEqual({ value: undefined });
    expect(deletion).toEqual({ value: true });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM accounts WHERE id = ${subject.id}`)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("completes when the account deletes itself while an admin deletes it: one deletes and the other finds it gone, with no deadlock", async () => {
    const caller = await admin();
    const subject = await person({ mfa: true });
    await seedPersonalRows(subject);
    await workspaceOf("Subject's own", [subject, "owner"]);

    const outcomes = await Promise.all([
      settle(deleteAs(caller.id, subject)),
      settle(
        withTenant(subject.id, async (tx) => {
          const repository = accountDeletionRepository(tx);
          const { soleMember } = await repository.scope();
          return repository.delete(
            soleMember.map((workspace) => workspace.id),
            [],
          );
        }),
      ),
    ]);

    for (const outcome of outcomes) {
      if ("error" in outcome) {
        expect(errorCode(outcome.error)).not.toBe(DEADLOCK_DETECTED);
      }
    }
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM accounts WHERE id = ${subject.id}`)).toHaveLength(0);
    expect((await instanceEvents("instance.account_deleted", subject.id)).length).toBeLessThanOrEqual(1);
  }, TEST_TIMEOUT_MS);
});
