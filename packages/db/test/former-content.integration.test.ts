import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, formerContentRepository, memberRepository, TenantContextError, type QueuedJob } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle, type TenantTx } from "../src/tenant.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { withUncommittedWrite } from "./support/concurrent-write.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The former members' content of a workspace (doc 02 section 2.10, doc 05 sections 2.4 and 7.5, doc 10 T1 and T2). The failure scenario: the policies of
// `bookmarks` and `folders` name the workspace only, so a list that filters on the workspace alone returns another member's private bookmark, and a
// bookmark that a departure still holds, to an admin. The lists hold the rows with no owner and no departure, and for bookmarks no plan-archived one, of
// the workspace of the transaction and no other.
//
// Deleting that content is `sys_former_content_delete` (doc 05 section 3.3, doc 10 T1, T2 and T11). The failure scenarios: a member who is no owner or admin
// deletes the workspace's ownerless content by calling the function directly, with no route in the way; the function deletes a row a member owns, one a departure still
// holds, a plan-archived bookmark or a row of another workspace because its identifier was named; the counter does not fall by exactly the bookmarks deleted; and a call
// that deadlocks against another call, a bulk delete or a member's removal.

const HOOK_TIMEOUT_MS = 300_000;
const MEMBER_LEFT_QUEUE = "event.member.left";
const DEPARTURE = "0192f3a0-dddd-7000-8000-000000000001";
const ANY_DATE: unknown = expect.any(Date);
const INVALID_PARAMETER_VALUE = "22023";
const INSUFFICIENT_PRIVILEGE = "42501";
const DEADLOCK_DETECTED = "40P01";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes: a removal that names its departure queues the member.left event.
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    INSERT INTO pgboss.queue VALUES ('${MEMBER_LEFT_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `former-content${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly admin: string;
  readonly member: string;
}

async function workspaceOf(): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Former content test" });
  const admin = await account();
  const member = await account();
  await seedMember(db, { workspaceId: id, accountId: admin, role: "owner" });
  await seedMember(db, { workspaceId: id, accountId: member, role: "member" });
  return { id, admin, member };
}

interface SeedBookmark {
  readonly workspaceId: string;
  readonly ownerId?: string | null;
  readonly departureId?: string | null;
  readonly planArchivedAt?: Date | null;
  readonly title: string;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
}

async function seedBookmark(bookmark: SeedBookmark): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, departure_id, plan_archived_at, url, url_canonical, host, title, slug, forwarding)
      VALUES (${id}, ${bookmark.workspaceId}, ${bookmark.ownerId ?? null}, ${bookmark.departureId ?? null}, ${bookmark.planArchivedAt ?? null},
              'https://example.com/former', 'https://example.com/former', 'example.com', ${bookmark.title}, ${bookmark.slug ?? null}, ${bookmark.forwarding ?? false})`,
  );
  return id;
}

async function seedFolder(workspaceId: string, name: string, options: { ownerId?: string | null; departureId?: string | null } = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, departure_id, name, icon, color) VALUES (${id}, ${workspaceId}, ${options.ownerId ?? null}, ${options.departureId ?? null}, ${name}, 'book', 3)`,
  );
  return id;
}

async function file(workspaceId: string, folderId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`);
}

async function inWorkspace<T>(workspace: Workspace, work: (repository: ReturnType<typeof formerContentRepository>) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ accountId: workspace.admin, workspaceId: workspace.id, requestId: "former-content-test" }, (tx) => work(formerContentRepository(tx)));
}

describe("the former members' bookmarks of a workspace", () => {
  it("lists the bookmarks that have no owner and no departure and are not plan-archived, and no other row of the workspace or of another one", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const listed = [
      await seedBookmark({ workspaceId: workspace.id, title: "Ownerless one", slug: "former-one", forwarding: true }),
      await seedBookmark({ workspaceId: workspace.id, title: "Ownerless two" }),
    ];
    await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.member, title: "A member's private bookmark" });
    await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.admin, title: "The admin's own bookmark" });
    await seedBookmark({ workspaceId: workspace.id, departureId: DEPARTURE, title: "Waiting for its departure" });
    await seedBookmark({ workspaceId: workspace.id, planArchivedAt: new Date(), title: "Plan-archived" });
    await seedBookmark({ workspaceId: other.id, title: "Ownerless in another workspace" });
    await seedBookmark({ workspaceId: other.id, ownerId: other.member, title: "Owned in another workspace" });

    const rows = await inWorkspace(workspace, (repository) => repository.listBookmarks(null, 50));

    expect(rows.map((row) => row.id)).toEqual(listed);
    expect(rows.map((row) => row.title)).toEqual(["Ownerless one", "Ownerless two"]);
    expect(rows[0]).toEqual({
      id: listed[0],
      title: "Ownerless one",
      url: "https://example.com/former",
      host: "example.com",
      slug: "former-one",
      forwarding: true,
      createdAt: ANY_DATE,
      updatedAt: ANY_DATE,
    });
    expect(rows[1]?.slug).toBeNull();
    expect(rows[1]?.forwarding).toBe(false);
  });

  it("pages in the order of the identifiers: a page after an identifier holds the rows after it, at most the limit", async () => {
    const workspace = await workspaceOf();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await seedBookmark({ workspaceId: workspace.id, title: `Page ${String(index)}` }));
    }
    const first = await inWorkspace(workspace, (repository) => repository.listBookmarks(null, 2));
    const second = await inWorkspace(workspace, (repository) => repository.listBookmarks(first.at(-1)?.id ?? null, 2));
    const third = await inWorkspace(workspace, (repository) => repository.listBookmarks(second.at(-1)?.id ?? null, 2));
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(second.map((row) => row.id)).toEqual(ids.slice(2, 4));
    expect(third.map((row) => row.id)).toEqual(ids.slice(4));
  });

  it("lists nothing of a workspace in which the transaction does not act, and refuses a transaction opened without a workspace", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    await seedBookmark({ workspaceId: other.id, title: "Ownerless in another workspace" });
    expect(await inWorkspace(workspace, (repository) => repository.listBookmarks(null, 50))).toEqual([]);
    await expect(
      db.tenant.withTenant({ accountId: workspace.admin, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).listBookmarks(null, 50)),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the former members' folders of a workspace", () => {
  it("lists the folders that have no owner and no departure, with the count of the listed bookmarks filed in each, and no other row", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const reading = await seedFolder(workspace.id, "Reading");
    const empty = await seedFolder(workspace.id, "Empty");
    const owned = await seedFolder(workspace.id, "A member's folder", { ownerId: workspace.member });
    await seedFolder(workspace.id, "Waiting for its departure", { departureId: DEPARTURE });
    await seedFolder(other.id, "Ownerless in another workspace");
    const counted = [await seedBookmark({ workspaceId: workspace.id, title: "Filed one" }), await seedBookmark({ workspaceId: workspace.id, title: "Filed two" })];
    for (const bookmarkId of counted) {
      await file(workspace.id, reading, bookmarkId);
    }
    // Filed in the folder and not counted: archived by the plan, held by a departure, and a bookmark a member owns.
    await file(workspace.id, reading, await seedBookmark({ workspaceId: workspace.id, planArchivedAt: new Date(), title: "Archived" }));
    await file(workspace.id, reading, await seedBookmark({ workspaceId: workspace.id, departureId: DEPARTURE, title: "Waiting" }));
    await file(workspace.id, reading, await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.member, title: "A member's" }));
    await file(workspace.id, owned, await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.member, title: "In a member's folder" }));

    const rows = await inWorkspace(workspace, (repository) => repository.listFolders(null, 50));

    expect(rows).toEqual([
      { id: reading, name: "Reading", icon: "book", color: 3, bookmarkCount: 2, createdAt: ANY_DATE },
      { id: empty, name: "Empty", icon: "book", color: 3, bookmarkCount: 0, createdAt: ANY_DATE },
    ]);
  });

  it("pages in the order of the identifiers", async () => {
    const workspace = await workspaceOf();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await seedFolder(workspace.id, `Page ${String(index)}`));
    }
    const first = await inWorkspace(workspace, (repository) => repository.listFolders(null, 2));
    const second = await inWorkspace(workspace, (repository) => repository.listFolders(first.at(-1)?.id ?? null, 2));
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(second.map((row) => row.id)).toEqual(ids.slice(2));
  });

  it("lists nothing of another workspace, and refuses a transaction opened without a workspace", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    await seedFolder(other.id, "Ownerless in another workspace");
    expect(await inWorkspace(workspace, (repository) => repository.listFolders(null, 50))).toEqual([]);
    await expect(
      db.tenant.withTenant({ accountId: workspace.admin, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).listFolders(null, 50)),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

interface DeleteScene extends Workspace {
  /** An owner of the workspace (`admin` of `Workspace`) beside an admin and a plain member. */
  readonly roleAdmin: string;
  readonly otherMember: string;
}

/** A workspace with an owner, an admin and two plain members, so a test can name the caller by role. */
async function deleteScene(): Promise<DeleteScene> {
  const workspace = await workspaceOf();
  const roleAdmin = await account();
  const otherMember = await account();
  await seedMember(db, { workspaceId: workspace.id, accountId: roleAdmin, role: "admin" });
  await seedMember(db, { workspaceId: workspace.id, accountId: otherMember, role: "member" });
  return { ...workspace, roleAdmin, otherMember };
}

/** Sets the counter the way creations leave it: one for each row that is not plan-archived. */
async function syncCounter(workspaceId: string): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`UPDATE workspaces SET bookmark_count = (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND plan_archived_at IS NULL) WHERE id = ${workspaceId}`,
  );
}

async function counter(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`);
  return rows[0]?.bookmark_count ?? Number.NaN;
}

async function rowsOf(workspaceId: string): Promise<{ bookmarks: string[]; folders: string[] }> {
  return asSystem(db, async (tx) => ({
    bookmarks: (await tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`).map((row) => row.id),
    folders: (await tx<{ id: string }[]>`SELECT id FROM folders WHERE workspace_id = ${workspaceId} ORDER BY id`).map((row) => row.id),
  }));
}

async function countOf(table: "bookmark_shares" | "folder_shares" | "folder_bookmarks" | "bookmark_tags" | "slug_preferences", workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId]));
  return rows[0]?.n ?? Number.NaN;
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

interface Answer {
  readonly bookmarks_deleted: number | null;
  readonly folders_deleted: number | null;
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no service, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

const callFunction = (tx: postgres.TransactionSql, workspaceId: string, bookmarkIds: readonly string[], folderIds: readonly string[]) =>
  tx<Answer[]>`SELECT * FROM public.sys_former_content_delete(${workspaceId}::uuid, ${`{${bookmarkIds.join(",")}}`}::uuid[], ${`{${folderIds.join(",")}}`}::uuid[])`.then((rows) => rows[0]);

describe("sys_former_content_delete", () => {
  it("deletes the named ownerless bookmarks and folders with their shares, filings, tag links and remembered go choices, and the counter equals the rows left that are not plan-archived", async () => {
    const scene = await deleteScene();
    const gone = [await seedBookmark({ workspaceId: scene.id, title: "Gone one", slug: "gone-one", forwarding: true }), await seedBookmark({ workspaceId: scene.id, title: "Gone two" })];
    const kept = await seedBookmark({ workspaceId: scene.id, title: "Ownerless and not named" });
    const owned = await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "A member's" });
    const goneFolder = await seedFolder(scene.id, "Gone folder");
    const keptFolder = await seedFolder(scene.id, "Kept folder");
    const tagId = freshId();
    await asSystem(db, async (tx) => {
      await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${tagId}, ${scene.id}, ${scene.member}, 'mine')`;
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${scene.id}, ${gone[0] ?? ""}, ${tagId})`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id) VALUES (${freshId()}, ${scene.id}, ${gone[0] ?? ""}, ${scene.member})`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id) VALUES (${freshId()}, ${scene.id}, ${kept}, ${scene.member})`;
      await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id) VALUES (${freshId()}, ${scene.id}, ${goneFolder}, ${scene.member})`;
      await tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${scene.id}, ${scene.member}, 'gone-one', ${gone[0] ?? ""})`;
    });
    await file(scene.id, goneFolder, gone[1] ?? "");
    await file(scene.id, goneFolder, owned);
    await file(scene.id, keptFolder, kept);
    await syncCounter(scene.id);
    expect(await counter(scene.id)).toBe(4);

    const answer = await appAs({ accountId: scene.admin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, gone, [goneFolder]));

    expect(answer).toEqual({ bookmarks_deleted: 2, folders_deleted: 1 });
    expect(await rowsOf(scene.id)).toEqual({ bookmarks: [kept, owned].toSorted(), folders: [keptFolder] });
    expect(await counter(scene.id)).toBe(2);
    expect(await counter(scene.id)).toBe((await rowsOf(scene.id)).bookmarks.length);
    // What referenced the deleted rows went with them; what references the rows that stay is untouched.
    expect(await countOf("bookmark_tags", scene.id)).toBe(0);
    expect(await countOf("bookmark_shares", scene.id)).toBe(1);
    expect(await countOf("folder_shares", scene.id)).toBe(0);
    expect(await countOf("slug_preferences", scene.id)).toBe(0);
    expect(await countOf("folder_bookmarks", scene.id)).toBe(1);
  });

  it("lets an owner and an admin delete, and lets a list be empty or name a row twice", async () => {
    const scene = await deleteScene();
    const first = await seedBookmark({ workspaceId: scene.id, title: "First" });
    const second = await seedBookmark({ workspaceId: scene.id, title: "Second" });
    const folder = await seedFolder(scene.id, "Folder");
    await syncCounter(scene.id);

    expect(await appAs({ accountId: scene.roleAdmin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [first, first], []))).toEqual({ bookmarks_deleted: 1, folders_deleted: 0 });
    expect(await appAs({ accountId: scene.admin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [second], [folder]))).toEqual({ bookmarks_deleted: 1, folders_deleted: 1 });
    expect(await appAs({ accountId: scene.admin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [], []))).toEqual({ bookmarks_deleted: 0, folders_deleted: 0 });
    expect(await rowsOf(scene.id)).toEqual({ bookmarks: [], folders: [] });
    expect(await counter(scene.id)).toBe(0);
  });

  it("FAILURE SCENARIO: a plain member's transaction that calls it directly deletes nothing", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    await syncCounter(scene.id);
    const before = { rows: await rowsOf(scene.id), counter: await counter(scene.id) };

    for (const caller of [scene.member, scene.otherMember]) {
      expect(await appAs({ accountId: caller, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [bookmark], [folder]))).toEqual({ bookmarks_deleted: null, folders_deleted: null });
    }
    // An account that is no member of the workspace at all, with the transaction acting in it.
    const stranger = await account();
    expect(await appAs({ accountId: stranger, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [bookmark], [folder]))).toEqual({ bookmarks_deleted: null, folders_deleted: null });

    expect({ rows: await rowsOf(scene.id), counter: await counter(scene.id) }).toEqual(before);
    const repositoryAnswer = await db.tenant.withTenant({ accountId: scene.member, workspaceId: scene.id, requestId: "former-content-test" }, (tx) =>
      formerContentRepository(tx).delete({ bookmarkIds: [bookmark], folderIds: [folder] }),
    );
    expect(repositoryAnswer).toBeUndefined();
    expect(await rowsOf(scene.id)).toEqual(before.rows);
  });

  it("a role taken away is not honoured: an admin demoted before the call acts as a member", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);
    await asSystem(db, (tx) => tx`UPDATE workspace_members SET role = 'member' WHERE workspace_id = ${scene.id} AND account_id = ${scene.roleAdmin}`);

    expect(await appAs({ accountId: scene.roleAdmin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [bookmark], []))).toEqual({ bookmarks_deleted: null, folders_deleted: null });
    expect((await rowsOf(scene.id)).bookmarks).toEqual([bookmark]);
  });

  it("deletes nothing of a row a member owns, one a departure still holds, a plan-archived bookmark or one of another workspace, and leaves the counter alone", async () => {
    const scene = await deleteScene();
    const other = await deleteScene();
    const listed = await seedBookmark({ workspaceId: scene.id, title: "Listed" });
    const listedFolder = await seedFolder(scene.id, "Listed folder");
    const protectedBookmarks = [
      await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "Owned by a member" }),
      await seedBookmark({ workspaceId: scene.id, ownerId: scene.admin, title: "Owned by the caller" }),
      await seedBookmark({ workspaceId: scene.id, departureId: DEPARTURE, title: "Held by a departure" }),
      await seedBookmark({ workspaceId: scene.id, planArchivedAt: new Date(), title: "Plan-archived" }),
      await seedBookmark({ workspaceId: other.id, title: "Ownerless in another workspace" }),
      await seedBookmark({ workspaceId: other.id, ownerId: other.member, title: "Owned in another workspace" }),
    ];
    const protectedFolders = [
      await seedFolder(scene.id, "Owned folder", { ownerId: scene.member }),
      await seedFolder(scene.id, "Held folder", { departureId: DEPARTURE }),
      await seedFolder(other.id, "Ownerless folder of another workspace"),
    ];
    await syncCounter(scene.id);
    await syncCounter(other.id);
    const before = { scene: await rowsOf(scene.id), other: await rowsOf(other.id), counters: [await counter(scene.id), await counter(other.id)] };

    const answer = await appAs({ accountId: scene.admin, workspaceId: scene.id }, (tx) =>
      callFunction(tx, scene.id, [...protectedBookmarks, freshId()], [...protectedFolders, freshId()]),
    );

    expect(answer).toEqual({ bookmarks_deleted: 0, folders_deleted: 0 });
    expect({ scene: await rowsOf(scene.id), other: await rowsOf(other.id), counters: [await counter(scene.id), await counter(other.id)] }).toEqual(before);

    // The same request that also names a row that may go deletes that row alone, and the counter falls by exactly it.
    const mixed = await appAs({ accountId: scene.admin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [...protectedBookmarks, listed], [...protectedFolders, listedFolder]));
    expect(mixed).toEqual({ bookmarks_deleted: 1, folders_deleted: 1 });
    expect((await rowsOf(scene.id)).bookmarks).not.toContain(listed);
    expect((await rowsOf(scene.id)).folders).not.toContain(listedFolder);
    expect(await rowsOf(other.id)).toEqual(before.other);
    expect(await counter(scene.id)).toBe((before.counters[0] ?? Number.NaN) - 1);
    expect(await counter(other.id)).toBe(before.counters[1]);
  });

  it("answers NULL and writes nothing when the transaction acts in another workspace or in none, or in a workspace being deleted", async () => {
    const a = await deleteScene();
    const b = await deleteScene();
    const ofB = await seedBookmark({ workspaceId: b.id, title: "Ownerless in B" });
    const folderOfB = await seedFolder(b.id, "Ownerless folder in B");
    await syncCounter(b.id);
    const before = { rows: await rowsOf(b.id), counter: await counter(b.id) };
    const none = { bookmarks_deleted: null, folders_deleted: null };

    expect(await appAs({ accountId: a.admin, workspaceId: a.id }, (tx) => callFunction(tx, b.id, [ofB], [folderOfB]))).toEqual(none);
    expect(await appAs({ accountId: b.admin }, (tx) => callFunction(tx, b.id, [ofB], [folderOfB]))).toEqual(none);
    expect(await appAs({ accountId: b.admin, workspaceId: b.id }, (tx) => callFunction(tx, a.id, [ofB], [folderOfB]))).toEqual(none);
    // The RLS-only path: an account of A that acts in B is no member of B, and a plain member of A could not delete in A either.
    expect(await appAs({ accountId: a.admin, workspaceId: b.id }, (tx) => callFunction(tx, b.id, [ofB], [folderOfB]))).toEqual(none);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${b.id}`);
    expect(await appAs({ accountId: b.admin, workspaceId: b.id }, (tx) => callFunction(tx, b.id, [ofB], [folderOfB]))).toEqual(none);

    expect({ rows: await rowsOf(b.id), counter: await counter(b.id) }).toEqual(before);
  });

  it("raises on a NULL workspace, a NULL list, a NULL element and more than 1 000 positions in either list, and deletes nothing", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);
    const settings = { accountId: scene.admin, workspaceId: scene.id };
    const before = { rows: await rowsOf(scene.id), counter: await counter(scene.id) };

    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(NULL, '{}'::uuid[], '{}'::uuid[])`))).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, NULL, '{}'::uuid[])`))).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, '{}'::uuid[], NULL)`))).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(
      refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, ${`{${bookmark},NULL}`}::uuid[], '{}'::uuid[])`)),
    ).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(
      refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, '{}'::uuid[], ${`{NULL}`}::uuid[])`)),
    ).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(
      refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1001)), '{}'::uuid[])`)),
    ).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(
      refusedWith(appAs(settings, (tx) => tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, '{}'::uuid[], ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1001)))`)),
    ).resolves.toBe(INVALID_PARAMETER_VALUE);
    // Exactly 1 000 positions in each list is allowed.
    await expect(
      appAs(settings, (tx) =>
        tx`SELECT * FROM public.sys_former_content_delete(${scene.id}::uuid, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1000)), ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1000)))`,
      ),
    ).resolves.toHaveLength(1);

    expect({ rows: await rowsOf(scene.id), counter: await counter(scene.id) }).toEqual(before);
  });

  it("is the only way the application role deletes an ownerless bookmark or lowers the counter", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);
    const settings = { accountId: scene.admin, workspaceId: scene.id };

    expect(await refusedWith(appAs(settings, (tx) => tx`DELETE FROM bookmarks WHERE id = ${bookmark}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE workspaces SET bookmark_count = 0 WHERE id = ${scene.id}`))).toBe(INSUFFICIENT_PRIVILEGE);
    // The caller's own deletion paths do not reach a row without an owner.
    const removed = await appAs(settings, (tx) => tx<{ deleted: number | null }[]>`SELECT public.sys_bookmark_delete_many(${scene.id}::uuid, ${`{${bookmark}}`}::uuid[]) AS deleted`);
    expect(removed[0]?.deleted).toBe(0);
    expect((await rowsOf(scene.id)).bookmarks).toEqual([bookmark]);
    expect(await counter(scene.id)).toBe(1);
  });

  it("rolls the whole call back when the counter would go below the rows: nothing is deleted and no half of it is kept", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    // The counter disagrees with the rows (it says 0 for one counted row): the CHECK refuses the count below zero and the call fails as a whole.
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 0 WHERE id = ${scene.id}`);

    await expect(refusedWith(appAs({ accountId: scene.admin, workspaceId: scene.id }, (tx) => callFunction(tx, scene.id, [bookmark], [folder])))).resolves.toBe("23514");
    expect(await rowsOf(scene.id)).toEqual({ bookmarks: [bookmark], folders: [folder] });
  });
});

describe("formerContentRepository.delete", () => {
  it("deletes through the function and answers the counts, takes an identifier named twice once and skips an unknown one", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    await syncCounter(scene.id);

    const answer = await db.tenant.withTenant({ accountId: scene.roleAdmin, workspaceId: scene.id, requestId: "former-content-test" }, (tx) =>
      formerContentRepository(tx).delete({ bookmarkIds: [bookmark, bookmark.toUpperCase(), freshId()], folderIds: [folder] }),
    );

    expect(answer).toEqual({ bookmarksDeleted: 1, foldersDeleted: 1 });
    expect(await rowsOf(scene.id)).toEqual({ bookmarks: [], folders: [] });
    expect(await counter(scene.id)).toBe(0);
  });

  it("refuses a transaction opened without a workspace and a name that is not an identifier, and deletes nothing", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);

    await expect(
      db.tenant.withTenant({ accountId: scene.admin, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).delete({ bookmarkIds: [bookmark], folderIds: [] })),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).delete({ bookmarkIds: ["x"], folderIds: [] })),
    ).rejects.toThrow("identifiers only");
    await expect(
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).delete({ bookmarkIds: [], folderIds: ["x"] })),
    ).rejects.toThrow("identifiers only");
    expect((await rowsOf(scene.id)).bookmarks).toEqual([bookmark]);
  });
});

describe("against another call, a bulk delete and a member's removal", () => {
  async function settle<T>(work: Promise<T>): Promise<T | string> {
    const code = await refusedWith(work.then(() => undefined));
    return code === undefined ? work : `error:${code}`;
  }

  const remove = (scene: Workspace, bookmarkIds: readonly string[], folderIds: readonly string[], accountId = scene.admin) =>
    db.tenant.withTenant({ accountId, workspaceId: scene.id, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).delete({ bookmarkIds, folderIds }));

  it("queues concurrent calls over the same rows, named in opposite orders, on the workspace and ends with the counter equal to the rows without a deadlock", async () => {
    const scene = await workspaceOf();
    const bookmarks: string[] = [];
    const folderIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      bookmarks.push(await seedBookmark({ workspaceId: scene.id, title: `Ownerless ${String(index)}` }));
      folderIds.push(await seedFolder(scene.id, `Folder ${String(index)}`));
    }
    const kept = await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "Kept" });
    await syncCounter(scene.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const named = index % 2 === 0 ? bookmarks : bookmarks.toReversed();
        const folders = index % 2 === 0 ? folderIds : folderIds.toReversed();
        return settle(remove(scene, named.slice(0, 8 + index * 2), folders.slice(0, 5 + index * 2)));
      }),
    );

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    const deleted = results.flatMap((result) => (typeof result === "string" || result === undefined ? [] : [result.bookmarksDeleted]));
    // The forward calls reach the first 26 bookmarks and the backward ones the last 26: every ownerless bookmark goes, each deleted by one call alone.
    expect(deleted.reduce((sum, count) => sum + count, 0)).toBe(30);
    expect(await counter(scene.id)).toBe((await rowsOf(scene.id)).bookmarks.length);
    expect(await rowsOf(scene.id)).toEqual({ bookmarks: [kept], folders: [] });
  }, 60_000);

  it("runs with a member's own bulk delete and single deletes of the same workspace without a deadlock", async () => {
    const scene = await workspaceOf();
    const ownerless = await Promise.all(Array.from({ length: 10 }, (_, index) => seedBookmark({ workspaceId: scene.id, title: `Ownerless ${String(index)}` })));
    const own = await Promise.all(Array.from({ length: 10 }, (_, index) => seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: `Own ${String(index)}` })));
    await syncCounter(scene.id);
    const asMember = { accountId: scene.member, workspaceId: scene.id, requestId: "former-content-test" };

    const results = await Promise.all([
      settle(remove(scene, ownerless, [])),
      settle(db.tenant.withTenant(asMember, (tx) => bookmarkRepository(tx).removeMany({ bookmarkIds: own.slice(0, 6) }))),
      ...own.slice(4).map((bookmarkId) => settle(db.tenant.withTenant(asMember, (tx) => bookmarkRepository(tx).remove({ bookmarkId, ownerId: scene.member })))),
      settle(remove(scene, ownerless.toReversed(), [])),
    ]);

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    expect(await counter(scene.id)).toBe(0);
    expect((await rowsOf(scene.id)).bookmarks).toEqual([]);
  }, 60_000);

  it("runs with the removal of a member whose bookmarks it would otherwise reach: it queues on the workspace and finds them held by the departure", async () => {
    const scene = await workspaceOf();
    const leavers = await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "The leaver's" });
    const ownerless = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);
    const eventId = freshId();
    const departure: QueuedJob = {
      id: eventId,
      queue: MEMBER_LEFT_QUEUE,
      data: { eventId, workspaceId: scene.id, accountId: scene.member, content: "delete", transferTo: scene.admin },
    };

    let holds: () => void = () => undefined;
    const holdsWorkspace = new Promise<void>((resolve) => {
      holds = resolve;
    });
    const removed = settle(
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, async (tx) => {
        const members = memberRepository(tx);
        await members.roles(scene.member);
        holds();
        await tenantHandle(tx).execute(sql`SELECT pg_sleep(0.5)`);
        return members.remove(scene.member, [departure]);
      }),
    );
    await holdsWorkspace;
    // The call queues on the workspace's row behind the removal. The removal names its departure, so the leaver's bookmark has no owner but is held by that departure
    // when the call runs: the call skips it, deletes only the ownerless one, and the counter agrees.
    const deleted = await settle(remove(scene, [leavers, ownerless], []));

    expect(await removed).toBe(true);
    expect(deleted).not.toBe(`error:${DEADLOCK_DETECTED}`);
    expect(deleted).toEqual({ bookmarksDeleted: 1, foldersDeleted: 0 });
    const rows = (await rowsOf(scene.id)).bookmarks;
    expect(rows).toEqual([leavers]);
    expect(await asSystem(db, (tx) => tx`SELECT owner_id, departure_id FROM bookmarks WHERE id = ${leavers}`)).toEqual([{ owner_id: null, departure_id: eventId }]);
    expect(await counter(scene.id)).toBe(rows.length);
  }, 30_000);
});

// Giving that content to a member is `sys_former_content_reassign` (doc 05 sections 2.4 and 3.3, doc 02 sections 2.10 and 3.6, doc 10 T1, T2 and T11).
// The failure scenarios: an ownerless bookmark with the slug `docs` handed to a member who owns `docs` would break `bookmarks_owner_slug_key` and with it the
// call; a member who is no owner or admin gives content away by calling the function directly; a recipient who is no member, or a member of another workspace,
// receives rows; a row a member owns, one a departure still holds, a plan-archived bookmark or one of another workspace moves because its identifier was named; a
// folder and its filed bookmark end with two owners, which Q22 forbids; and a call that deadlocks against another call or a member's removal.

interface MovedAnswer {
  readonly bookmarks_moved: number | null;
  readonly folders_moved: number | null;
  readonly slugs_cleared: number | null;
  readonly folders_renamed: number | null;
  readonly filings_removed: number | null;
}

const NOTHING_DONE: MovedAnswer = { bookmarks_moved: null, folders_moved: null, slugs_cleared: null, folders_renamed: null, filings_removed: null };

const reassignCall = (tx: postgres.TransactionSql, workspaceId: string, recipient: string, bookmarkIds: readonly string[], folderIds: readonly string[]) =>
  tx<MovedAnswer[]>`SELECT * FROM public.sys_former_content_reassign(${workspaceId}::uuid, ${recipient}::uuid, ${`{${bookmarkIds.join(",")}}`}::uuid[], ${`{${folderIds.join(",")}}`}::uuid[])`.then((rows) => rows[0]);

/** The reassignment as `caller` of the scene's workspace, the way the application role reaches it. */
const reassignAs = (scene: Workspace, caller: string, recipient: string, bookmarkIds: readonly string[], folderIds: readonly string[]) =>
  appAs({ accountId: caller, workspaceId: scene.id }, (tx) => reassignCall(tx, scene.id, recipient, bookmarkIds, folderIds));

interface BookmarkState {
  readonly owner_id: string | null;
  readonly departure_id: string | null;
  readonly slug: string | null;
  readonly forwarding: boolean;
}

async function bookmarkState(id: string): Promise<BookmarkState | undefined> {
  return (await asSystem(db, (tx) => tx<BookmarkState[]>`SELECT owner_id, departure_id, slug, forwarding FROM bookmarks WHERE id = ${id}`))[0];
}

async function folderState(id: string): Promise<{ owner_id: string | null; departure_id: string | null; name: string } | undefined> {
  return (await asSystem(db, (tx) => tx<{ owner_id: string | null; departure_id: string | null; name: string }[]>`SELECT owner_id, departure_id, name::text AS name FROM folders WHERE id = ${id}`))[0];
}

async function ownersOf(workspaceId: string): Promise<{ bookmarks: (string | null)[]; folders: (string | null)[] }> {
  return asSystem(db, async (tx) => ({
    bookmarks: (await tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`).map((row) => row.owner_id),
    folders: (await tx<{ owner_id: string | null }[]>`SELECT owner_id FROM folders WHERE workspace_id = ${workspaceId} ORDER BY id`).map((row) => row.owner_id),
  }));
}

/** The filings that link a folder and a bookmark of different owners, which no operation may leave (doc 13 Q22). */
async function crossOwnerFilings(workspaceId: string): Promise<number> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM folder_bookmarks fb
      JOIN folders f ON f.workspace_id = fb.workspace_id AND f.id = fb.folder_id
      JOIN bookmarks b ON b.workspace_id = fb.workspace_id AND b.id = fb.bookmark_id
      WHERE fb.workspace_id = ${workspaceId} AND f.owner_id IS DISTINCT FROM b.owner_id`,
  );
  return rows[0]?.n ?? Number.NaN;
}

describe("sys_former_content_reassign", () => {
  it("FAILURE SCENARIO: an ownerless bookmark with the slug the recipient owns arrives without a slug and with forwarding off, and the call succeeds", async () => {
    const scene = await deleteScene();
    const own = await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "The recipient's docs", slug: "docs", forwarding: true });
    const clashing = await seedBookmark({ workspaceId: scene.id, title: "Former docs", slug: "docs", forwarding: true });
    const free = await seedBookmark({ workspaceId: scene.id, title: "Former wiki", slug: "wiki", forwarding: true });
    const plain = await seedBookmark({ workspaceId: scene.id, title: "Former, no slug" });
    await syncCounter(scene.id);

    const answer = await reassignAs(scene, scene.admin, scene.member, [clashing, free, plain], []);

    expect(answer).toEqual({ bookmarks_moved: 3, folders_moved: 0, slugs_cleared: 1, folders_renamed: 0, filings_removed: 0 });
    expect(await bookmarkState(clashing)).toEqual({ owner_id: scene.member, departure_id: null, slug: null, forwarding: false });
    expect(await bookmarkState(free)).toEqual({ owner_id: scene.member, departure_id: null, slug: "wiki", forwarding: true });
    expect(await bookmarkState(plain)).toEqual({ owner_id: scene.member, departure_id: null, slug: null, forwarding: false });
    expect(await bookmarkState(own)).toEqual({ owner_id: scene.member, departure_id: null, slug: "docs", forwarding: true });
  });

  it("holds the slug of a plan-archived bookmark of the recipient against the moved one, as the unique key does", async () => {
    const scene = await deleteScene();
    await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, planArchivedAt: new Date(), title: "Archived docs", slug: "docs" });
    const clashing = await seedBookmark({ workspaceId: scene.id, title: "Former docs", slug: "docs", forwarding: true });

    expect(await reassignAs(scene, scene.admin, scene.member, [clashing], [])).toEqual({ bookmarks_moved: 1, folders_moved: 0, slugs_cleared: 1, folders_renamed: 0, filings_removed: 0 });
    expect(await bookmarkState(clashing)).toEqual({ owner_id: scene.member, departure_id: null, slug: null, forwarding: false });
  });

  it("moves the folders to the recipient, renaming one whose name the recipient has without regard to case to the lowest free `<name> (<n>)`, in the order of creation", async () => {
    const scene = await deleteScene();
    await seedFolder(scene.id, "Reading", { ownerId: scene.member });
    await seedFolder(scene.id, "reading (2)", { ownerId: scene.member });
    await seedFolder(scene.id, "x".repeat(64), { ownerId: scene.member });
    const clashing = await seedFolder(scene.id, "reading");
    const free = await seedFolder(scene.id, "Free");
    const long = await seedFolder(scene.id, "x".repeat(64));
    // An ownerless folder that is named like what the first one is renamed to is renamed in its turn: the folders are judged one after the other.
    const later = await seedFolder(scene.id, "reading (3)");
    const recipientHas3 = await seedFolder(scene.id, "Third", { ownerId: scene.member });
    await asSystem(db, (tx) => tx`UPDATE folders SET name = 'READING (3)' WHERE id = ${recipientHas3}`);

    const answer = await reassignAs(scene, scene.admin, scene.member, [], [clashing, free, long, later]);

    expect(answer).toEqual({ bookmarks_moved: 0, folders_moved: 4, slugs_cleared: 0, folders_renamed: 3, filings_removed: 0 });
    expect(await folderState(clashing)).toEqual({ owner_id: scene.member, departure_id: null, name: "reading (4)" });
    expect(await folderState(free)).toEqual({ owner_id: scene.member, departure_id: null, name: "Free" });
    expect(await folderState(long)).toEqual({ owner_id: scene.member, departure_id: null, name: `${"x".repeat(60)} (2)` });
    expect(await folderState(later)).toEqual({ owner_id: scene.member, departure_id: null, name: "reading (3) (2)" });
  });

  it("leaves the counter equal to the rows, the shares, the tag links and the other columns of the moved rows as they were", async () => {
    const scene = await deleteScene();
    const moved = await seedBookmark({ workspaceId: scene.id, title: "Former", slug: "former", forwarding: true });
    const folder = await seedFolder(scene.id, "Former folder");
    const tagId = freshId();
    await asSystem(db, async (tx) => {
      await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${tagId}, ${scene.id}, ${scene.member}, 'mine')`;
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${scene.id}, ${moved}, ${tagId})`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id) VALUES (${freshId()}, ${scene.id}, ${moved}, ${scene.otherMember})`;
      await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id) VALUES (${freshId()}, ${scene.id}, ${folder}, ${scene.otherMember})`;
    });
    await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "Owned" });
    await seedBookmark({ workspaceId: scene.id, planArchivedAt: new Date(), title: "Plan-archived" });
    await syncCounter(scene.id);
    const before = await counter(scene.id);
    expect(before).toBe(2);

    expect(await reassignAs(scene, scene.roleAdmin, scene.otherMember, [moved], [folder])).toEqual({ bookmarks_moved: 1, folders_moved: 1, slugs_cleared: 0, folders_renamed: 0, filings_removed: 0 });

    expect(await counter(scene.id)).toBe(before);
    expect(await counter(scene.id)).toBe((await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${scene.id} AND plan_archived_at IS NULL`))[0]?.n);
    expect(await countOf("bookmark_tags", scene.id)).toBe(1);
    expect(await countOf("bookmark_shares", scene.id)).toBe(1);
    expect(await countOf("folder_shares", scene.id)).toBe(1);
  });

  it("FAILURE SCENARIO: a plain member's transaction that calls it directly moves nothing, whoever the recipient is", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless", slug: "ownerless" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    await syncCounter(scene.id);
    const before = await ownersOf(scene.id);

    for (const caller of [scene.member, scene.otherMember]) {
      expect(await reassignAs(scene, caller, caller, [bookmark], [folder])).toEqual(NOTHING_DONE);
      expect(await reassignAs(scene, caller, scene.admin, [bookmark], [folder])).toEqual(NOTHING_DONE);
    }
    // An account that is no member of the workspace at all, with the transaction acting in it.
    const stranger = await account();
    expect(await reassignAs(scene, stranger, scene.member, [bookmark], [folder])).toEqual(NOTHING_DONE);
    expect(await ownersOf(scene.id)).toEqual(before);

    const refused = await db.tenant.withTenant({ accountId: scene.member, workspaceId: scene.id, requestId: "former-content-test" }, (tx) =>
      formerContentRepository(tx).reassign({ bookmarkIds: [bookmark], folderIds: [folder], recipientId: scene.member }),
    );
    expect(refused).toEqual({ kind: "refused" });
    expect(await ownersOf(scene.id)).toEqual(before);
    expect(await bookmarkState(bookmark)).toEqual({ owner_id: null, departure_id: null, slug: "ownerless", forwarding: false });
  });

  it("a role taken away is not honoured: an admin demoted before the call acts as a member", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await asSystem(db, (tx) => tx`UPDATE workspace_members SET role = 'member' WHERE workspace_id = ${scene.id} AND account_id = ${scene.roleAdmin}`);

    expect(await reassignAs(scene, scene.roleAdmin, scene.member, [bookmark], [])).toEqual(NOTHING_DONE);
    expect((await bookmarkState(bookmark))?.owner_id).toBeNull();
  });

  it("moves nothing for a recipient who is no member of the workspace: another workspace's member, a gone member, an unknown account", async () => {
    const scene = await deleteScene();
    const other = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless", slug: "ownerless" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    const gone = await account();
    await syncCounter(scene.id);
    const before = await ownersOf(scene.id);

    for (const recipient of [other.member, other.admin, gone, freshId()]) {
      expect(await reassignAs(scene, scene.admin, recipient, [bookmark], [folder])).toEqual(NOTHING_DONE);
    }
    expect(await ownersOf(scene.id)).toEqual(before);

    const answer = (recipientId: string) =>
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, (tx) =>
        formerContentRepository(tx).reassign({ bookmarkIds: [bookmark], folderIds: [folder], recipientId }),
      );
    expect(await answer(other.member)).toEqual({ kind: "recipient_not_member" });
    expect(await answer(freshId())).toEqual({ kind: "recipient_not_member" });
    expect(await ownersOf(scene.id)).toEqual(before);
    // A member of the workspace receives them, the caller included.
    expect(await answer(scene.admin)).toEqual({ kind: "reassigned", bookmarksMoved: 1, foldersMoved: 1, slugsCleared: 0, foldersRenamed: 0, filingsRemoved: 0 });
  });

  it("moves nothing of a row a member owns, one a departure still holds, a plan-archived bookmark or one of another workspace, and the counter stays", async () => {
    const scene = await deleteScene();
    const other = await deleteScene();
    const listed = await seedBookmark({ workspaceId: scene.id, title: "Listed" });
    const listedFolder = await seedFolder(scene.id, "Listed folder");
    const protectedBookmarks = [
      await seedBookmark({ workspaceId: scene.id, ownerId: scene.otherMember, title: "Owned by another member", slug: "taken" }),
      await seedBookmark({ workspaceId: scene.id, ownerId: scene.admin, title: "Owned by the caller" }),
      await seedBookmark({ workspaceId: scene.id, departureId: DEPARTURE, title: "Held by a departure" }),
      await seedBookmark({ workspaceId: scene.id, planArchivedAt: new Date(), title: "Plan-archived" }),
      await seedBookmark({ workspaceId: other.id, title: "Ownerless in another workspace" }),
      await seedBookmark({ workspaceId: other.id, ownerId: other.member, title: "Owned in another workspace" }),
    ];
    const protectedFolders = [
      await seedFolder(scene.id, "Owned folder", { ownerId: scene.otherMember }),
      await seedFolder(scene.id, "Held folder", { departureId: DEPARTURE }),
      await seedFolder(other.id, "Ownerless folder of another workspace"),
    ];
    await syncCounter(scene.id);
    await syncCounter(other.id);
    const before = { scene: await ownersOf(scene.id), other: await ownersOf(other.id), counters: [await counter(scene.id), await counter(other.id)] };
    const states = await Promise.all(protectedBookmarks.map((id) => bookmarkState(id)));

    const answer = await reassignAs(scene, scene.admin, scene.member, [...protectedBookmarks, freshId()], [...protectedFolders, freshId()]);

    expect(answer).toEqual({ bookmarks_moved: 0, folders_moved: 0, slugs_cleared: 0, folders_renamed: 0, filings_removed: 0 });
    expect({ scene: await ownersOf(scene.id), other: await ownersOf(other.id), counters: [await counter(scene.id), await counter(other.id)] }).toEqual(before);
    expect(await Promise.all(protectedBookmarks.map((id) => bookmarkState(id)))).toEqual(states);

    // The same request that also names a row that may move moves that row alone.
    const mixed = await reassignAs(scene, scene.admin, scene.member, [...protectedBookmarks, listed, listed], [...protectedFolders, listedFolder]);
    expect(mixed).toEqual({ bookmarks_moved: 1, folders_moved: 1, slugs_cleared: 0, folders_renamed: 0, filings_removed: 0 });
    expect(await bookmarkState(listed)).toMatchObject({ owner_id: scene.member });
    expect(await folderState(listedFolder)).toMatchObject({ owner_id: scene.member });
    expect(await ownersOf(other.id)).toEqual(before.other);
    expect(await counter(scene.id)).toBe(before.counters[0]);
  });

  it("leaves no filing between a folder and a bookmark of different owners: the filing of a folder and its bookmark moved to two members is removed, and one moved together stays", async () => {
    const scene = await deleteScene();
    const together = await seedFolder(scene.id, "Together");
    const togetherBookmark = await seedBookmark({ workspaceId: scene.id, title: "Together bookmark" });
    const apart = await seedFolder(scene.id, "Apart");
    const apartBookmark = await seedBookmark({ workspaceId: scene.id, title: "Apart bookmark" });
    const folderOnly = await seedFolder(scene.id, "Folder only");
    const staysOwnerless = await seedBookmark({ workspaceId: scene.id, title: "Stays ownerless" });
    const untouched = await seedFolder(scene.id, "Untouched");
    const untouchedBookmark = await seedBookmark({ workspaceId: scene.id, title: "Untouched bookmark" });
    const memberFolder = await seedFolder(scene.id, "A member's folder", { ownerId: scene.otherMember });
    const memberBookmark = await seedBookmark({ workspaceId: scene.id, ownerId: scene.otherMember, title: "A member's bookmark" });
    await file(scene.id, together, togetherBookmark);
    await file(scene.id, apart, apartBookmark);
    await file(scene.id, folderOnly, staysOwnerless);
    await file(scene.id, untouched, untouchedBookmark);
    await file(scene.id, memberFolder, memberBookmark);

    // The folder and its bookmark together to one member: the filing is the owner's and stays.
    expect(await reassignAs(scene, scene.admin, scene.member, [togetherBookmark], [together])).toMatchObject({ bookmarks_moved: 1, folders_moved: 1, filings_removed: 0 });
    // The folder to one member and its bookmark to another, in two calls: the second call removes the filing.
    expect(await reassignAs(scene, scene.admin, scene.member, [], [apart])).toMatchObject({ folders_moved: 1, filings_removed: 1 });
    expect(await countOf("folder_bookmarks", scene.id)).toBe(4);
    expect(await reassignAs(scene, scene.admin, scene.otherMember, [apartBookmark], [])).toMatchObject({ bookmarks_moved: 1, filings_removed: 0 });
    // A folder moved with a bookmark that stays ownerless, whose filing would cross.
    expect(await reassignAs(scene, scene.admin, scene.member, [], [folderOnly])).toMatchObject({ folders_moved: 1, filings_removed: 1 });

    expect(await crossOwnerFilings(scene.id)).toBe(0);
    const filings = await asSystem(db, (tx) => tx<{ folder_id: string; bookmark_id: string }[]>`SELECT folder_id, bookmark_id FROM folder_bookmarks WHERE workspace_id = ${scene.id} ORDER BY folder_id`);
    expect(filings.map((row) => row.folder_id).toSorted()).toEqual([together, untouched, memberFolder].toSorted());
  });

  it("removes the filings of the moved rows that cross owners in the call that moved them, counted once each, and no filing it did not move", async () => {
    const scene = await deleteScene();
    const folder = await seedFolder(scene.id, "Folder");
    const bookmarks = await Promise.all([1, 2, 3].map((n) => seedBookmark({ workspaceId: scene.id, title: `Ownerless ${String(n)}` })));
    const heldBookmark = await seedBookmark({ workspaceId: scene.id, departureId: DEPARTURE, title: "Held by a departure" });
    const otherFolder = await seedFolder(scene.id, "Other folder");
    const otherBookmark = await seedBookmark({ workspaceId: scene.id, title: "Other bookmark" });
    for (const bookmark of [...bookmarks, heldBookmark]) {
      await file(scene.id, folder, bookmark);
    }
    await file(scene.id, otherFolder, otherBookmark);

    // The folder alone moves: its four filings (three ownerless bookmarks and one a departure holds) would cross.
    expect(await reassignAs(scene, scene.admin, scene.member, [], [folder])).toEqual({ bookmarks_moved: 0, folders_moved: 1, slugs_cleared: 0, folders_renamed: 0, filings_removed: 4 });
    expect(await countOf("folder_bookmarks", scene.id)).toBe(1);
    expect(await asSystem(db, (tx) => tx`SELECT folder_id FROM folder_bookmarks WHERE workspace_id = ${scene.id}`)).toEqual([{ folder_id: otherFolder }]);
  });

  it("raises on a NULL workspace, recipient or list, a NULL element and more than 1 000 positions in either list, and moves nothing", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    const settings = { accountId: scene.admin, workspaceId: scene.id };
    const before = await ownersOf(scene.id);
    const calls = [
      (tx: postgres.TransactionSql) => tx`SELECT * FROM public.sys_former_content_reassign(NULL, ${scene.member}::uuid, '{}'::uuid[], '{}'::uuid[])`,
      (tx: postgres.TransactionSql) => tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, NULL, '{}'::uuid[], '{}'::uuid[])`,
      (tx: postgres.TransactionSql) => tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, NULL, '{}'::uuid[])`,
      (tx: postgres.TransactionSql) => tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, '{}'::uuid[], NULL)`,
      (tx: postgres.TransactionSql) => tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, ${`{${bookmark},NULL}`}::uuid[], '{}'::uuid[])`,
      (tx: postgres.TransactionSql) => tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, '{}'::uuid[], ${`{NULL}`}::uuid[])`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1001)), '{}'::uuid[])`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, '{}'::uuid[], ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1001)))`,
    ];
    for (const call of calls) {
      await expect(refusedWith(appAs(settings, call))).resolves.toBe(INVALID_PARAMETER_VALUE);
    }
    // Exactly 1 000 positions in each list is allowed.
    await expect(
      appAs(settings, (tx) =>
        tx`SELECT * FROM public.sys_former_content_reassign(${scene.id}::uuid, ${scene.member}::uuid, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1000)), ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1000)))`,
      ),
    ).resolves.toHaveLength(1);
    expect(await ownersOf(scene.id)).toEqual(before);
  });

  it("answers NULL and writes nothing when the transaction acts in another workspace or in none, or in a workspace being deleted", async () => {
    const a = await deleteScene();
    const b = await deleteScene();
    const ofB = await seedBookmark({ workspaceId: b.id, title: "Ownerless in B" });
    const folderOfB = await seedFolder(b.id, "Ownerless folder in B");
    const before = await ownersOf(b.id);

    expect(await appAs({ accountId: a.admin, workspaceId: a.id }, (tx) => reassignCall(tx, b.id, b.member, [ofB], [folderOfB]))).toEqual(NOTHING_DONE);
    expect(await appAs({ accountId: b.admin }, (tx) => reassignCall(tx, b.id, b.member, [ofB], [folderOfB]))).toEqual(NOTHING_DONE);
    expect(await appAs({ accountId: b.admin, workspaceId: b.id }, (tx) => reassignCall(tx, a.id, b.member, [ofB], [folderOfB]))).toEqual(NOTHING_DONE);
    // An account of A that acts in B is no member of B.
    expect(await appAs({ accountId: a.admin, workspaceId: b.id }, (tx) => reassignCall(tx, b.id, b.member, [ofB], [folderOfB]))).toEqual(NOTHING_DONE);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${b.id}`);
    expect(await appAs({ accountId: b.admin, workspaceId: b.id }, (tx) => reassignCall(tx, b.id, b.member, [ofB], [folderOfB]))).toEqual(NOTHING_DONE);
    expect(await ownersOf(b.id)).toEqual(before);
  });

  it("is the only way the application role changes the owner of a bookmark or a folder", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    const settings = { accountId: scene.admin, workspaceId: scene.id };

    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE bookmarks SET owner_id = ${scene.admin} WHERE id = ${bookmark}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE folders SET owner_id = ${scene.admin} WHERE id = ${folder}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await bookmarkState(bookmark))?.owner_id).toBeNull();
    expect((await folderState(folder))?.owner_id).toBeNull();
  });

  it("rolls the whole call back when a step fails: the moves and the removed filings are not kept", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless", slug: "kept" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    const otherBookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless, filed" });
    await file(scene.id, folder, otherBookmark);
    // The removal of the filing is the last write of the call; a trigger that refuses it for this workspace fails the call after the folders and the bookmarks moved.
    await db.owner.unsafe(`
      CREATE FUNCTION public.refuse_filing_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.workspace_id = '${scene.id}' THEN RAISE EXCEPTION 'refused for the test' USING ERRCODE = 'P0001'; END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER refuse_filing_delete BEFORE DELETE ON public.folder_bookmarks FOR EACH ROW EXECUTE FUNCTION public.refuse_filing_delete();`);
    try {
      await expect(refusedWith(reassignAs(scene, scene.admin, scene.member, [bookmark], [folder]))).resolves.toBe("P0001");
    } finally {
      await db.owner.unsafe("DROP TRIGGER refuse_filing_delete ON public.folder_bookmarks; DROP FUNCTION public.refuse_filing_delete()");
    }

    expect(await ownersOf(scene.id)).toEqual({ bookmarks: [null, null], folders: [null] });
    expect(await bookmarkState(bookmark)).toEqual({ owner_id: null, departure_id: null, slug: "kept", forwarding: false });
    expect(await countOf("folder_bookmarks", scene.id)).toBe(1);
  });

  it("resolves collisions as the departure's transfer does: the same slugs, forwarding and names for the same content", async () => {
    // The same content, once as the rows of a departure that sys_member_departure_apply hands over and once as former members' content that the function hands over.
    async function prepared(held: boolean): Promise<{ scene: DeleteScene; bookmarks: string[]; folders: string[] }> {
      const scene = await deleteScene();
      const departureId = held ? DEPARTURE : null;
      await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "Own docs", slug: "docs", forwarding: true });
      await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, planArchivedAt: new Date(), title: "Own archived", slug: "archived" });
      for (const name of ["Reading", "Reading (2)", "x".repeat(64)]) {
        await seedFolder(scene.id, name, { ownerId: scene.member });
      }
      const bookmarks = [
        await seedBookmark({ workspaceId: scene.id, departureId, title: "docs", slug: "docs", forwarding: true }),
        await seedBookmark({ workspaceId: scene.id, departureId, title: "archived", slug: "archived", forwarding: true }),
        await seedBookmark({ workspaceId: scene.id, departureId, title: "wiki", slug: "wiki", forwarding: true }),
        await seedBookmark({ workspaceId: scene.id, departureId, title: "bare" }),
      ];
      const folders = [
        await seedFolder(scene.id, "reading", { departureId }),
        await seedFolder(scene.id, "x".repeat(64), { departureId }),
        await seedFolder(scene.id, "Fresh", { departureId }),
        await seedFolder(scene.id, "reading (2)", { departureId }),
      ];
      return { scene, bookmarks, folders };
    }
    const outcome = async (scene: DeleteScene) => ({
      bookmarks: await asSystem(db, (tx) => tx`SELECT title, owner_id = ${scene.member} AS recipient_owns, slug, forwarding FROM bookmarks WHERE workspace_id = ${scene.id} AND owner_id IS NOT DISTINCT FROM ${scene.member} ORDER BY title`),
      folders: await asSystem(db, (tx) => tx`SELECT name::text AS name FROM folders WHERE workspace_id = ${scene.id} AND owner_id = ${scene.member} ORDER BY name`),
    });

    const departing = await prepared(true);
    const answered = await appAs({ accountId: departing.scene.member, workspaceId: departing.scene.id }, async (tx) => {
      const rows = await tx<{ bookmarks_moved: number; folders_moved: number; slugs_cleared: number; folders_renamed: number }[]>`
        SELECT bookmarks_moved, folders_moved, slugs_cleared, folders_renamed FROM public.sys_member_departure_apply(${departing.scene.id}::uuid, ${DEPARTURE}::uuid, 'transfer'::text, ${departing.scene.member}::uuid)`;
      return rows[0];
    });
    const former = await prepared(false);
    const reassigned = await reassignAs(former.scene, former.scene.admin, former.scene.member, former.bookmarks, former.folders);

    expect(answered).toEqual({ bookmarks_moved: 4, folders_moved: 4, slugs_cleared: 2, folders_renamed: 3 });
    expect(reassigned).toEqual({ bookmarks_moved: 4, folders_moved: 4, slugs_cleared: 2, folders_renamed: 3, filings_removed: 0 });
    expect(await outcome(former.scene)).toEqual(await outcome(departing.scene));
  });
});

describe("formerContentRepository.reassign", () => {
  it("reassigns through the function and answers the counts, takes an identifier named twice once and skips an unknown one", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless", slug: "docs", forwarding: true });
    await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "Own docs", slug: "docs" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    await seedFolder(scene.id, "ownerless folder", { ownerId: scene.member });
    await syncCounter(scene.id);

    const answer = await db.tenant.withTenant({ accountId: scene.roleAdmin, workspaceId: scene.id, requestId: "former-content-test" }, (tx) =>
      formerContentRepository(tx).reassign({ bookmarkIds: [bookmark, bookmark.toUpperCase(), freshId()], folderIds: [folder], recipientId: scene.member.toUpperCase() }),
    );

    expect(answer).toEqual({ kind: "reassigned", bookmarksMoved: 1, foldersMoved: 1, slugsCleared: 1, foldersRenamed: 1, filingsRemoved: 0 });
    expect(await bookmarkState(bookmark)).toEqual({ owner_id: scene.member, departure_id: null, slug: null, forwarding: false });
    expect(await folderState(folder)).toEqual({ owner_id: scene.member, departure_id: null, name: "Ownerless folder (2)" });
    expect(await counter(scene.id)).toBe(2);
  });

  it("refuses a transaction opened without a workspace and a name that is not an identifier, and moves nothing", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    const asAdmin = { accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" };

    await expect(
      db.tenant.withTenant({ accountId: scene.admin, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).reassign({ bookmarkIds: [bookmark], folderIds: [], recipientId: scene.member })),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(db.tenant.withTenant(asAdmin, (tx) => formerContentRepository(tx).reassign({ bookmarkIds: ["x"], folderIds: [], recipientId: scene.member }))).rejects.toThrow("identifiers only");
    await expect(db.tenant.withTenant(asAdmin, (tx) => formerContentRepository(tx).reassign({ bookmarkIds: [], folderIds: ["x"], recipientId: scene.member }))).rejects.toThrow("identifiers only");
    await expect(db.tenant.withTenant(asAdmin, (tx) => formerContentRepository(tx).reassign({ bookmarkIds: [bookmark], folderIds: [], recipientId: "x" }))).rejects.toThrow("identifiers only");
    expect((await bookmarkState(bookmark))?.owner_id).toBeNull();
  });
});

describe("a reassignment against another call, a bulk delete and a member's removal", () => {
  async function settle<T>(work: Promise<T>): Promise<T | string> {
    const code = await refusedWith(work.then(() => undefined));
    return code === undefined ? work : `error:${code}`;
  }

  const reassign = (scene: Workspace, recipientId: string, bookmarkIds: readonly string[], folderIds: readonly string[], accountId = scene.admin) =>
    db.tenant.withTenant({ accountId, workspaceId: scene.id, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).reassign({ bookmarkIds, folderIds, recipientId }));

  function departureOf(scene: Workspace, accountId: string): { eventId: string; job: QueuedJob } {
    const eventId = freshId();
    return { eventId, job: { id: eventId, queue: MEMBER_LEFT_QUEUE, data: { eventId, workspaceId: scene.id, accountId, content: "delete", transferTo: scene.admin } } };
  }

  /** Holds the workspace's row (the lock a removal or a role change takes first) for half a second while `during` runs and queues behind it. */
  async function holdingTheWorkspace<T>(scene: Workspace, hold: (tx: TenantTx) => Promise<unknown>, during: () => Promise<T>): Promise<{ held: unknown; during: T }> {
    let holds: () => void = () => undefined;
    const holdsWorkspace = new Promise<void>((resolve) => {
      holds = resolve;
    });
    const held = settle(
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, async (tx) => {
        const result = await hold(tx);
        holds();
        await tenantHandle(tx).execute(sql`SELECT pg_sleep(0.5)`);
        return result;
      }),
    );
    await holdsWorkspace;
    const queued = await during();
    return { held: await held, during: queued };
  }

  it("queues concurrent calls over the same rows, named in opposite orders, to two recipients on the workspace: each row moves once, with no deadlock", async () => {
    const scene = await workspaceOf();
    const second = await account();
    await seedMember(db, { workspaceId: scene.id, accountId: second, role: "member" });
    const bookmarks: string[] = [];
    const folderIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      bookmarks.push(await seedBookmark({ workspaceId: scene.id, title: `Ownerless ${String(index)}`, slug: `slug-${String(index)}` }));
      folderIds.push(await seedFolder(scene.id, `Folder ${String(index)}`));
    }
    for (let index = 0; index < 30; index += 1) {
      await file(scene.id, folderIds[index] ?? "", bookmarks[index] ?? "");
    }
    await syncCounter(scene.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const named = index % 2 === 0 ? bookmarks : bookmarks.toReversed();
        const folders = index % 2 === 0 ? folderIds : folderIds.toReversed();
        return settle(reassign(scene, index % 3 === 0 ? second : scene.member, named.slice(0, 8 + index * 2), folders.slice(0, 5 + index * 2)));
      }),
    );

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    const answers = results.flatMap((result) => (typeof result === "string" || result.kind !== "reassigned" ? [] : [result]));
    // The forward calls reach the first 24 bookmarks and the backward ones the last 26: every ownerless bookmark moves, each moved by one call alone.
    expect(answers.reduce((sum, answer) => sum + answer.bookmarksMoved, 0)).toBe(30);
    expect(answers.reduce((sum, answer) => sum + answer.foldersMoved, 0)).toBe(30);
    expect((await ownersOf(scene.id)).bookmarks.every((owner) => owner !== null)).toBe(true);
    expect(await counter(scene.id)).toBe(30);
    // Whichever call moved a folder or a bookmark first, no filing links two owners when the calls are done.
    expect(await crossOwnerFilings(scene.id)).toBe(0);
  }, 60_000);

  it("runs with a member's own bulk delete and single deletes of the same workspace without a deadlock", async () => {
    const scene = await workspaceOf();
    const ownerless = await Promise.all(Array.from({ length: 10 }, (_, index) => seedBookmark({ workspaceId: scene.id, title: `Ownerless ${String(index)}` })));
    const own = await Promise.all(Array.from({ length: 10 }, (_, index) => seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: `Own ${String(index)}` })));
    await syncCounter(scene.id);
    const asMember = { accountId: scene.member, workspaceId: scene.id, requestId: "former-content-test" };

    const results = await Promise.all([
      settle(reassign(scene, scene.member, ownerless, [])),
      settle(db.tenant.withTenant(asMember, (tx) => bookmarkRepository(tx).removeMany({ bookmarkIds: own.slice(0, 6) }))),
      ...own.slice(4).map((bookmarkId) => settle(db.tenant.withTenant(asMember, (tx) => bookmarkRepository(tx).remove({ bookmarkId, ownerId: scene.member })))),
      settle(reassign(scene, scene.admin, ownerless.toReversed(), [])),
    ]);

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    expect(await counter(scene.id)).toBe(10);
    expect((await rowsOf(scene.id)).bookmarks).toHaveLength(10);
  }, 60_000);

  it("queues behind the removal of a member whose bookmarks it would reach: they are held by the departure and are skipped", async () => {
    const scene = await workspaceOf();
    const leavers = await seedBookmark({ workspaceId: scene.id, ownerId: scene.member, title: "The leaver's" });
    const ownerless = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);
    const { eventId, job } = departureOf(scene, scene.member);

    const { held, during } = await holdingTheWorkspace(
      scene,
      async (tx) => {
        const members = memberRepository(tx);
        await members.roles(scene.member);
        return members.remove(scene.member, [job]);
      },
      () => settle(reassign(scene, scene.admin, [leavers, ownerless], [])),
    );

    expect(held).toBe(true);
    expect(during).toEqual({ kind: "reassigned", bookmarksMoved: 1, foldersMoved: 0, slugsCleared: 0, foldersRenamed: 0, filingsRemoved: 0 });
    expect(await asSystem(db, (tx) => tx`SELECT owner_id, departure_id FROM bookmarks WHERE id = ${leavers}`)).toEqual([{ owner_id: null, departure_id: eventId }]);
    expect(await asSystem(db, (tx) => tx`SELECT owner_id FROM bookmarks WHERE id = ${ownerless}`)).toEqual([{ owner_id: scene.admin }]);
    expect(await counter(scene.id)).toBe(2);
  }, 30_000);

  it("queues behind the removal of its recipient and then finds no member to receive the rows: nothing moves", async () => {
    const scene = await workspaceOf();
    const ownerless = await seedBookmark({ workspaceId: scene.id, title: "Ownerless", slug: "docs" });
    const folder = await seedFolder(scene.id, "Ownerless folder");
    await syncCounter(scene.id);
    const { job } = departureOf(scene, scene.member);

    const { held, during } = await holdingTheWorkspace(
      scene,
      async (tx) => {
        const members = memberRepository(tx);
        await members.roles(scene.member);
        return members.remove(scene.member, [job]);
      },
      () => settle(reassign(scene, scene.member, [ownerless], [folder])),
    );

    expect(held).toBe(true);
    expect(during).toEqual({ kind: "recipient_not_member" });
    expect(await ownersOf(scene.id)).toEqual({ bookmarks: [null], folders: [null] });
    expect(await bookmarkState(ownerless)).toEqual({ owner_id: null, departure_id: null, slug: "docs", forwarding: false });
  }, 30_000);

  it("followed by the removal of its recipient: the moved rows go with the recipient's content to the departure, with no deadlock", async () => {
    const scene = await workspaceOf();
    const ownerless = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });
    await syncCounter(scene.id);
    const { eventId, job } = departureOf(scene, scene.member);

    let holds: () => void = () => undefined;
    const holdsWorkspace = new Promise<void>((resolve) => {
      holds = resolve;
    });
    const moving = settle(
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, async (tx) => {
        const answer = await formerContentRepository(tx).reassign({ bookmarkIds: [ownerless], folderIds: [], recipientId: scene.member });
        holds();
        await tenantHandle(tx).execute(sql`SELECT pg_sleep(0.5)`);
        return answer;
      }),
    );
    await holdsWorkspace;
    const removed = await settle(
      db.tenant.withTenant({ accountId: scene.admin, workspaceId: scene.id, requestId: "former-content-test" }, async (tx) => {
        const members = memberRepository(tx);
        await members.roles(scene.member);
        return members.remove(scene.member, [job]);
      }),
    );

    expect(await moving).toMatchObject({ kind: "reassigned", bookmarksMoved: 1 });
    expect(removed).toBe(true);
    expect(await asSystem(db, (tx) => tx`SELECT owner_id, departure_id FROM bookmarks WHERE id = ${ownerless}`)).toEqual([{ owner_id: null, departure_id: eventId }]);
  }, 30_000);

  it("reads the caller's role after the workspace's row is locked: an admin demoted by a change it queued behind moves nothing", async () => {
    const scene = await deleteScene();
    const ownerless = await seedBookmark({ workspaceId: scene.id, title: "Ownerless" });

    const { held, during } = await holdingTheWorkspace(
      scene,
      async (tx) => {
        const members = memberRepository(tx);
        await members.roles(scene.roleAdmin);
        return members.setRole(scene.roleAdmin, "member");
      },
      () => settle(reassign(scene, scene.member, [ownerless], [], scene.roleAdmin)),
    );

    expect(held).toBe(true);
    expect(during).toEqual({ kind: "refused" });
    expect(await bookmarkState(ownerless)).toMatchObject({ owner_id: null });
  }, 30_000);
});

// The recipient's own writers (a folder created or renamed, a slug set) take no lock of the workspace, so a name or slug they write while a reassignment runs is
// invisible to the check that precedes its update. The failure scenario: the recipient's transaction holds a folder named like the one being moved, or a slug like the
// moved bookmark's, uncommitted; the update of the reassignment waits on it, and when it commits the update raised the unique violation and the whole call rolled back
// instead of renaming the folder or clearing the slug.
describe("sys_former_content_reassign against the recipient's concurrent writes", () => {
  const insertFolder = (workspaceId: string, ownerId: string, name: string) => (tx: postgres.TransactionSql) =>
    tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${workspaceId}, ${ownerId}, ${name})`;

  const insertBookmark = (workspaceId: string, ownerId: string, slug: string) => (tx: postgres.TransactionSql) =>
    tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      VALUES (${freshId()}, ${workspaceId}, ${ownerId}, 'https://example.com/own', 'https://example.com/own', 'example.com', 'Own', ${slug}, true)`;

  it("FAILURE SCENARIO: renames a moved folder to the next free name when the recipient commits a same-named folder, without regard to case, while the call waits", async () => {
    const scene = await deleteScene();
    const folder = await seedFolder(scene.id, "Research");

    const answer = await withUncommittedWrite(db, insertFolder(scene.id, scene.member, "RESEARCH"), () => reassignAs(scene, scene.admin, scene.member, [], [folder]));

    expect(answer).toEqual({ bookmarks_moved: 0, folders_moved: 1, slugs_cleared: 0, folders_renamed: 1, filings_removed: 0 });
    expect(await folderState(folder)).toEqual({ owner_id: scene.member, departure_id: null, name: "Research (2)" });
  }, 60_000);

  it("skips every name the recipient commits meanwhile: `Research` and `Research (2)` lead to `Research (3)`", async () => {
    const scene = await deleteScene();
    const folder = await seedFolder(scene.id, "Research");

    const answer = await withUncommittedWrite(
      db,
      async (tx) => {
        await insertFolder(scene.id, scene.member, "Research")(tx);
        await insertFolder(scene.id, scene.member, "research (2)")(tx);
      },
      () => reassignAs(scene, scene.admin, scene.member, [], [folder]),
    );

    expect(answer).toEqual({ bookmarks_moved: 0, folders_moved: 1, slugs_cleared: 0, folders_renamed: 1, filings_removed: 0 });
    expect(await folderState(folder)).toEqual({ owner_id: scene.member, departure_id: null, name: "Research (3)" });
  }, 60_000);

  it("keeps the name when the recipient's competing folder is rolled back", async () => {
    const scene = await deleteScene();
    const folder = await seedFolder(scene.id, "Research");

    const answer = await withUncommittedWrite(db, insertFolder(scene.id, scene.member, "Research"), () => reassignAs(scene, scene.admin, scene.member, [], [folder]), {
      commit: false,
    });

    expect(answer).toEqual({ bookmarks_moved: 0, folders_moved: 1, slugs_cleared: 0, folders_renamed: 0, filings_removed: 0 });
    expect(await folderState(folder)).toEqual({ owner_id: scene.member, departure_id: null, name: "Research" });
  }, 60_000);

  it("FAILURE SCENARIO: clears the slug and turns forwarding off on a moved bookmark when the recipient commits the same slug while the call waits, and counts it", async () => {
    const scene = await deleteScene();
    const clashing = await seedBookmark({ workspaceId: scene.id, title: "Former spec", slug: "spec", forwarding: true });
    const free = await seedBookmark({ workspaceId: scene.id, title: "Former wiki", slug: "wiki", forwarding: true });
    await syncCounter(scene.id);

    const answer = await withUncommittedWrite(db, insertBookmark(scene.id, scene.member, "spec"), () => reassignAs(scene, scene.admin, scene.member, [clashing, free], []));

    expect(answer).toEqual({ bookmarks_moved: 2, folders_moved: 0, slugs_cleared: 1, folders_renamed: 0, filings_removed: 0 });
    expect(await bookmarkState(clashing)).toEqual({ owner_id: scene.member, departure_id: null, slug: null, forwarding: false });
    expect(await bookmarkState(free)).toEqual({ owner_id: scene.member, departure_id: null, slug: "wiki", forwarding: true });
  }, 60_000);

  it("keeps the slug when the recipient's competing bookmark is rolled back", async () => {
    const scene = await deleteScene();
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Former spec", slug: "spec", forwarding: true });

    const answer = await withUncommittedWrite(db, insertBookmark(scene.id, scene.member, "spec"), () => reassignAs(scene, scene.admin, scene.member, [bookmark], []), {
      commit: false,
    });

    expect(answer).toEqual({ bookmarks_moved: 1, folders_moved: 0, slugs_cleared: 0, folders_renamed: 0, filings_removed: 0 });
    expect(await bookmarkState(bookmark)).toEqual({ owner_id: scene.member, departure_id: null, slug: "spec", forwarding: true });
  }, 60_000);

  it("still ends the call, moving nothing, on a unique violation of another constraint than the name and slug keys", async () => {
    const scene = await deleteScene();
    const folder = await seedFolder(scene.id, "Research");
    const bookmark = await seedBookmark({ workspaceId: scene.id, title: "Former spec", slug: "spec", forwarding: true });
    // The same uniqueness under other names is a different constraint to the function, which must not resolve it.
    await db.owner.unsafe("ALTER TABLE folders RENAME CONSTRAINT folders_owner_name_key TO folders_other_key; ALTER INDEX bookmarks_owner_slug_key RENAME TO bookmarks_other_key");
    try {
      const folderRefusal = await refusedWith(
        withUncommittedWrite(db, insertFolder(scene.id, scene.member, "Research"), () => reassignAs(scene, scene.admin, scene.member, [], [folder])),
      );
      const slugRefusal = await refusedWith(
        withUncommittedWrite(db, insertBookmark(scene.id, scene.member, "spec"), () => reassignAs(scene, scene.admin, scene.member, [bookmark], [])),
      );

      expect(folderRefusal).toBe("23505");
      expect(slugRefusal).toBe("23505");
    } finally {
      await db.owner.unsafe("ALTER TABLE folders RENAME CONSTRAINT folders_other_key TO folders_owner_name_key; ALTER INDEX bookmarks_other_key RENAME TO bookmarks_owner_slug_key");
    }

    expect(await folderState(folder)).toEqual({ owner_id: null, departure_id: null, name: "Research" });
    expect(await bookmarkState(bookmark)).toEqual({ owner_id: null, departure_id: null, slug: "spec", forwarding: true });
  }, 60_000);
});
