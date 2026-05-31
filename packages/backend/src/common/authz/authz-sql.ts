import { eq, sql, type Column, type SQL } from "drizzle-orm";

import type { BookmarkScope } from "../../bookmarks/bookmark.validation.js";
import type { FolderScope } from "../../folders/folder.validation.js";

type BookmarkTable = {
  id: Column;
  userId: Column;
};

type FolderTable = {
  id: Column;
  userId: Column;
};

/** Direct or transitive read access to a bookmark (spec §5.9). */
export function bookmarkSharedReadCondition(
  workspaceId: string,
  userId: string,
  bookmarksTable: BookmarkTable,
): SQL {
  return sql`(
    ${bookmarksTable.userId} = ${userId}
    OR EXISTS (
      SELECT 1 FROM bookmark_user_shares bus
      WHERE bus.workspace_id = ${workspaceId}
        AND bus.bookmark_id = ${bookmarksTable.id}
        AND bus.user_id = ${userId}
    )
    OR EXISTS (
      SELECT 1 FROM bookmark_team_shares bts
      INNER JOIN team_memberships tm
        ON tm.workspace_id = ${workspaceId}
        AND tm.team_id = bts.team_id
        AND tm.user_id = ${userId}
      WHERE bts.workspace_id = ${workspaceId}
        AND bts.bookmark_id = ${bookmarksTable.id}
    )
    OR EXISTS (
      SELECT 1 FROM bookmark_folders bf
      INNER JOIN folder_user_shares fus
        ON fus.workspace_id = ${workspaceId}
        AND fus.folder_id = bf.folder_id
        AND fus.user_id = ${userId}
      WHERE bf.workspace_id = ${workspaceId}
        AND bf.bookmark_id = ${bookmarksTable.id}
    )
    OR EXISTS (
      SELECT 1 FROM bookmark_folders bf
      INNER JOIN folder_team_shares fts
        ON fts.workspace_id = ${workspaceId}
        AND fts.folder_id = bf.folder_id
      INNER JOIN team_memberships tm
        ON tm.workspace_id = ${workspaceId}
        AND tm.team_id = fts.team_id
        AND tm.user_id = ${userId}
      WHERE bf.workspace_id = ${workspaceId}
        AND bf.bookmark_id = ${bookmarksTable.id}
    )
  )`;
}

/** Bookmark has an outbound share grant (direct or via containing folder). */
export function bookmarkSharedByOwnerCondition(
  workspaceId: string,
  bookmarksTable: BookmarkTable,
): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM bookmark_user_shares bus
      WHERE bus.workspace_id = ${workspaceId}
        AND bus.bookmark_id = ${bookmarksTable.id}
    )
    OR EXISTS (
      SELECT 1 FROM bookmark_team_shares bts
      WHERE bts.workspace_id = ${workspaceId}
        AND bts.bookmark_id = ${bookmarksTable.id}
    )
    OR EXISTS (
      SELECT 1 FROM bookmark_folders bf
      INNER JOIN folder_user_shares fus
        ON fus.workspace_id = ${workspaceId}
        AND fus.folder_id = bf.folder_id
      WHERE bf.workspace_id = ${workspaceId}
        AND bf.bookmark_id = ${bookmarksTable.id}
    )
    OR EXISTS (
      SELECT 1 FROM bookmark_folders bf
      INNER JOIN folder_team_shares fts
        ON fts.workspace_id = ${workspaceId}
        AND fts.folder_id = bf.folder_id
      WHERE bf.workspace_id = ${workspaceId}
        AND bf.bookmark_id = ${bookmarksTable.id}
    )
  )`;
}

export function bookmarkScopeCondition(
  scope: BookmarkScope,
  workspaceId: string,
  userId: string,
  bookmarksTable: BookmarkTable,
): SQL {
  switch (scope) {
    case "mine":
      return eq(bookmarksTable.userId, userId);
    case "shared-with-me":
      return sql`${bookmarksTable.userId} != ${userId} AND ${bookmarkSharedReadCondition(workspaceId, userId, bookmarksTable)}`;
    case "shared-by-me":
      return sql`${bookmarksTable.userId} = ${userId} AND ${bookmarkSharedByOwnerCondition(workspaceId, bookmarksTable)}`;
    case "all":
    default:
      return bookmarkSharedReadCondition(workspaceId, userId, bookmarksTable);
  }
}

/** Read access to a folder (spec §5.9). */
export function folderSharedReadCondition(
  workspaceId: string,
  userId: string,
  foldersTable: FolderTable,
): SQL {
  return sql`(
    ${foldersTable.userId} = ${userId}
    OR EXISTS (
      SELECT 1 FROM folder_user_shares fus
      WHERE fus.workspace_id = ${workspaceId}
        AND fus.folder_id = ${foldersTable.id}
        AND fus.user_id = ${userId}
    )
    OR EXISTS (
      SELECT 1 FROM folder_team_shares fts
      INNER JOIN team_memberships tm
        ON tm.workspace_id = ${workspaceId}
        AND tm.team_id = fts.team_id
        AND tm.user_id = ${userId}
      WHERE fts.workspace_id = ${workspaceId}
        AND fts.folder_id = ${foldersTable.id}
    )
  )`;
}

export function folderSharedByOwnerCondition(
  workspaceId: string,
  foldersTable: FolderTable,
): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM folder_user_shares fus
      WHERE fus.workspace_id = ${workspaceId}
        AND fus.folder_id = ${foldersTable.id}
    )
    OR EXISTS (
      SELECT 1 FROM folder_team_shares fts
      WHERE fts.workspace_id = ${workspaceId}
        AND fts.folder_id = ${foldersTable.id}
    )
  )`;
}

export function folderScopeCondition(
  scope: FolderScope,
  workspaceId: string,
  userId: string,
  foldersTable: FolderTable,
): SQL {
  switch (scope) {
    case "mine":
      return eq(foldersTable.userId, userId);
    case "shared-with-me":
      return sql`${foldersTable.userId} != ${userId} AND ${folderSharedReadCondition(workspaceId, userId, foldersTable)}`;
    case "shared-by-me":
      return sql`${foldersTable.userId} = ${userId} AND ${folderSharedByOwnerCondition(workspaceId, foldersTable)}`;
    case "all":
    default:
      return folderSharedReadCondition(workspaceId, userId, foldersTable);
  }
}
