import {
  bigint,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Many-to-many link between bookmarks and tags, workspace-scoped (spec §16). */
export const bookmarkTags = pgTable(
  "bookmark_tags",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    tagId: text("tag_id").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("bookmark_tags_workspace_tag_bookmark_unique_idx").on(
      t.workspaceId,
      t.tagId,
      t.bookmarkId,
    ),
    index("bookmark_tags_tag_id_idx").on(t.tagId),
    index("bookmark_tags_bookmark_id_idx").on(t.bookmarkId),
  ],
);
