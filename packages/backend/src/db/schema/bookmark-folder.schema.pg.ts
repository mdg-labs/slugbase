import {
  bigint,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Many-to-many link between bookmarks and folders, workspace-scoped (spec §16). */
export const bookmarkFolders = pgTable(
  "bookmark_folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    folderId: text("folder_id").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
