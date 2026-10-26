import type { BookmarkFolderRef } from "@slugbase/core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The links between a member's bookmarks and the member's folders (doc 05 section 2.4, doc 02 sections 7.1 and 8.2, doc 10 T1 and T2),
// shared by the folder and the bookmark repositories. A link is the owner's alone: every statement names the workspace of the transaction and
// the owner of both sides, and the policies of `folder_bookmarks` (src/sql/540-folder-filing.sql) refuse a link whose folder or bookmark is
// not the account's own in that workspace, so a statement that forgot a predicate still writes nothing of anyone else's. Before a link is
// written both sides are locked with `FOR KEY SHARE`, in the order of their identifiers: a folder or a bookmark that a concurrent
// transaction deletes is then either found gone or waited for, and never met half-way by the foreign key of the link. A transaction that
// also takes the lock of the workspace's row (a creation, through `sys_bookmark_count_take`) takes that one first and the folders after it,
// the order of the statements that update a folder as a member leaves (`folders_rename_on_release` locks the workspace's row first).

// The registry entry of `folder_bookmarks` for the cross-tenant matrix (doc 08 section 3.3): the application role may read, insert (the three columns
// of a link) and delete links, and the policies keep each to the account's own folder and bookmark. Links are written in sets by `insertLinks`, whose
// statement is the one the entry's insert is judged by, and removed through the entry's delete.
const scoped = defineScopedRepository("folder_bookmarks", folderBookmarks, {
  methods: ["select", "insert", "delete"],
  insertColumns: ["folderId", "bookmarkId"],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireIdentifiers(ids: readonly string[], action: string): void {
  if (!ids.every((id) => UUID.test(id))) {
    throw new Error(`${action} takes identifiers only`);
  }
}

/** One parameter, whatever the number of identifiers: a PostgreSQL array literal of UUIDs, which hold no character it would need to quote. */
export function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(",")}}`;
}

function requireWorkspace(tx: TenantTx, action: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${action} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

/** The identifiers without repeats, lower-cased, in a stable order. */
export function distinctIdentifiers(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

/**
 * Locks the folders of `folderIds` that `ownerId` owns in the workspace of the transaction (`FOR KEY SHARE`, unless `lock` is false, which only reads
 * them), and answers whether every one of them exists.
 */
export async function lockOwnedFolders(tx: TenantTx, ownerId: string, folderIds: readonly string[], lock = true): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "filing bookmarks");
  const wanted = distinctIdentifiers(folderIds);
  requireIdentifiers(wanted, "filing bookmarks");
  if (wanted.length === 0) {
    return true;
  }
  const query = tenantHandle(tx)
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.workspaceId, workspaceId), eq(folders.ownerId, ownerId), sql`${folders.id} = ANY (${uuidArray(wanted)}::uuid[])`))
    .orderBy(folders.id);
  return (lock ? await query.for("key share") : await query).length === wanted.length;
}

/**
 * Locks the bookmarks of `bookmarkIds` that `ownerId` owns in the workspace of the transaction, and answers whether every one of them exists.
 * A plan-archived bookmark is not one the product shows or edits, so it counts only when `archived` is `include`.
 */
export async function lockOwnedBookmarks(tx: TenantTx, ownerId: string, bookmarkIds: readonly string[], archived: "include" | "exclude"): Promise<boolean> {
  const workspaceId = requireWorkspace(tx, "filing bookmarks");
  const wanted = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(wanted, "filing bookmarks");
  if (wanted.length === 0) {
    return true;
  }
  const locked = await tenantHandle(tx)
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.workspaceId, workspaceId),
        eq(bookmarks.ownerId, ownerId),
        archived === "exclude" ? isNull(bookmarks.planArchivedAt) : undefined,
        sql`${bookmarks.id} = ANY (${uuidArray(wanted)}::uuid[])`,
      ),
    )
    .orderBy(bookmarks.id)
    .for("key share");
  return locked.length === wanted.length;
}

/** Links every folder of `folderIds` to every bookmark of `bookmarkIds`, leaving the links that exist, and answers how many were new. Both sides are locked and owned already. */
export async function insertLinks(tx: TenantTx, folderIds: readonly string[], bookmarkIds: readonly string[]): Promise<number> {
  const workspaceId = requireWorkspace(tx, "filing bookmarks");
  const folderList = distinctIdentifiers(folderIds);
  const bookmarkList = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(folderList, "filing bookmarks");
  requireIdentifiers(bookmarkList, "filing bookmarks");
  if (folderList.length === 0 || bookmarkList.length === 0) {
    return 0;
  }
  // The statement names the columns the application role may insert (a column grant); the query builder would name `added_at` too.
  const inserted = await tenantHandle(tx).execute<{ folder_id: string }>(sql`
    INSERT INTO ${folderBookmarks} (workspace_id, folder_id, bookmark_id)
    SELECT ${workspaceId}::uuid, f.id, b.id FROM unnest(${uuidArray(folderList)}::uuid[]) AS f(id) CROSS JOIN unnest(${uuidArray(bookmarkList)}::uuid[]) AS b(id)
    ON CONFLICT (folder_id, bookmark_id) DO NOTHING
    RETURNING folder_id`);
  return inserted.length;
}

/** Removes the links of `folderIds` and `bookmarkIds` (every pair of the two lists) and answers how many there were. */
export async function deleteLinks(tx: TenantTx, folderIds: readonly string[], bookmarkIds: readonly string[]): Promise<number> {
  requireWorkspace(tx, "unfiling bookmarks");
  const folderList = distinctIdentifiers(folderIds);
  const bookmarkList = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(folderList, "unfiling bookmarks");
  requireIdentifiers(bookmarkList, "unfiling bookmarks");
  if (folderList.length === 0 || bookmarkList.length === 0) {
    return 0;
  }
  const deleted = await scoped
    .bind(tx)
    .delete(and(sql`${folderBookmarks.folderId} = ANY (${uuidArray(folderList)}::uuid[])`, sql`${folderBookmarks.bookmarkId} = ANY (${uuidArray(bookmarkList)}::uuid[])`));
  return deleted.length;
}

/** The statement of `foldersOfBookmarks`, exported for the test that plans it. The identifiers are UUIDs, distinct. */
export function foldersOfBookmarksQuery(tx: TenantTx, ownerId: string, bookmarkIds: readonly string[]) {
  const workspaceId = requireWorkspace(tx, "reading the folders of bookmarks");
  return tenantHandle(tx)
    .select({ bookmarkId: folderBookmarks.bookmarkId, id: folders.id, name: folders.name, icon: folders.icon, color: folders.color })
    .from(folderBookmarks)
    .innerJoin(folders, and(eq(folders.workspaceId, folderBookmarks.workspaceId), eq(folders.id, folderBookmarks.folderId)))
    .where(and(eq(folderBookmarks.workspaceId, workspaceId), eq(folders.ownerId, ownerId), sql`${folderBookmarks.bookmarkId} = ANY (${uuidArray(bookmarkIds)}::uuid[])`))
    .orderBy(asc(folders.name), asc(folders.id));
}

/** The folders `ownerId` has filed each of `bookmarkIds` in, by bookmark, in the order of the folders' names (the identifier breaks a tie). */
export async function foldersOfBookmarks(tx: TenantTx, ownerId: string, bookmarkIds: readonly string[]): Promise<Map<string, BookmarkFolderRef[]>> {
  const found = new Map<string, BookmarkFolderRef[]>();
  const wanted = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(wanted, "reading the folders of bookmarks");
  if (wanted.length === 0) {
    return found;
  }
  for (const { bookmarkId, ...folder } of await foldersOfBookmarksQuery(tx, ownerId, wanted)) {
    const list = found.get(bookmarkId);
    if (list === undefined) {
      found.set(bookmarkId, [folder]);
    } else {
      list.push(folder);
    }
  }
  return found;
}
