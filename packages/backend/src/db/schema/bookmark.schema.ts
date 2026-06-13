import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    slug: text("slug"),
    forwardingEnabled: boolean("forwarding_enabled").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    planArchived: boolean("plan_archived").notNull().default(false),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: bigint("last_accessed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("bookmarks_workspace_id_idx").on(t.workspaceId),
    index("bookmarks_user_id_idx").on(t.userId),
    uniqueIndex("bookmarks_workspace_user_slug_unique_idx")
      .on(t.workspaceId, t.userId, t.slug)
      .where(sql`${t.slug} IS NOT NULL`),
  ],
);
