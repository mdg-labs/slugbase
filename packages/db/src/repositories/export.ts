import type { ExportBookmarkRow, ExportFolderRow, ExportStore, ExportSummary } from "@slugbase/core";
import { sql, type SQL } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { bookmarkTags, tags } from "../schema/tags.ts";
import { workspaces } from "../schema/workspaces.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The reads of the export (doc 02 section 13.2, doc 05 section 2.4, doc 10 T1 and T2) in the active workspace. Every statement names the workspace and the owner as well as the policy, and the owner
// is always the account of the transaction: a request that names another account is a programming error and throws. A bookmark is read whether or not a downgrade archived it, and a bookmark, folder
// or tag with no owner is never read, since the owner is named by equality. A folder or tag of a bookmark is read only when its own owner is the account, so a link to another member's folder or tag
// (which the policies of the link tables keep out of reach anyway) names nothing. The pages are keysets: the bookmarks by identifier, walking `bookmarks_workspace_id_id_key` in the order of its key
// and filtering by owner, so the work of the whole export is a pass over the workspace's bookmarks and not a sort of the member's for each page; the folders and tags by the bytes of their name
// (`COLLATE "C"`), a total order since a member's names are unique, which also makes the order the same on every database whatever its locale.

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the export needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

function requireOwner(tx: TenantTx, ownerId: string): string {
  if (ownerId.toLowerCase() !== tx.accountId) {
    throw new Error("the export is read for the account of the transaction only");
  }
  return tx.accountId;
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("an export page takes a positive whole limit");
  }
}

/** The statement of `ExportRepository.summary`, exported for the test that plans it. */
export function summaryStatement(tx: TenantTx, ownerId: string): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  return sql`
    SELECT ${workspaces.name} AS workspace_name,
      (SELECT count(*) FROM ${bookmarks} WHERE ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.ownerId} = ${owner}::uuid)::int AS bookmarks,
      (SELECT count(*) FROM ${folders} WHERE ${folders.workspaceId} = ${workspaceId}::uuid AND ${folders.ownerId} = ${owner}::uuid)::int AS folders,
      (SELECT count(*) FROM ${tags} WHERE ${tags.workspaceId} = ${workspaceId}::uuid AND ${tags.ownerId} = ${owner}::uuid)::int AS tags
    FROM ${workspaces}
    WHERE ${workspaces.id} = ${workspaceId}::uuid`;
}

/** The statement of `ExportRepository.folders`, exported for the test that plans it. */
export function foldersStatement(tx: TenantTx, ownerId: string, after: string | undefined, limit: number): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  requireLimit(limit);
  const resume = after === undefined ? sql`TRUE` : sql`${folders.name}::text COLLATE "C" > ${after}::text COLLATE "C"`;
  return sql`
    SELECT ${folders.name}::text AS name, ${folders.icon} AS icon, ${folders.color}::int AS color
    FROM ${folders}
    WHERE ${folders.workspaceId} = ${workspaceId}::uuid AND ${folders.ownerId} = ${owner}::uuid AND ${resume}
    ORDER BY ${folders.name}::text COLLATE "C"
    LIMIT ${limit}::integer`;
}

/** The statement of `ExportRepository.tags`, exported for the test that plans it. */
export function tagsStatement(tx: TenantTx, ownerId: string, after: string | undefined, limit: number): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  requireLimit(limit);
  const resume = after === undefined ? sql`TRUE` : sql`${tags.name}::text COLLATE "C" > ${after}::text COLLATE "C"`;
  return sql`
    SELECT ${tags.name}::text AS name
    FROM ${tags}
    WHERE ${tags.workspaceId} = ${workspaceId}::uuid AND ${tags.ownerId} = ${owner}::uuid AND ${resume}
    ORDER BY ${tags.name}::text COLLATE "C"
    LIMIT ${limit}::integer`;
}

/** The statement of `ExportRepository.bookmarks`, exported for the test that plans it. */
export function bookmarksStatement(tx: TenantTx, ownerId: string, after: string | undefined, limit: number): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  requireLimit(limit);
  const resume = after === undefined ? sql`TRUE` : sql`${bookmarks.id} > ${after}::uuid`;
  return sql`
    SELECT ${bookmarks.id} AS id, ${bookmarks.url} AS url, ${bookmarks.title} AS title, ${bookmarks.description} AS description, ${bookmarks.slug} AS slug,
      ${bookmarks.forwarding} AS forwarding, (${bookmarks.pinnedAt} IS NOT NULL) AS pinned, (${bookmarks.planArchivedAt} IS NOT NULL) AS plan_archived,
      COALESCE((
        SELECT array_agg(${folders.name}::text ORDER BY ${folders.name}::text COLLATE "C")
        FROM ${folderBookmarks} JOIN ${folders} ON ${folders.workspaceId} = ${folderBookmarks.workspaceId} AND ${folders.id} = ${folderBookmarks.folderId}
        WHERE ${folderBookmarks.workspaceId} = ${bookmarks.workspaceId} AND ${folderBookmarks.bookmarkId} = ${bookmarks.id} AND ${folders.ownerId} = ${owner}::uuid
      ), ARRAY[]::text[]) AS folder_names,
      COALESCE((
        SELECT array_agg(${tags.name}::text ORDER BY ${tags.name}::text COLLATE "C")
        FROM ${bookmarkTags} JOIN ${tags} ON ${tags.workspaceId} = ${bookmarkTags.workspaceId} AND ${tags.id} = ${bookmarkTags.tagId}
        WHERE ${bookmarkTags.workspaceId} = ${bookmarks.workspaceId} AND ${bookmarkTags.bookmarkId} = ${bookmarks.id} AND ${tags.ownerId} = ${owner}::uuid
      ), ARRAY[]::text[]) AS tag_names
    FROM ${bookmarks}
    WHERE ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.ownerId} = ${owner}::uuid AND ${resume}
    ORDER BY ${bookmarks.id}
    LIMIT ${limit}::integer`;
}

type BookmarkRow = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly pinned: boolean;
  readonly plan_archived: boolean;
  readonly folder_names: readonly string[];
  readonly tag_names: readonly string[];
};

export type ExportRepository = ExportStore;

/** The reads of the export bound to the open transaction; every method needs a transaction opened with a workspace. */
export function exportRepository(tx: TenantTx): ExportRepository {
  return {
    async summary(ownerId): Promise<ExportSummary | undefined> {
      const [row] = await tenantHandle(tx).execute<{ workspace_name: string; bookmarks: number; folders: number; tags: number }>(summaryStatement(tx, ownerId));
      return row === undefined ? undefined : { workspaceName: row.workspace_name, bookmarks: row.bookmarks, folders: row.folders, tags: row.tags };
    },

    async folders(ownerId, after, limit): Promise<readonly ExportFolderRow[]> {
      const rows = await tenantHandle(tx).execute<{ name: string; icon: string; color: number }>(foldersStatement(tx, ownerId, after, limit));
      return rows.map((row) => ({ name: row.name, icon: row.icon, color: row.color }));
    },

    async tags(ownerId, after, limit): Promise<readonly string[]> {
      const rows = await tenantHandle(tx).execute<{ name: string }>(tagsStatement(tx, ownerId, after, limit));
      return rows.map((row) => row.name);
    },

    async bookmarks(ownerId, after, limit): Promise<readonly ExportBookmarkRow[]> {
      const rows = await tenantHandle(tx).execute<BookmarkRow>(bookmarksStatement(tx, ownerId, after, limit));
      return rows.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title,
        description: row.description,
        slug: row.slug,
        forwarding: row.forwarding,
        pinned: row.pinned,
        planArchived: row.plan_archived,
        folders: [...row.folder_names],
        tags: [...row.tag_names],
      }));
    },
  };
}
