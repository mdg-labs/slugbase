import type { FolderFilingRequest, FolderFilingStore, FolderFilingStoreResult, FolderListRequest, FolderListRow, FolderPosition, FolderRecord, FolderSort, FolderStore, FolderStoreCreationResult, FolderUpdateRequest, FolderUpdateResult, NewFolder } from "@slugbase/core";
import { and, asc, desc, eq, isNull, not, sql, type SQL } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { bookmarkRepository } from "./bookmarks.ts";
import { deleteLinks, insertLinks, lockOwnedBookmarks, lockOwnedFolders } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";

// The folders of the active workspace (doc 05 section 2.4, doc 02 section 7.1, doc 10 T1 and T2). A folder is its owner's alone: the
// policies of `folders` name the workspace (src/sql/520-folders.sql), since a later sharing grant lets a recipient read a folder, so every
// statement below names the owner as well as the workspace, and another member's folder is a row the statement does not find. The owner of
// a statement is always the account of the transaction; a request that names another account is a programming error and throws.
// `slugbase_app` may insert the columns of a creation, update the name, the icon and the colour, and delete; deleting a folder deletes the
// associations of its bookmarks by foreign key, and the bookmarks stay.
//
// The unique key `(workspace_id, owner_id, name)` is the judge of a name that is taken. A creation inserts with `ON CONFLICT DO NOTHING`
// and a change of the name updates only where no other folder of the owner has it, so a name that is taken is an answer and not an error,
// and two creations of one name at the same time make one folder. Two renames to one name that overlap can still both pass their check and
// meet at the key; the loser's statement fails, which ends the transaction it ran in with nothing written, and `isFolderNameTaken` tells
// that failure from any other so the caller answers it as a name that is taken.
// A change locks the folder's row and compares its version with the caller's `If-Match` under that lock. A page is at most `limit`
// folders after the place the previous page ended at; `count` is the capped total of the owner's folders that match. The count of a folder
// is the number of bookmarks filed in it that are not plan-archived, which is what a list of bookmarks shows.
// Filing and unfiling name the owner of the folder and of every bookmark: the folder and the bookmarks are locked first (`FOR KEY SHARE`, in the
// order of their identifiers), and when the owner owns one of them not, nothing is written; the statements then run on the policies of
// `folder_bookmarks`, which admit a link of the account's own folder and bookmark only (src/sql/540-folder-filing.sql).

const scoped = defineScopedRepository("folders", folders, {
  insertColumns: ["id", "ownerId", "name", "icon", "color"],
  updateColumns: ["name", "icon", "color"],
});

const UNIQUE_VIOLATION = "23505";
const NAME_CONSTRAINT = "folders_owner_name_key";
const MAX_CAUSE_DEPTH = 4;

/** Whether the error is the database refusing a statement because the owner has a folder of that name already, on the error itself or on one of its causes. */
export function isFolderNameTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, constraint_name: constraint, cause } = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === NAME_CONSTRAINT) {
      return true;
    }
    current = cause;
  }
  return false;
}

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the folders of a workspace need a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

function requireOwner(tx: TenantTx, ownerId: string): string {
  if (ownerId.toLowerCase() !== tx.accountId) {
    throw new Error("a folder is read and written for the account of the transaction only");
  }
  return tx.accountId;
}

function recordOf(row: FolderListRow): FolderRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    bookmarkCount: row.bookmarkCount,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ORDERS: Readonly<Record<FolderSort, readonly SQL[]>> = {
  name: [asc(folders.name), asc(folders.id)],
  count: [desc(sql`count(${bookmarks.id})`), asc(folders.name), asc(folders.id)],
  updated: [desc(folders.updatedAt), desc(folders.id)],
};

/** The pattern of a search: the text with the characters `LIKE` reads as wildcards escaped, inside the wildcards of "contains". */
function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, "\\$&")}%`;
}

function matchesSearch(search: string | undefined): SQL | undefined {
  return search === undefined ? undefined : sql`${folders.name}::text ILIKE ${containsPattern(search)}`;
}

/**
 * The statement of `FolderRepository.list` and `find`: the folders of `ownerId` in the workspace of the transaction, or the one folder
 * `folderId`, with their counts, in the order of `sort` and after `after`, at most `limit`. The keyset of the sort by name is (name, id) and
 * is a condition on rows, as is that of the sort by update time, (updated_at descending, id descending), whose key is compared as the text
 * the database wrote, since a `Date` keeps milliseconds and the column microseconds; the keyset of the sort by count is (count descending,
 * name, id) and is a condition on the groups, since the count is an aggregate.
 */
function foldersOf(
  tx: TenantTx,
  request: { readonly ownerId: string; readonly search: string | undefined; readonly sort: FolderSort; readonly after: FolderPosition | undefined; readonly limit: number | undefined; readonly folderId: string | undefined },
): Promise<FolderListRow[]> {
  const workspaceId = requireWorkspace(tx);
  const { ownerId, search, sort, after, limit, folderId } = request;
  const bookmarkCount = sql<number>`count(${bookmarks.id})::int`;
  const afterName = after === undefined ? undefined : sql`(${folders.name}, ${folders.id}) > (${after.name}::citext, ${after.id}::uuid)`;
  const rowsAfter =
    after === undefined
      ? undefined
      : sort === "name"
        ? afterName
        : sort === "updated" && after.updated !== undefined
          ? sql`(${folders.updatedAt}, ${folders.id}) < (${after.updated}::timestamptz, ${after.id}::uuid)`
          : undefined;
  const groupsAfter =
    sort === "count" && after !== undefined && after.count !== undefined
      ? sql`(count(${bookmarks.id}) < ${after.count}::bigint OR (count(${bookmarks.id}) = ${after.count}::bigint AND ${afterName}))`
      : undefined;
  const query = tenantHandle(tx)
    .select({
      id: folders.id,
      ownerId: folders.ownerId,
      name: folders.name,
      icon: folders.icon,
      color: folders.color,
      version: folders.version,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
      updatedKey: sql<string>`${folders.updatedAt}::text`,
      bookmarkCount,
    })
    .from(folders)
    .leftJoin(folderBookmarks, and(eq(folderBookmarks.workspaceId, folders.workspaceId), eq(folderBookmarks.folderId, folders.id)))
    .leftJoin(bookmarks, and(eq(bookmarks.workspaceId, folderBookmarks.workspaceId), eq(bookmarks.id, folderBookmarks.bookmarkId), isNull(bookmarks.planArchivedAt)))
    .where(and(eq(folders.workspaceId, workspaceId), eq(folders.ownerId, ownerId), folderId === undefined ? undefined : eq(folders.id, folderId), matchesSearch(search), rowsAfter))
    .groupBy(folders.id)
    .having(groupsAfter)
    .orderBy(...ORDERS[sort]);
  return limit === undefined ? query : query.limit(limit);
}

async function changeFiling(tx: TenantTx, { folderId, ownerId, bookmarkIds }: FolderFilingRequest, change: "file" | "unfile"): Promise<FolderFilingStoreResult> {
  const owner = requireOwner(tx, ownerId);
  if (!(await lockOwnedFolders(tx, owner, [folderId])) || !(await lockOwnedBookmarks(tx, owner, bookmarkIds, change === "file" ? "exclude" : "include"))) {
    return { kind: "not_found" };
  }
  const changed = change === "file" ? await insertLinks(tx, [folderId], bookmarkIds) : await deleteLinks(tx, [folderId], bookmarkIds);
  const [read] = await foldersOf(tx, { ownerId: owner, search: undefined, sort: "name", after: undefined, limit: undefined, folderId });
  if (read === undefined) {
    throw new Error("a locked folder cannot be read back");
  }
  return { kind: "done", folder: recordOf(read), changed };
}

export type FolderRepository = FolderStore & FolderFilingStore;

export function folderRepository(tx: TenantTx): FolderRepository {
  const rows = scoped.bind(tx);
  return {
    async create(folder: NewFolder): Promise<FolderStoreCreationResult> {
      const ownerId = requireOwner(tx, folder.ownerId);
      const workspaceId = requireWorkspace(tx);
      // The statement names the columns the application role may insert; the query builder would name the version and the timestamps too.
      const inserted = await tenantHandle(tx).execute<{ id: string }>(sql`
        INSERT INTO ${folders} (id, workspace_id, owner_id, name, icon, color) VALUES (${folder.id}, ${workspaceId}, ${ownerId}, ${folder.name}, ${folder.icon}, ${folder.color})
        ON CONFLICT (workspace_id, owner_id, name) DO NOTHING
        RETURNING id`);
      if (inserted.length === 0) {
        return { kind: "name_taken" };
      }
      const [stored] = await foldersOf(tx, { ownerId, search: undefined, sort: "name", after: undefined, limit: undefined, folderId: folder.id });
      if (stored === undefined) {
        throw new Error("an inserted folder cannot be read back");
      }
      return { kind: "created", folder: recordOf(stored) };
    },

    async find({ folderId, ownerId }) {
      const [found] = await foldersOf(tx, { ownerId: requireOwner(tx, ownerId), search: undefined, sort: "name", after: undefined, limit: undefined, folderId });
      return found === undefined ? undefined : recordOf(found);
    },

    async list({ ownerId, search, sort, after, limit }: FolderListRequest) {
      return foldersOf(tx, { ownerId: requireOwner(tx, ownerId), search, sort, after, limit, folderId: undefined });
    },

    async count({ ownerId, search, limit }) {
      const owner = requireOwner(tx, ownerId);
      const workspaceId = requireWorkspace(tx);
      const handle = tenantHandle(tx);
      const capped = handle
        .select({ one: sql<number>`1`.as("one") })
        .from(folders)
        .where(and(eq(folders.workspaceId, workspaceId), eq(folders.ownerId, owner), matchesSearch(search)))
        .limit(limit)
        .as("capped");
      const [row] = await handle.select({ total: sql<number>`count(*)::int` }).from(capped);
      if (row === undefined) {
        throw new Error("counting folders returned no row");
      }
      return row.total;
    },

    async update({ folderId, ownerId, changes, expectedVersions }: FolderUpdateRequest): Promise<FolderUpdateResult> {
      const owner = requireOwner(tx, ownerId);
      const workspaceId = requireWorkspace(tx);
      const [current] = await tenantHandle(tx)
        .select()
        .from(folders)
        .where(and(eq(folders.workspaceId, workspaceId), eq(folders.id, folderId), eq(folders.ownerId, owner)))
        .for("update");
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (expectedVersions !== undefined && !expectedVersions.includes(current.version)) {
        return { kind: "stale" };
      }
      const set: Parameters<typeof rows.update>[0] = {};
      if (changes.name !== undefined && changes.name !== current.name) {
        set.name = changes.name;
      }
      if (changes.icon !== undefined && changes.icon !== current.icon) {
        set.icon = changes.icon;
      }
      if (changes.color !== undefined && changes.color !== current.color) {
        set.color = changes.color;
      }
      const changed = Object.keys(set).length > 0;
      if (changed) {
        const taken = sql`EXISTS (SELECT 1 FROM ${folders} AS other WHERE other.workspace_id = ${folders.workspaceId} AND other.owner_id = ${folders.ownerId} AND other.name = ${set.name ?? current.name} AND other.id <> ${folders.id})`;
        const updated = await rows.update(set, and(eq(folders.id, folderId), eq(folders.ownerId, owner), set.name === undefined ? undefined : not(taken)));
        if (updated.length === 0) {
          // The row is locked by this transaction, so it still exists and is the owner's: another folder of the owner has the name.
          return { kind: "name_taken" };
        }
      }
      const [read] = await foldersOf(tx, { ownerId: owner, search: undefined, sort: "name", after: undefined, limit: undefined, folderId });
      if (read === undefined) {
        throw new Error("a locked folder cannot be read back");
      }
      return changed ? { kind: "updated", folder: recordOf(read) } : { kind: "unchanged", folder: recordOf(read) };
    },

    async remove({ folderId, ownerId }) {
      const owner = requireOwner(tx, ownerId);
      const deleted = await rows.delete(and(eq(folders.id, folderId), eq(folders.ownerId, owner)));
      return deleted.length > 0;
    },

    file: (request) => changeFiling(tx, request, "file"),

    unfile: (request) => changeFiling(tx, request, "unfile"),

    sharedAmong: (request) => bookmarkRepository(tx).sharedAmong(request),
  };
}
