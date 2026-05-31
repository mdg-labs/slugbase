import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Bookmark shared with an individual workspace member (spec §16). */
export const bookmarkUserShares = sqliteTable(
  "bookmark_user_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("bookmark_user_shares_workspace_bookmark_user_unique_idx").on(
      t.workspaceId,
      t.bookmarkId,
      t.userId,
    ),
    index("bookmark_user_shares_bookmark_id_idx").on(t.bookmarkId),
    index("bookmark_user_shares_user_id_idx").on(t.userId),
  ],
);
