import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Many-to-many link between bookmarks and folders, workspace-scoped (spec §16). */
export const bookmarkFolders = sqliteTable(
  "bookmark_folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    folderId: text("folder_id").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("bookmark_folders_workspace_folder_bookmark_unique_idx").on(
      t.workspaceId,
      t.folderId,
      t.bookmarkId,
    ),
    index("bookmark_folders_folder_id_idx").on(t.folderId),
    index("bookmark_folders_bookmark_id_idx").on(t.bookmarkId),
  ],
);
