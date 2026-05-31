import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    slug: text("slug"),
    forwardingEnabled: integer("forwarding_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    planArchived: integer("plan_archived", { mode: "boolean" })
      .notNull()
      .default(false),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: integer("last_accessed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("bookmarks_workspace_id_idx").on(t.workspaceId),
    index("bookmarks_user_id_idx").on(t.userId),
    uniqueIndex("bookmarks_workspace_slug_unique_idx")
      .on(t.workspaceId, t.slug)
      .where(sql`${t.slug} IS NOT NULL`),
  ],
);
