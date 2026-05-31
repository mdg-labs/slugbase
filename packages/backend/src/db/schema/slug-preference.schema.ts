import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Per-user remembered slug→bookmark mapping for ambiguous /go resolution (spec §8, §16).
 * Rows cascade-delete when the referenced bookmark is hard-deleted.
 */
export const slugPreferences = sqliteTable(
  "slug_preferences",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    slug: text("slug").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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
