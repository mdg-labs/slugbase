import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_PURGE_BATCH_SIZE, apiTokenRepository, workspacePurgeOrder, workspaceRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { bindWorkspaceDeletionStore } from "../src/system/workspace-deletion.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// Deleting a workspace (doc 05 sections 2.2 and 7.2, doc 02 section 3.7, doc 10 T1). The failure scenarios:
// a workspace that stays visible to its members, its sessions or its tokens after the request; a request by
// someone who is not an owner, or from another workspace, that marks the workspace anyway; a job interrupted
// halfway that cannot resume, or that touches another workspace; a workspace row that goes while its tables are
// still full; a job that can be pointed at a live workspace; and a deletion that is refused by the rule that a
// workspace keeps an owner. The RLS-only checks run statements as slugbase_app with the tenant settings of A
// and no application layer.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "workspace.delete";
const EVENT_QUEUE = "event.workspace.deleted";

let db: TestDatabase;
let store: ReturnType<typeof bindWorkspaceDeletionStore>;

beforeAll(async () => {
  db = await createTestDatabase();
  store = bindWorkspaceDeletionStore(db.app);
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
      ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL),
      ('${EVENT_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
});

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `deletion${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly workspaceId: string;
  readonly members: readonly { readonly accountId: string; readonly role: Role }[];
  readonly tokenHashes: readonly Buffer[];
}

/** A workspace with one member of each role given, in that order, its settings row, one token per member, two audit events, one pending invitation and one bookmark owned by the first member. */
async function workspaceOf(...roles: Role[]): Promise<Workspace> {
  const workspaceId = await seedWorkspace(db, { name: "Deletion test" });
  const members: { accountId: string; role: Role }[] = [];
  const tokenHashes: Buffer[] = [];
  for (const role of roles) {
    const accountId = await account();
    await seedMember(db, { workspaceId, accountId, role });
    members.push({ accountId, role });
    tokenHashes.push((await seedToken(accountId, workspaceId)).hash);
  }
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
    for (let index = 0; index < 2; index += 1) {
      await tx`INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action) VALUES (${freshId()}, ${workspaceId}, 'system', 'Test', 'workspace.renamed')`;
    }
    await tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at)
      VALUES (${freshId()}, ${workspaceId}, ${`invitee-${workspaceId}@example.test`}, 'member', ${freshToken().hash}, now() + interval '7 days')`;
    const bookmarkId = freshId();
    const tagId = freshId();
    const folderId = freshId();
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      VALUES (${bookmarkId}, ${workspaceId}, ${members[0]?.accountId ?? null}, 'https://example.com/', 'https://example.com', 'example.com', 'Deletion test bookmark', 'deletion-test', true)`;
    if (members[0] !== undefined) {
      await tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspaceId}, ${members[0].accountId}, 'deletion-test', ${bookmarkId})`;
    }
    await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${tagId}, ${workspaceId}, ${members[0]?.accountId ?? null}, 'Deletion test tag')`;
    await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folderId}, ${workspaceId}, ${members[0]?.accountId ?? null}, 'Deletion test folder')`;
    await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`;
  });
  return { workspaceId, members, tokenHashes };
}

function who(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member.accountId;
}

async function seedToken(accountId: string, workspaceId: string): Promise<{ id: string; hash: Buffer }> {
  const id = freshId();
  const token = freshToken();
  const outcome = await inTenant({ accountId }, (tx) =>
    apiTokenRepository(tx).create({ id, workspaceId, name: `CI ${id}`, scope: "read", tokenHash: token.hash, tokenPrefix: "abcdef", expiresInDays: 90, limit: 10 }),
  );
  expect(outcome.kind).toBe("created");
  return { id, hash: token.hash };
}

async function seedSession(accountId: string, activeWorkspaceId: string | null): Promise<string> {
  const id = freshId();
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, active_workspace_id, remember, expires_at, absolute_expires_at)
      VALUES (${id}, ${hash}, ${accountId}, 'full', ${activeWorkspaceId}, false, now() + interval '1 day', now() + interval '2 days')`,
  );
  return id;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "workspace-deletion-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId?: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId ?? ""}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

/** A digest of every row of the workspace in every table that holds its rows, read as slugbase_system. */
async function content(workspaceId: string): Promise<string> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w WHERE w.id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(m::text, '|' ORDER BY m.account_id) FROM workspace_members m WHERE m.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(s::text, '|' ORDER BY s.workspace_id) FROM workspace_settings s WHERE s.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(t.id::text || coalesce(t.revoked_at::text, ''), '|' ORDER BY t.id) FROM api_tokens t WHERE t.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e WHERE e.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(i::text, '|' ORDER BY i.id) FROM workspace_invitations i WHERE i.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(b::text, '|' ORDER BY b.id) FROM bookmarks b WHERE b.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM tags t WHERE t.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(l::text, '|' ORDER BY l.bookmark_id, l.tag_id) FROM bookmark_tags l WHERE l.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(f::text, '|' ORDER BY f.id) FROM folders f WHERE f.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(g::text, '|' ORDER BY g.folder_id, g.bookmark_id) FROM folder_bookmarks g WHERE g.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(q::text, '|' ORDER BY q.account_id, q.slug) FROM slug_preferences q WHERE q.workspace_id = ${workspaceId}), '')
      ) AS digest`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the digest query returned no row");
  }
  return row.digest;
}

async function counts(workspaceId: string): Promise<Record<string, number>> {
  const [row] = await asSystem(
    db,
    (tx) => tx<{ workspaces: number; members: number; settings: number; tokens: number; events: number; invitations: number; bookmarks: number; tags: number; links: number; folders: number; filings: number; preferences: number }[]>`
      SELECT (SELECT count(*) FROM workspaces WHERE id = ${workspaceId})::int AS workspaces,
             (SELECT count(*) FROM workspace_members WHERE workspace_id = ${workspaceId})::int AS members,
             (SELECT count(*) FROM workspace_settings WHERE workspace_id = ${workspaceId})::int AS settings,
             (SELECT count(*) FROM api_tokens WHERE workspace_id = ${workspaceId})::int AS tokens,
             (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId})::int AS events,
             (SELECT count(*) FROM workspace_invitations WHERE workspace_id = ${workspaceId})::int AS invitations,
             (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS bookmarks,
             (SELECT count(*) FROM tags WHERE workspace_id = ${workspaceId})::int AS tags,
             (SELECT count(*) FROM bookmark_tags WHERE workspace_id = ${workspaceId})::int AS links,
             (SELECT count(*) FROM folders WHERE workspace_id = ${workspaceId})::int AS folders,
             (SELECT count(*) FROM folder_bookmarks WHERE workspace_id = ${workspaceId})::int AS filings,
             (SELECT count(*) FROM slug_preferences WHERE workspace_id = ${workspaceId})::int AS preferences`,
  );
  if (row === undefined) {
    throw new Error("the count query returned no row");
  }
  return row;
}

async function markedAt(workspaceId: string): Promise<Date | null> {
  const [row] = await asSystem(db, (tx) => tx<{ deleting_at: Date | null }[]>`SELECT deleting_at FROM workspaces WHERE id = ${workspaceId}`);
  if (row === undefined) {
    throw new Error("no such workspace");
  }
  return row.deleting_at;
}

async function queued(name: string): Promise<Record<string, unknown>[]> {
  const rows = await db.owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} ORDER BY id`;
  return rows.map((row) => row.data);
}

function deleteJob(workspaceId: string) {
  return { id: freshId(), queue: QUEUE, data: { workspaceId } };
}

function deletedEvent(workspaceId: string) {
  const eventId = freshId();
  return { id: eventId, queue: EVENT_QUEUE, data: { eventId, workspaceId } };
}

async function mark(workspace: Workspace, memberIndex: number): Promise<boolean> {
  return inTenant({ accountId: who(workspace, memberIndex), workspaceId: workspace.workspaceId }, (tx) =>
    workspaceRepository(tx).markDeleting([deleteJob(workspace.workspaceId)]),
  );
}

describe("the registry of the tables the job empties", () => {
  it("names the tables in dependency order: the tokens before the members they reference", () => {
    expect([...workspacePurgeOrder]).toEqual(["api_tokens", "audit_events", "bookmark_tags", "folder_bookmarks", "slug_preferences", "bookmarks", "folders", "tags", "workspace_invitations", "workspace_settings", "workspace_members"]);
    expect(workspacePurgeOrder.indexOf("api_tokens")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
    expect(workspacePurgeOrder.indexOf("bookmarks")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
    expect(workspacePurgeOrder.indexOf("folders")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
    expect(workspacePurgeOrder.indexOf("folder_bookmarks")).toBeLessThan(workspacePurgeOrder.indexOf("bookmarks"));
    expect(workspacePurgeOrder.indexOf("folder_bookmarks")).toBeLessThan(workspacePurgeOrder.indexOf("folders"));
    expect(workspacePurgeOrder.indexOf("slug_preferences")).toBeLessThan(workspacePurgeOrder.indexOf("bookmarks"));
  });
});

describe("workspaceRepository.markDeleting", () => {
  it("hides the workspace from its members and tokens, points its sessions at none, revokes its tokens and queues the job, in one transaction", async () => {
    const a = await workspaceOf("owner", "admin", "member");
    const other = await workspaceOf("owner");
    await seedMember(db, { workspaceId: other.workspaceId, accountId: who(a, 2), role: "member" });
    const otherToken = await seedToken(who(a, 2), other.workspaceId);
    expect(a.tokenHashes).toHaveLength(3);
    const otherChecksum = await content(other.workspaceId);
    const sessionOfOwner = await seedSession(who(a, 0), a.workspaceId);
    const sessionOfMember = await seedSession(who(a, 2), a.workspaceId);
    const sessionElsewhere = await seedSession(who(a, 2), other.workspaceId);

    expect(await mark(a, 0)).toBe(true);

    expect(await markedAt(a.workspaceId)).toBeInstanceOf(Date);
    const sessions = await asSystem(db, (tx) => tx<{ id: string; active_workspace_id: string | null }[]>`SELECT id, active_workspace_id FROM sessions ORDER BY id`);
    expect(Object.fromEntries(sessions.map((row) => [row.id, row.active_workspace_id]))).toEqual({
      [sessionOfOwner]: null,
      [sessionOfMember]: null,
      [sessionElsewhere]: other.workspaceId,
    });
    const tokens = await asSystem(db, (tx) => tx<{ workspace_id: string; revoked: boolean }[]>`SELECT workspace_id, revoked_at IS NOT NULL AS revoked FROM api_tokens`);
    expect(tokens.filter((row) => row.workspace_id === a.workspaceId).map((row) => row.revoked)).toEqual([true, true, true]);
    expect(tokens.find((row) => row.workspace_id === other.workspaceId && row.revoked)).toBeUndefined();
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM api_tokens WHERE id = ${otherToken.id} AND revoked_at IS NULL`)).toHaveLength(1);
    expect(await queued(QUEUE)).toEqual([{ workspaceId: a.workspaceId }]);
    expect(await content(other.workspaceId)).toBe(otherChecksum);

    // no member finds the workspace afterwards: not in a list, not as the workspace of a request, not as a membership, and no token resolves to it
    for (const member of a.members) {
      const seen = await inTenant({ accountId: member.accountId, workspaceId: a.workspaceId }, async (tx) => ({
        listed: (await workspaceRepository(tx).list()).map((workspace) => workspace.id),
        current: await workspaceRepository(tx).current(),
      }));
      expect(seen.listed).not.toContain(a.workspaceId);
      expect(seen.current).toBeUndefined();
    }
    const reads = await appAs({ accountId: who(a, 1), workspaceId: a.workspaceId }, async (tx) => ({
      workspaces: await tx`SELECT id FROM workspaces WHERE id = ${a.workspaceId}`,
      memberWorkspaces: await tx<{ app_member_workspace_ids: string }[]>`SELECT * FROM app_member_workspace_ids()`,
    }));
    expect([...reads.workspaces]).toEqual([]);
    expect(reads.memberWorkspaces.map((row) => row["app_member_workspace_ids"])).not.toContain(a.workspaceId);
    for (const hash of a.tokenHashes) {
      const lookup = await db.app<{ token_id: string }[]>`SELECT token_id FROM sys_api_token_lookup(${hash}, NULL)`;
      expect([...lookup]).toEqual([]);
    }
    const control = await db.app<{ token_id: string }[]>`SELECT token_id FROM sys_api_token_lookup(${otherToken.hash}, NULL)`;
    expect(control.map((row) => row.token_id)).toEqual([otherToken.id]);
  });

  it("refuses an admin and a member, and a second request, and changes and queues nothing", async () => {
    const a = await workspaceOf("owner", "admin", "member");
    const before = await content(a.workspaceId);

    expect(await mark(a, 1)).toBe(false);
    expect(await mark(a, 2)).toBe(false);
    expect(await markedAt(a.workspaceId)).toBeNull();
    expect(await content(a.workspaceId)).toBe(before);
    expect(await queued(QUEUE)).toEqual([]);

    expect(await mark(a, 0)).toBe(true);
    expect(await mark(a, 0)).toBe(false);
    expect(await queued(QUEUE)).toHaveLength(1);
  });

  it("marks one of two owners' workspace when either owner asks, and keeps the owner rule out of the way of the deletion", async () => {
    const a = await workspaceOf("owner", "owner");

    expect(await mark(a, 1)).toBe(true);

    expect(await markedAt(a.workspaceId)).toBeInstanceOf(Date);
  });

  it("queues no job and marks nothing when the queue of the job does not exist", async () => {
    const a = await workspaceOf("owner");

    const error = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) =>
      workspaceRepository(tx).markDeleting([{ id: freshId(), queue: "no.such.queue", data: {} }]),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "QueueMissingError" });
    expect(await markedAt(a.workspaceId)).toBeNull();
    expect((await counts(a.workspaceId)).tokens).toBe(1);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM api_tokens WHERE workspace_id = ${a.workspaceId} AND revoked_at IS NOT NULL`)).toHaveLength(0);
  });

  it("needs a transaction opened with a workspace", async () => {
    const a = await workspaceOf("owner");

    await expect(inTenant({ accountId: who(a, 0) }, (tx) => workspaceRepository(tx).markDeleting([]))).rejects.toMatchObject({ name: "TenantContextError" });
  });
});

describe("sys_workspace_mark_deleting, row-level security alone", () => {
  it("marks no workspace other than the one the transaction acts in, and leaves workspace B as it was", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner", "admin");
    const before = await content(b.workspaceId);

    const fromA = await appAs({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => tx<{ marked: boolean }[]>`SELECT sys_workspace_mark_deleting(${b.workspaceId}::uuid) AS marked`);
    const ownerOfBWithoutWorkspace = await appAs({ accountId: who(b, 0) }, (tx) => tx<{ marked: boolean }[]>`SELECT sys_workspace_mark_deleting(${b.workspaceId}::uuid) AS marked`);
    const outsideTenant = await db.app<{ marked: boolean }[]>`SELECT sys_workspace_mark_deleting(${b.workspaceId}::uuid) AS marked`;

    expect(fromA[0]?.marked).toBe(false);
    expect(ownerOfBWithoutWorkspace[0]?.marked).toBe(false);
    expect(outsideTenant[0]?.marked).toBe(false);
    expect(await content(b.workspaceId)).toBe(before);
  });

  it("marks nothing for an account that is no owner of the workspace the transaction acts in", async () => {
    const a = await workspaceOf("owner", "admin");
    const outsider = await account();
    const before = await content(a.workspaceId);

    const byAdmin = await appAs({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => tx<{ marked: boolean }[]>`SELECT sys_workspace_mark_deleting(${a.workspaceId}::uuid) AS marked`);
    const byOutsider = await appAs({ accountId: outsider, workspaceId: a.workspaceId }, (tx) => tx<{ marked: boolean }[]>`SELECT sys_workspace_mark_deleting(${a.workspaceId}::uuid) AS marked`);

    expect(byAdmin[0]?.marked).toBe(false);
    expect(byOutsider[0]?.marked).toBe(false);
    expect(await content(a.workspaceId)).toBe(before);
  });

  it("gives the application role no way to set deleting_at or delete the tables of a workspace itself", async () => {
    const a = await workspaceOf("owner");
    const actor = { accountId: who(a, 0), workspaceId: a.workspaceId };

    await expect(appAs(actor, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${a.workspaceId}`)).rejects.toMatchObject({ code: "42501" });
    await expect(appAs(actor, (tx) => tx`DELETE FROM workspaces WHERE id = ${a.workspaceId}`)).rejects.toMatchObject({ code: "42501" });
    await expect(appAs(actor, (tx) => tx`DELETE FROM audit_events WHERE workspace_id = ${a.workspaceId}`)).rejects.toMatchObject({ code: "42501" });
    await expect(appAs(actor, (tx) => tx`DELETE FROM api_tokens WHERE workspace_id = ${a.workspaceId}`)).rejects.toMatchObject({ code: "42501" });
    await expect(appAs(actor, (tx) => tx`DELETE FROM workspace_settings WHERE workspace_id = ${a.workspaceId}`)).rejects.toMatchObject({ code: "42501" });
    expect(await markedAt(a.workspaceId)).toBeNull();
  });
});

describe("the deletion job's operations", () => {
  it("deletes nothing of a workspace that is not being deleted, and does not delete its row", async () => {
    const a = await workspaceOf("owner", "member");
    const before = await content(a.workspaceId);

    const deleted = await store.purgeRows(a.workspaceId);
    const finished = await store.finish(a.workspaceId, [deletedEvent(a.workspaceId)]);

    expect(Object.values(deleted).every((count) => count === 0)).toBe(true);
    expect(finished).toBe(false);
    expect(await content(a.workspaceId)).toBe(before);
    expect(await queued(EVENT_QUEUE)).toEqual([]);
  });

  it("empties every table of the workspace, then deletes the workspace row and queues the event with it, and touches no other workspace", async () => {
    const a = await workspaceOf("owner", "admin", "member");
    const b = await workspaceOf("owner", "admin");
    await seedMember(db, { workspaceId: b.workspaceId, accountId: who(a, 2), role: "member" });
    const beforeB = await content(b.workspaceId);
    expect(await mark(a, 0)).toBe(true);

    const deleted = await store.purgeRows(a.workspaceId);
    const rowsLeftBeforeFinish = await counts(a.workspaceId);
    const finished = await store.finish(a.workspaceId, [deletedEvent(a.workspaceId)]);

    expect(deleted).toEqual({ api_tokens: 3, audit_events: 2, bookmark_tags: 1, folder_bookmarks: 1, slug_preferences: 1, bookmarks: 1, folders: 1, tags: 1, workspace_invitations: 1, workspace_settings: 1, workspace_members: 3 });
    expect(rowsLeftBeforeFinish).toEqual({ workspaces: 1, members: 0, settings: 0, tokens: 0, events: 0, invitations: 0, bookmarks: 0, tags: 0, links: 0, folders: 0, filings: 0, preferences: 0 });
    expect(finished).toBe(true);
    expect(await counts(a.workspaceId)).toEqual({ workspaces: 0, members: 0, settings: 0, tokens: 0, events: 0, invitations: 0, bookmarks: 0, tags: 0, links: 0, folders: 0, filings: 0, preferences: 0 });
    expect(await queued(EVENT_QUEUE)).toMatchObject([{ workspaceId: a.workspaceId }]);
    expect(await content(b.workspaceId)).toBe(beforeB);
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM workspace_members WHERE account_id = ${who(a, 2)}`)).toHaveLength(1);
  });

  it("deletes a table of more rows than one batch in several batches", async () => {
    const a = await workspaceOf("owner");
    const rows = WORKSPACE_PURGE_BATCH_SIZE * 2 + 5;
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action)
        SELECT gen_random_uuid(), ${a.workspaceId}, 'system', 'Test', 'workspace.renamed' FROM generate_series(1, ${rows})`,
    );
    expect(await mark(a, 0)).toBe(true);

    const deleted = await store.purgeRows(a.workspaceId);

    expect(deleted["audit_events"]).toBe(rows + 2);
    expect((await counts(a.workspaceId)).events).toBe(0);
  });

  it("resumes a run that stopped halfway, finishes it, and touches no other workspace", async () => {
    const a = await workspaceOf("owner", "admin");
    const b = await workspaceOf("owner", "member");
    const beforeB = await content(b.workspaceId);
    expect(await mark(a, 0)).toBe(true);

    // a first run that deleted the tokens and one audit event and then died
    await db.app`SELECT sys_workspace_purge_batch(${a.workspaceId}::uuid, 'api_tokens', 1000)`;
    await db.app`SELECT sys_workspace_purge_batch(${a.workspaceId}::uuid, 'audit_events', 1)`;
    expect(await counts(a.workspaceId)).toEqual({ workspaces: 1, members: 2, settings: 1, tokens: 0, events: 1, invitations: 1, bookmarks: 1, tags: 1, links: 1, folders: 1, filings: 1, preferences: 1 });

    const deleted = await store.purgeRows(a.workspaceId);
    expect(deleted).toEqual({ api_tokens: 0, audit_events: 1, bookmark_tags: 1, folder_bookmarks: 1, slug_preferences: 1, bookmarks: 1, folders: 1, tags: 1, workspace_invitations: 1, workspace_settings: 1, workspace_members: 2 });
    expect(await store.finish(a.workspaceId, [deletedEvent(a.workspaceId)])).toBe(true);

    expect(await counts(a.workspaceId)).toEqual({ workspaces: 0, members: 0, settings: 0, tokens: 0, events: 0, invitations: 0, bookmarks: 0, tags: 0, links: 0, folders: 0, filings: 0, preferences: 0 });
    expect(await content(b.workspaceId)).toBe(beforeB);
  });

  it("is idempotent: repeated after the workspace is gone it deletes nothing and announces nothing again", async () => {
    const a = await workspaceOf("owner");
    expect(await mark(a, 0)).toBe(true);
    await store.purgeRows(a.workspaceId);
    expect(await store.finish(a.workspaceId, [deletedEvent(a.workspaceId)])).toBe(true);

    const deleted = await store.purgeRows(a.workspaceId);
    const again = await store.finish(a.workspaceId, [deletedEvent(a.workspaceId)]);

    expect(Object.values(deleted).every((count) => count === 0)).toBe(true);
    expect(again).toBe(false);
    expect(await queued(EVENT_QUEUE)).toHaveLength(1);
  });

  it("deletes the workspace row and the rows the registry left, and rolls the event back when its queue does not exist", async () => {
    const a = await workspaceOf("owner", "member");
    expect(await mark(a, 0)).toBe(true);

    const error = await store.finish(a.workspaceId, [{ id: freshId(), queue: "no.such.queue", data: {} }]).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "QueueMissingError" });
    expect(await counts(a.workspaceId)).toMatchObject({ workspaces: 1, members: 2 });

    expect(await store.finish(a.workspaceId, [deletedEvent(a.workspaceId)])).toBe(true);
    expect(await counts(a.workspaceId)).toEqual({ workspaces: 0, members: 0, settings: 0, tokens: 0, events: 0, invitations: 0, bookmarks: 0, tags: 0, links: 0, folders: 0, filings: 0, preferences: 0 });
  });

  it("is not driven by a tenant transaction: a request cannot purge a workspace being deleted, hasten or finish its deletion", async () => {
    const a = await workspaceOf("owner", "admin");
    const b = await workspaceOf("owner");
    expect(await mark(b, 0)).toBe(true);
    const beforeB = await content(b.workspaceId);

    const purged = await appAs({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => tx<{ deleted: number }[]>`SELECT sys_workspace_purge_batch(${b.workspaceId}::uuid, 'audit_events', 10) AS deleted`);
    const finished = await appAs({ accountId: who(a, 0) }, (tx) => tx<{ finished: boolean }[]>`SELECT sys_workspace_delete_finish(${b.workspaceId}::uuid) AS finished`);

    expect(purged[0]?.deleted).toBe(0);
    expect(finished[0]?.finished).toBe(false);
    expect(await content(b.workspaceId)).toBe(beforeB);
  });

  it("refuses a table it does not know, whatever the workspace", async () => {
    await expect(db.app`SELECT sys_workspace_purge_batch(${freshId()}::uuid, 'accounts', 10)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT sys_workspace_purge_batch(${freshId()}::uuid, 'workspaces', 10)`).rejects.toMatchObject({ code: "22023" });
  });

  it("refuses a batch size outside 1 to 10000", async () => {
    await expect(db.app`SELECT sys_workspace_purge_batch(${freshId()}::uuid, 'audit_events', 0)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT sys_workspace_purge_batch(${freshId()}::uuid, 'audit_events', 10001)`).rejects.toMatchObject({ code: "22023" });
  });

  it("is not held up by the rule that a workspace keeps an owner, because the workspace is being deleted", async () => {
    const a = await workspaceOf("owner", "owner");
    expect(await mark(a, 0)).toBe(true);

    await expect(store.purgeRows(a.workspaceId)).resolves.toMatchObject({ workspace_members: 2 });
    expect((await counts(a.workspaceId)).members).toBe(0);
  });
});
