import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { workspaceMembers } from "../schema/workspaces.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { distinctIdentifiers, requireIdentifiers, uuidArray } from "./folder-links.ts";

// The former members' content of the active workspace (doc 02 section 2.10, doc 05 sections 2.4, 7.1 and 7.5, doc 10 T1 and T2): the bookmarks and
// folders that have no owner, which a member who left or whose account was deleted left with the workspace. Whose row a member may read is the
// repository's rule, since the policies of `bookmarks` and `folders` name the workspace only (src/sql/470-bookmarks.sql, src/sql/520-folders.sql):
// every statement below names the workspace and `owner_id IS NULL`, so a row that has an owner is never returned, whoever asks. Who may ask is the
// operations' rule, which the server enforces before a handler runs.
//
// "Former member content" is `owner_id IS NULL AND departure_id IS NULL`. A row that still carries a `departure_id` waits for the delivery of its
// departure, which applies the choice the member made when they left (doc 05 section 7.5), so it belongs to that delivery and is not listed. A
// plan-archived bookmark is left out as every product query leaves it out (doc 05 section 2.4); it is listed again when the plan is restored.
// The count of a folder is the number of the listed bookmarks filed in it: ownerless, not waiting for a departure, not plan-archived.
// A page is at most `limit` rows after `afterId`, in the order of the identifiers (UUIDv7, so the order of creation).
//
// Deleting that content is `sys_former_content_delete` (src/sql/750-former-content.sql), the one path that deletes a row the calling account does not own: `slugbase_app`
// has no privilege to delete a bookmark or to lower `workspaces.bookmark_count`, and `sys_bookmark_delete_many` deletes only the caller's own rows. The function holds the
// rule of whose content it removes (no owner, no departure, no plan-archived bookmark, this workspace) and of who may call it (an owner or an admin of the workspace), so
// the repository adds none: it hands over the identifiers and answers what the function answered. This is the narrow exception to T2 that doc 10 names for owners and
// admins over ownerless content, a deletion through this method and no read of a row it does not list.
//
// Giving that content to a member is `sys_former_content_reassign` (src/sql/760-former-content-reassign.sql), the one path that changes the owner of a row to someone the row's
// previous state names none of: `slugbase_app` has no privilege to write `owner_id`. As with the deletion the function holds the rules (whose content, who may call it, that the
// recipient is a member of the workspace, the collisions of the departure and the filings that would cross owners), and the repository hands over the identifiers and answers what
// the function answered. It is the second named exception to T2 in doc 10: a move through this method and no read of a row it does not list.

/** An ownerless bookmark of the workspace, as the admins' list shows it. */
export interface FormerBookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** An ownerless folder of the workspace, as the admins' list shows it. */
export interface FormerFolder {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
  /** The ownerless bookmarks filed in the folder that the list of bookmarks holds. */
  readonly bookmarkCount: number;
  readonly createdAt: Date;
}

/** What a deletion of former members' content removed. */
export interface FormerContentDeleted {
  readonly bookmarksDeleted: number;
  readonly foldersDeleted: number;
}

/** What a reassignment of former members' content did. */
export interface FormerContentReassigned {
  readonly bookmarksMoved: number;
  readonly foldersMoved: number;
  /** The moved bookmarks whose slug the recipient already owned: they arrived without a slug and with forwarding off. */
  readonly slugsCleared: number;
  /** The moved folders whose name the recipient already had: they arrived as `<name> (<n>)`. */
  readonly foldersRenamed: number;
  /** The filings of a moved folder or bookmark that would have linked two owners, removed in the same call. */
  readonly filingsRemoved: number;
}

/** Why a reassignment wrote nothing: the recipient is no member of the workspace, or the call was refused (the caller is no owner or admin, or the workspace cannot be reached). */
export type FormerContentReassignment =
  | ({ readonly kind: "reassigned" } & FormerContentReassigned)
  | { readonly kind: "recipient_not_member" }
  | { readonly kind: "refused" };

interface ReassignedRow extends Record<string, unknown> {
  bookmarks_moved: number | null;
  folders_moved: number | null;
  slugs_cleared: number | null;
  folders_renamed: number | null;
  filings_removed: number | null;
}

interface DeletedRow extends Record<string, unknown> {
  bookmarks_deleted: number | null;
  folders_deleted: number | null;
}

export interface FormerContentRepository {
  /**
   * The ownerless bookmarks of the workspace of the transaction in the order of their identifiers, the ones after `afterId` when it is given, at most
   * `limit`. Needs a transaction opened with a workspace.
   */
  listBookmarks(afterId: string | null, limit: number): Promise<readonly FormerBookmark[]>;
  /**
   * The ownerless folders of the workspace of the transaction in the order of their identifiers, the ones after `afterId` when it is given, at most
   * `limit`. Needs a transaction opened with a workspace.
   */
  listFolders(afterId: string | null, limit: number): Promise<readonly FormerFolder[]>;
  /**
   * Deletes the bookmarks of `bookmarkIds` and the folders of `folderIds` that have no owner in the workspace of the transaction, with their shares, filings, tag links and
   * remembered `go` choices, and lowers the workspace's `bookmark_count` by the bookmarks it deleted, through `sys_former_content_delete`, in the transaction. An identifier
   * that names no such row (one a member owns, one a departure still holds, a plan-archived bookmark, another workspace's, a gone one) is skipped and is not told apart from
   * another. Answers undefined, writing nothing, when the account of the transaction is no owner or admin of the workspace or the workspace cannot be reached. At most 1 000
   * identifiers a list. Needs a transaction opened with a workspace.
   */
  delete(request: { readonly bookmarkIds: readonly string[]; readonly folderIds: readonly string[] }): Promise<FormerContentDeleted | undefined>;
  /**
   * Gives the bookmarks of `bookmarkIds` and the folders of `folderIds` that have no owner in the workspace of the transaction to `recipientId`, a member of the workspace, through
   * `sys_former_content_reassign`, in the transaction. A slug the recipient owns is cleared on the moved bookmark with forwarding off, a folder name the recipient has becomes
   * `<name> (<n>)`, and a filing that would link two owners is removed; `workspaces.bookmark_count` is unchanged. An identifier that names no such row (one a member owns, one a
   * departure still holds, a plan-archived bookmark, another workspace's, a gone one) is skipped and is not told apart from another. Answers `recipient_not_member`, writing nothing,
   * when `recipientId` is no member of the workspace (a member of another workspace included), and `refused`, writing nothing, when the account of the transaction is no owner or admin of
   * the workspace or the workspace cannot be reached. At most 1 000 identifiers a list. Needs a transaction opened with a workspace.
   */
  reassign(request: { readonly bookmarkIds: readonly string[]; readonly folderIds: readonly string[]; readonly recipientId: string }): Promise<FormerContentReassignment>;
}

function requireWorkspace(tx: TenantTx, what: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${what} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

export function formerContentRepository(tx: TenantTx): FormerContentRepository {
  return {
    async listBookmarks(afterId, limit) {
      const workspaceId = requireWorkspace(tx, "listing the former members' bookmarks");
      return tenantHandle(tx)
        .select({
          id: bookmarks.id,
          title: bookmarks.title,
          url: bookmarks.url,
          host: bookmarks.host,
          slug: bookmarks.slug,
          forwarding: bookmarks.forwarding,
          createdAt: bookmarks.createdAt,
          updatedAt: bookmarks.updatedAt,
        })
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.workspaceId, workspaceId),
            isNull(bookmarks.ownerId),
            isNull(bookmarks.departureId),
            isNull(bookmarks.planArchivedAt),
            afterId === null ? undefined : gt(bookmarks.id, afterId),
          ),
        )
        .orderBy(asc(bookmarks.id))
        .limit(limit);
    },

    async listFolders(afterId, limit) {
      const workspaceId = requireWorkspace(tx, "listing the former members' folders");
      return tenantHandle(tx)
        .select({
          id: folders.id,
          name: folders.name,
          icon: folders.icon,
          color: folders.color,
          bookmarkCount: sql<number>`count(${bookmarks.id})::int`,
          createdAt: folders.createdAt,
        })
        .from(folders)
        .leftJoin(folderBookmarks, and(eq(folderBookmarks.workspaceId, folders.workspaceId), eq(folderBookmarks.folderId, folders.id)))
        .leftJoin(
          bookmarks,
          and(
            eq(bookmarks.workspaceId, folderBookmarks.workspaceId),
            eq(bookmarks.id, folderBookmarks.bookmarkId),
            isNull(bookmarks.ownerId),
            isNull(bookmarks.departureId),
            isNull(bookmarks.planArchivedAt),
          ),
        )
        .where(and(eq(folders.workspaceId, workspaceId), isNull(folders.ownerId), isNull(folders.departureId), afterId === null ? undefined : gt(folders.id, afterId)))
        .groupBy(folders.id)
        .orderBy(asc(folders.id))
        .limit(limit);
    },

    async delete({ bookmarkIds, folderIds }) {
      const workspaceId = requireWorkspace(tx, "deleting the former members' content");
      const wantedBookmarks = distinctIdentifiers(bookmarkIds);
      const wantedFolders = distinctIdentifiers(folderIds);
      requireIdentifiers(wantedBookmarks, "deleting the former members' content");
      requireIdentifiers(wantedFolders, "deleting the former members' content");
      const rows = await tenantHandle(tx).execute<DeletedRow>(sql`
        SELECT bookmarks_deleted, folders_deleted
        FROM public.sys_former_content_delete(${workspaceId}::uuid, ${uuidArray(wantedBookmarks)}::uuid[], ${uuidArray(wantedFolders)}::uuid[])`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_former_content_delete did not return exactly one answer");
      }
      return row.bookmarks_deleted === null || row.folders_deleted === null ? undefined : { bookmarksDeleted: row.bookmarks_deleted, foldersDeleted: row.folders_deleted };
    },

    async reassign({ bookmarkIds, folderIds, recipientId }) {
      const workspaceId = requireWorkspace(tx, "reassigning the former members' content");
      const wantedBookmarks = distinctIdentifiers(bookmarkIds);
      const wantedFolders = distinctIdentifiers(folderIds);
      requireIdentifiers(wantedBookmarks, "reassigning the former members' content");
      requireIdentifiers(wantedFolders, "reassigning the former members' content");
      requireIdentifiers([recipientId], "reassigning the former members' content");
      const rows = await tenantHandle(tx).execute<ReassignedRow>(sql`
        SELECT bookmarks_moved, folders_moved, slugs_cleared, folders_renamed, filings_removed
        FROM public.sys_former_content_reassign(${workspaceId}::uuid, ${recipientId}::uuid, ${uuidArray(wantedBookmarks)}::uuid[], ${uuidArray(wantedFolders)}::uuid[])`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_former_content_reassign did not return exactly one answer");
      }
      if (
        row.bookmarks_moved !== null &&
        row.folders_moved !== null &&
        row.slugs_cleared !== null &&
        row.folders_renamed !== null &&
        row.filings_removed !== null
      ) {
        return {
          kind: "reassigned",
          bookmarksMoved: row.bookmarks_moved,
          foldersMoved: row.folders_moved,
          slugsCleared: row.slugs_cleared,
          foldersRenamed: row.folders_renamed,
          filingsRemoved: row.filings_removed,
        };
      }
      // The function answers nothing for a caller who may not reassign and for a recipient who is no member; the membership, read here in the same transaction, tells the two apart.
      const member = await tenantHandle(tx)
        .select({ accountId: workspaceMembers.accountId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.accountId, recipientId.toLowerCase())))
        .limit(1);
      return member.length === 0 ? { kind: "recipient_not_member" } : { kind: "refused" };
    },
  };
}
