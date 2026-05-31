import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Folder shared with an individual workspace member (spec §16). */
export const folderUserShares = sqliteTable(
  "folder_user_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    folderId: text("folder_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("folder_user_shares_workspace_folder_user_unique_idx").on(
      t.workspaceId,
      t.folderId,
      t.userId,
    ),
    index("folder_user_shares_folder_id_idx").on(t.folderId),
    index("folder_user_shares_user_id_idx").on(t.userId),
  ],
);
