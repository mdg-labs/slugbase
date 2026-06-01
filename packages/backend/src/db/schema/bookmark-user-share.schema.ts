import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

/** Bookmark shared with an individual workspace member (spec §16). */
export const bookmarkUserShares = pgTable(
  "bookmark_user_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
