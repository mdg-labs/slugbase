import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountDeletionRepository, apiTokenRepository, workspaceRepository } from "../src/index.ts";
import { bindWorkspaceDeletionStore } from "../src/system/workspace-deletion.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// Deleting an account (doc 05 sections 3.3 and 7.1, doc 02 section 2.10, doc 10 T1). The failure scenarios: a
// row that still holds the account's identifier or address after the deletion; another account's data, or a
// workspace the account did not belong to, that changes with it; a sole owner of a workspace with other members
// that is deleted and leaves the workspace without an owner; a workspace where the account was the only member that
// outlives it unmarked; and an account that another account, or a request acting in a workspace, can delete.

const HOOK_TIMEOUT_MS = 300_000;
const WORKSPACE_QUEUE = "workspace.delete";
const EVENT_QUEUE = "event.account.deleted";
const PREFIX = "10.1.0.0/16";

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
  await asSystem(db, (tx) => tx`UPDATE accounts SET is_instance_admin = false`);
});

let counter = 0;

interface Person {
  readonly id: string;
  readonly email: string;
}

async function person(isInstanceAdmin = false): Promise<Person> {
  counter += 1;
  const id = freshId();
  const email = `deletion-subject-${String(counter)}@example.test`;
  await seedAccount(db, { id, email, passwordHash: "$argon2id$stub", isInstanceAdmin });
  return { id, email };
}

/** The accounts that hold the instance-admin flag, by identifier. */
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

async function seedEvent(workspaceId: string, actor: Person | null, label: string, ipPrefix: string | null): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, ip_prefix)
      VALUES (${id}, ${workspaceId}, ${actor === null ? "system" : "account"}, ${actor?.id ?? null}, ${label}, 'workspace.renamed', ${ipPrefix})`,
  );
  return id;
}

/** An event of the catalog that names `targetId` as its target (`entity_id`) and carries `metadata`, made by `actor`. */
async function seedTargetEvent(workspaceId: string, actor: Person, action: string, targetId: string, metadata: Record<string, string>): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata)
      VALUES (${id}, ${workspaceId}, 'account', ${actor.id}, 'Grace', ${action}, 'member', ${targetId}, ${JSON.stringify(metadata)}::text::jsonb)`,
  );
  return id;
}

async function seedToken(accountId: string, workspaceId: string): Promise<string> {
  const id = freshId();
  const outcome = await inTenant({ accountId }, (tx) =>
    apiTokenRepository(tx).create({ id, workspaceId, name: `CI ${id}`, scope: "read", tokenHash: freshToken().hash, tokenPrefix: "abcdef", expiresInDays: 90, limit: 10 }),
  );
  expect(outcome.kind).toBe("created");
  return id;
}

async function seedSession(accountId: string, activeWorkspaceId: string | null): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, active_workspace_id, remember, expires_at, absolute_expires_at)
      VALUES (${id}, ${freshToken().hash}, ${accountId}, 'full', ${activeWorkspaceId}, false, now() + interval '1 day', now() + interval '2 days')`,
  );
  return id;
}

/** Rows that are the account's own and cascade from it: an identity, an emailed token and a backup code. */
async function seedPersonalRows(subject: Person): Promise<void> {
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${freshId()}, ${subject.id}, 'idp', ${`sub-${subject.id}`}, ${subject.email})`;
    await tx`
      INSERT INTO credential_tokens (id, purpose, account_id, token_hash, target_email, expires_at)
      VALUES (${freshId()}, 'email_change', ${subject.id}, ${freshToken().hash}, ${subject.email}, now() + interval '1 day')`;
    await tx`INSERT INTO mfa_backup_codes (id, account_id, code_hash) VALUES (${freshId()}, ${subject.id}, ${Buffer.from("hash")})`;
  });
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "account-deletion-test" }, work);
}

function eventJob(accountId: string) {
  const eventId = freshId();
  return { id: eventId, queue: EVENT_QUEUE, data: { eventId, accountId } };
}

/** What the route does: the scope, then the deletion with the jobs the sole workspaces and the event need. */
async function deleteAccount(subject: Person): Promise<{ readonly deleted: boolean; readonly blocking: readonly string[]; readonly sole: readonly string[] }> {
  return inTenant({ accountId: subject.id }, async (tx) => {
    const repository = accountDeletionRepository(tx);
    const { blocking, soleMember, lastInstanceAdmin } = await repository.scope();
    const sole = soleMember.map((workspace) => workspace.id);
    const deleted =
      !lastInstanceAdmin &&
      blocking.length === 0 &&
      (await repository.delete(sole, [...sole.map((workspaceId) => ({ id: freshId(), queue: WORKSPACE_QUEUE, data: { workspaceId } })), eventJob(subject.id)]));
    return { deleted, blocking: blocking.map((workspace) => workspace.id), sole };
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

describe("deleting an account", () => {
  it("leaves no row that holds the account's identifier or address but the audit events that name it as their actor, which keep their label and lose the reference and the network", async () => {
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const ownToo = await workspaceOf("Ada's second", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "admin"]);
    const coOwned = await workspaceOf("Co-owned", [grace, "owner"], [ada, "owner"]);
    await seedToken(ada.id, own);
    await seedToken(ada.id, shared);
    await seedToken(grace.id, shared);
    const adaSession = await seedSession(ada.id, own);
    const graceSession = await seedSession(grace.id, shared);
    await seedPersonalRows(ada);
    await seedPersonalRows(grace);
    const inShared = await seedEvent(shared, ada, "Ada", PREFIX);
    const inOwn = await seedEvent(own, ada, "Ada", PREFIX);
    const graces = await seedEvent(shared, grace, "Grace", PREFIX);
    const system = await seedEvent(shared, null, "System", null);
    const heidi = await person();
    const promoted = await seedTargetEvent(shared, grace, "member.role_changed", ada.id, { from: "member", to: "admin" });
    const removedHeidi = await seedTargetEvent(shared, grace, "member.removed", heidi.id, { content: "transfer", transferTo: ada.id });
    const removedAda = await seedTargetEvent(shared, grace, "member.removed", ada.id, { content: "transfer", transferTo: grace.id });
    const gracesTarget = await seedTargetEvent(shared, grace, "member.role_changed", grace.id, { from: "member", to: "admin" });
    const adaBefore = await tablesHolding(ada.id);
    expect(adaBefore.length).toBeGreaterThan(5);
    expect(await tablesHolding(ada.email)).toEqual(expect.arrayContaining(["accounts", "account_identities", "credential_tokens"]));
    const sharedMembership = await asSystem(db, (tx) => tx`SELECT 1 FROM workspace_members WHERE workspace_id = ${shared} AND account_id = ${grace.id}`);
    expect(sharedMembership).toHaveLength(1);

    const outcome = await deleteAccount(ada);

    expect(outcome).toEqual({ deleted: true, blocking: [], sole: [own, ownToo].sort() });
    expect(await tablesHolding(ada.id)).toEqual([]);
    expect(await tablesHolding(ada.email)).toEqual([]);
    // the events that name the account as their target lose the identifier and keep their type, label and the rest of their metadata
    const targets = await asSystem(
      db,
      (tx) => tx<{ id: string; action: string; actor_label: string; entity_type: string | null; entity_id: string | null; metadata: Record<string, string> }[]>`SELECT id, action, actor_label, entity_type, entity_id, metadata FROM audit_events WHERE id IN (${promoted}, ${removedHeidi}, ${removedAda}, ${gracesTarget})`,
    );
    const target = Object.fromEntries(targets.map((event) => [event.id, event]));
    expect(target[promoted]).toMatchObject({ action: "member.role_changed", actor_label: "Grace", entity_type: "member", entity_id: null, metadata: { from: "member", to: "admin" } });
    expect(target[removedHeidi]).toMatchObject({ action: "member.removed", entity_id: heidi.id, metadata: { content: "transfer" } });
    expect(target[removedHeidi]?.metadata).not.toHaveProperty("transferTo");
    expect(target[removedAda]).toMatchObject({ entity_id: null, metadata: { content: "transfer", transferTo: grace.id } });
    expect(target[gracesTarget]).toMatchObject({ entity_id: grace.id, metadata: { from: "member", to: "admin" } });
    // the events keep their label and their workspace, and lose the account and the network
    const events = await asSystem(
      db,
      (tx) => tx<{ id: string; actor_account_id: string | null; actor_label: string; ip_prefix: string | null }[]>`SELECT id, actor_account_id, actor_label, ip_prefix::text AS ip_prefix FROM audit_events WHERE id IN (${inShared}, ${graces}, ${system}) ORDER BY id`,
    );
    const byId = Object.fromEntries(events.map((event) => [event.id, event]));
    expect(byId[inShared]).toMatchObject({ actor_account_id: null, actor_label: "Ada", ip_prefix: null });
    expect(byId[graces]).toMatchObject({ actor_account_id: grace.id, actor_label: "Grace", ip_prefix: PREFIX });
    expect(byId[system]).toMatchObject({ actor_account_id: null, actor_label: "System", ip_prefix: null });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM audit_events WHERE id = ${inOwn} AND ip_prefix IS NOT NULL`)).toHaveLength(0);
    // the workspaces where Ada was the only member are marked and their sessions point nowhere; the others keep their members
    const marked = await asSystem(db, (tx) => tx<{ id: string; deleting: boolean }[]>`SELECT id, deleting_at IS NOT NULL AS deleting FROM workspaces ORDER BY id`);
    expect(Object.fromEntries(marked.map((row) => [row.id, row.deleting]))).toMatchObject({ [own]: true, [ownToo]: true, [shared]: false, [coOwned]: false });
    const members = await asSystem(db, (tx) => tx<{ workspace_id: string; account_id: string }[]>`SELECT workspace_id, account_id FROM workspace_members WHERE workspace_id IN (${shared}, ${coOwned}) ORDER BY workspace_id`);
    expect(members.map((row) => row.account_id)).toEqual([grace.id, grace.id]);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM sessions WHERE id = ${adaSession}`)).toHaveLength(0);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM sessions WHERE id = ${graceSession} AND active_workspace_id = ${shared}`)).toHaveLength(1);
    // one deletion job per sole workspace and the event, once
    expect((await queued(WORKSPACE_QUEUE)).map((data) => data["workspaceId"]).sort()).toEqual([own, ownToo].sort());
    expect((await queued(EVENT_QUEUE)).map((data) => data["accountId"])).toEqual([ada.id]);
  });

  it("changes nothing of another account or of a workspace the account did not belong to", async () => {
    const ada = await person();
    const grace = await person();
    const heidi = await person();
    await workspaceOf("Ada's own", [ada, "owner"]);
    await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    const unrelated = await workspaceOf("Heidi's", [heidi, "owner"]);
    const graceOwn = await workspaceOf("Grace's own", [grace, "owner"]);
    await seedToken(grace.id, graceOwn);
    await seedToken(heidi.id, unrelated);
    await seedSession(grace.id, graceOwn);
    await seedSession(heidi.id, unrelated);
    await seedPersonalRows(grace);
    await seedPersonalRows(heidi);
    await seedEvent(unrelated, heidi, "Heidi", PREFIX);
    await seedEvent(graceOwn, grace, "Grace", PREFIX);
    const before = await snapshot();

    expect((await deleteAccount(ada)).deleted).toBe(true);

    const after = await snapshot();
    // only the tables Ada's rows are in differ; the digest of every other table is what it was
    const changed = Object.keys(before).filter((table) => before[table] !== after[table]);
    expect(changed.sort()).toEqual(["accounts", "workspace_members", "workspaces"]);
    for (const accountId of [grace.id, heidi.id]) {
      expect(await asSystem(db, (tx) => tx`SELECT 1 FROM accounts WHERE id = ${accountId}`)).toHaveLength(1);
      expect(await asSystem(db, (tx) => tx`SELECT 1 FROM account_identities WHERE account_id = ${accountId}`)).toHaveLength(1);
      expect(await asSystem(db, (tx) => tx`SELECT 1 FROM credential_tokens WHERE account_id = ${accountId}`)).toHaveLength(1);
      expect(await asSystem(db, (tx) => tx`SELECT 1 FROM mfa_backup_codes WHERE account_id = ${accountId}`)).toHaveLength(1);
      expect(await asSystem(db, (tx) => tx`SELECT 1 FROM sessions WHERE account_id = ${accountId}`)).toHaveLength(1);
      expect(await asSystem(db, (tx) => tx`SELECT 1 FROM api_tokens WHERE account_id = ${accountId} AND revoked_at IS NULL`)).toHaveLength(1);
    }
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM audit_events WHERE actor_account_id IN (${grace.id}, ${heidi.id}) AND ip_prefix IS NOT NULL`)).toHaveLength(2);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspaces WHERE id IN (${unrelated}, ${graceOwn}) AND deleting_at IS NULL`)).toHaveLength(2);
  });

  it("blocks a sole owner of a workspace that has other members, names that workspace, and deletes and queues nothing", async () => {
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const shared = await workspaceOf("Ada's team", [ada, "owner"], [grace, "admin"]);
    const second = await workspaceOf("Ada's club", [ada, "owner"], [grace, "member"]);
    await seedToken(ada.id, shared);
    await seedPersonalRows(ada);
    await seedEvent(shared, ada, "Ada", PREFIX);
    const before = await snapshot();

    const outcome = await deleteAccount(ada);

    expect(outcome).toEqual({ deleted: false, blocking: [shared, second].sort(), sole: [own] });
    expect(await snapshot()).toEqual(before);
    expect(await queued(WORKSPACE_QUEUE)).toEqual([]);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
    // the function itself refuses too, whatever the caller read: the rule is the database's
    const direct = await inTenant({ accountId: ada.id }, (tx) => accountDeletionRepository(tx).delete([own], []));
    expect(direct).toBe(false);
    expect(await snapshot()).toEqual(before);
    // once another member is an owner, the account may go and the workspace keeps its owner
    await asSystem(db, (tx) => tx`UPDATE workspace_members SET role = 'owner' WHERE workspace_id IN (${shared}, ${second}) AND account_id = ${grace.id}`);
    expect(await deleteAccount(ada)).toMatchObject({ deleted: true, blocking: [] });
    const owners = await asSystem(db, (tx) => tx<{ workspace_id: string }[]>`SELECT workspace_id FROM workspace_members WHERE role = 'owner' AND workspace_id IN (${shared}, ${second})`);
    expect(owners.map((row) => row.workspace_id).sort()).toEqual([shared, second].sort());
  });

  it("does not treat a workspace that is already being deleted as blocking, and lets its membership end", async () => {
    const ada = await person();
    const grace = await person();
    const leaving = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });
    await seedMember(db, { workspaceId: leaving, accountId: ada.id, role: "owner" });
    await seedMember(db, { workspaceId: leaving, accountId: grace.id, role: "member" });

    expect(await deleteAccount(ada)).toEqual({ deleted: true, blocking: [], sole: [] });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspace_members WHERE workspace_id = ${leaving}`)).toHaveLength(1);
  });

  it("refuses a list of sole workspaces that is not the scope, and deletes and marks nothing", async () => {
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    const graces = await workspaceOf("Grace's own", [grace, "owner"]);
    const before = await snapshot();

    for (const ids of [[], [own, graces], [graces], [shared], [own, shared]]) {
      expect(await inTenant({ accountId: ada.id }, (tx) => accountDeletionRepository(tx).delete(ids, [eventJob(ada.id)]))).toBe(false);
    }
    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
    expect(await inTenant({ accountId: ada.id }, (tx) => accountDeletionRepository(tx).delete([own, own], []))).toBe(true);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspaces WHERE id = ${graces} AND deleting_at IS NULL`)).toHaveLength(1);
  });

  it("deletes only the account of the transaction: another account, and a request that acts in a workspace, delete nothing", async () => {
    const ada = await person();
    const grace = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    const before = await snapshot();

    const asGrace = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${grace.id}, true), set_config('app.workspace_id', '', true)`;
      return {
        deleted: (await tx<{ deleted: boolean }[]>`SELECT sys_delete_account(${ada.id}::uuid, ${`{${own}}`}::uuid[]) AS deleted`)[0]?.deleted,
        scope: await tx`SELECT * FROM sys_account_deletion_scope(${ada.id}::uuid)`,
      };
    });
    expect(asGrace.deleted).toBe(false);
    expect([...asGrace.scope]).toEqual([]);

    const inWorkspace = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${ada.id}, true), set_config('app.workspace_id', ${own}, true)`;
      return (await tx<{ deleted: boolean }[]>`SELECT sys_delete_account(${ada.id}::uuid, ${`{${own}}`}::uuid[]) AS deleted`)[0]?.deleted;
    });
    expect(inWorkspace).toBe(false);

    const anonymous = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', '', true), set_config('app.workspace_id', '', true)`;
      return (await tx<{ deleted: boolean }[]>`SELECT sys_delete_account(${ada.id}::uuid, ${`{${own}}`}::uuid[]) AS deleted`)[0]?.deleted;
    });
    expect(anonymous).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("is one transaction: a failure after the deletion leaves the account, its workspaces and its jobs as they were", async () => {
    const ada = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    await seedPersonalRows(ada);
    await seedEvent(own, ada, "Ada", PREFIX);
    const before = await snapshot();

    await expect(
      inTenant({ accountId: ada.id }, async (tx) => {
        const repository = accountDeletionRepository(tx);
        const { soleMember } = await repository.scope();
        expect(await repository.delete(soleMember.map((workspace) => workspace.id), [eventJob(ada.id)])).toBe(true);
        throw new Error("the request failed after the deletion");
      }),
    ).rejects.toThrow("the request failed after the deletion");

    expect(await snapshot()).toEqual(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });

  it("leaves the workspaces of the account to the deletion job, which removes them and their members' rows", async () => {
    const ada = await person();
    const own = await workspaceOf("Ada's own", [ada, "owner"]);
    await seedToken(ada.id, own);
    await seedEvent(own, ada, "Ada", PREFIX);

    expect((await deleteAccount(ada)).deleted).toBe(true);
    // marked, hidden, and without a member: nothing but the job can reach it now
    const [row] = await asSystem(db, (tx) => tx<{ deleting: boolean; members: number }[]>`SELECT deleting_at IS NOT NULL AS deleting, (SELECT count(*) FROM workspace_members WHERE workspace_id = ${own})::int AS members FROM workspaces WHERE id = ${own}`);
    expect(row).toEqual({ deleting: true, members: 0 });
    const store = bindWorkspaceDeletionStore(db.app);
    await store.purgeRows(own);
    expect(await store.finish(own, [])).toBe(true);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspaces WHERE id = ${own}`)).toHaveLength(0);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM audit_events WHERE workspace_id = ${own}`)).toHaveLength(0);
  });

  it("is a separate path from the deletion of one workspace: the workspace repository still refuses a non-owner", async () => {
    const ada = await person();
    const grace = await person();
    const shared = await workspaceOf("Shared", [grace, "owner"], [ada, "member"]);
    expect(await inTenant({ accountId: ada.id, workspaceId: shared }, (tx) => workspaceRepository(tx).markDeleting([]))).toBe(false);
  });
});

describe("deleting an instance admin", () => {
  it("refuses the only instance admin, names the refusal in the scope, and leaves the account, the flag and every row as they were", async () => {
    const admin = await person(true);
    const member = await person();
    const own = await workspaceOf("Admin's own", [admin, "owner"]);
    await workspaceOf("Shared", [member, "owner"], [admin, "member"]);
    await seedToken(admin.id, own);
    await seedPersonalRows(admin);
    await seedEvent(own, admin, "Admin", PREFIX);
    const before = await snapshot();

    const outcome = await deleteAccount(admin);

    expect(outcome).toMatchObject({ deleted: false });
    expect(await inTenant({ accountId: admin.id }, (tx) => accountDeletionRepository(tx).scope())).toMatchObject({ lastInstanceAdmin: true });
    // the function refuses too, whatever the caller read: the rule is the database's
    expect(await inTenant({ accountId: admin.id }, (tx) => accountDeletionRepository(tx).delete([own], [eventJob(admin.id)]))).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await instanceAdmins()).toEqual([admin.id]);
    expect(await queued(WORKSPACE_QUEUE)).toEqual([]);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });

  it("deletes an instance admin while another instance admin remains, and does not ask a non-admin about the rule", async () => {
    const first = await person(true);
    const second = await person(true);
    const plain = await person();
    await workspaceOf("First's own", [first, "owner"]);
    expect(await inTenant({ accountId: first.id }, (tx) => accountDeletionRepository(tx).scope())).toMatchObject({ lastInstanceAdmin: false });

    expect((await deleteAccount(first)).deleted).toBe(true);
    expect(await instanceAdmins()).toEqual([second.id]);

    expect(await inTenant({ accountId: plain.id }, (tx) => accountDeletionRepository(tx).scope())).toMatchObject({ lastInstanceAdmin: false });
    expect((await deleteAccount(plain)).deleted).toBe(true);
    expect(await instanceAdmins()).toEqual([second.id]);
    expect(await deleteAccount(second)).toMatchObject({ deleted: false });
    expect(await instanceAdmins()).toEqual([second.id]);
  });

  it("counts only enabled admins as another: an enabled admin with only a disabled admin beside it is the last one, in the scope and in the function", async () => {
    const enabled = await person(true);
    const disabled = await person(true);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled.id}`);
    await workspaceOf("Enabled's own", [enabled, "owner"]);
    const before = await snapshot();

    expect(await inTenant({ accountId: enabled.id }, (tx) => accountDeletionRepository(tx).scope())).toMatchObject({ lastInstanceAdmin: true });
    expect(await deleteAccount(enabled)).toMatchObject({ deleted: false });
    expect(await inTenant({ accountId: enabled.id }, (tx) => accountDeletionRepository(tx).delete([], []))).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await instanceAdmins()).toEqual([enabled.id, disabled.id].sort());
    // an enabled admin beside it makes it deletable again
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = NULL WHERE id = ${disabled.id}`);
    expect((await deleteAccount(enabled)).deleted).toBe(true);
    expect(await instanceAdmins()).toEqual([disabled.id]);
  });

  it("lets a non-admin go when the instance has no admin at all", async () => {
    const plain = await person();
    expect(await instanceAdmins()).toEqual([]);
    expect((await deleteAccount(plain)).deleted).toBe(true);
  });

  it("serialises two instance admins deleting themselves at once: the one that holds the lock deletes, the other is refused and stays", async () => {
    const ada = await person(true);
    const grace = await person(true);
    await workspaceOf("Ada's own", [ada, "owner"]);
    await workspaceOf("Grace's own", [grace, "owner"]);
    let scoped: () => void = () => undefined;
    const adaScoped = new Promise<void>((resolve) => {
      scoped = resolve;
    });

    // Ada reads her scope, then stays in her transaction for a while before she deletes; Grace starts in that window.
    const adaRun = inTenant({ accountId: ada.id }, async (tx) => {
      const repository = accountDeletionRepository(tx);
      const scope = await repository.scope();
      scoped();
      await sleep(600);
      return !scope.lastInstanceAdmin && (await repository.delete([...scope.soleMember.map((workspace) => workspace.id)], []));
    });
    await adaScoped;
    const graceRun = deleteAccount(grace);

    expect(await adaRun).toBe(true);
    expect(await graceRun).toMatchObject({ deleted: false });
    expect(await instanceAdmins()).toEqual([grace.id]);
  });
});
