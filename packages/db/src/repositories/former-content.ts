import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

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
  };
}
