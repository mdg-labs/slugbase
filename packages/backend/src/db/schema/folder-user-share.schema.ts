import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

/** Folder shared with an individual workspace member (spec §16). */
export const folderUserShares = pgTable(
  "folder_user_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    folderId: text("folder_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
