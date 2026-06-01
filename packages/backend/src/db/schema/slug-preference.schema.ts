import {
  bigint,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const slugPreferences = pgTable(
  "slug_preferences",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    slug: text("slug").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("slug_preferences_workspace_user_slug_unique_idx").on(
      t.workspaceId,
      t.userId,
      t.slug,
    ),
    index("slug_preferences_bookmark_id_idx").on(t.bookmarkId),
  ],
);
