import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bookmarks } from "./bookmarks.ts";
import { citext } from "./types.ts";
import { workspaceMembers, workspaces } from "./workspaces.ts";

// `tags` and `bookmark_tags` of doc 05 section 2.4. Row-level security, the policies and the privileges of `slugbase_app` live in
// src/sql/510-tags.sql.

/**
 * A tag of one member of a workspace (doc 02 section 7.2). Tags are private to their owner: the policy of the table names the owner as
 * well as the workspace, so another member of the same workspace reads none of them. A tag leaves with its owner's membership, and the
 * name is unique per owner without regard to case (`citext`) and is stored as entered.
 */
export const tags = pgTable(
  "tags",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid().notNull(),
    name: citext().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tags_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("tags_owner_name_key").on(table.workspaceId, table.ownerId, table.name),
    foreignKey({
      name: "tags_owner_fkey",
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    check("tags_name_check", sql`length(${table.name}::text) BETWEEN 1 AND 40`),
  ],
);

/**
 * The tags of a bookmark. A link is visible through the tag it names, so it is its tag owner's; the policy of the table says so.
 * Both keys carry the workspace, so a link never joins a bookmark and a tag of different workspaces, and both cascade: deleting
 * a tag or a bookmark deletes its links.
 */
export const bookmarkTags = pgTable(
  "bookmark_tags",
  {
    workspaceId: uuid().notNull(),
    bookmarkId: uuid().notNull(),
    tagId: uuid().notNull(),
  },
  (table) => [
    primaryKey({ name: "bookmark_tags_pkey", columns: [table.bookmarkId, table.tagId] }),
    foreignKey({
      name: "bookmark_tags_bookmark_fkey",
      columns: [table.workspaceId, table.bookmarkId],
      foreignColumns: [bookmarks.workspaceId, bookmarks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bookmark_tags_tag_fkey",
      columns: [table.workspaceId, table.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete("cascade"),
    index("bookmark_tags_tag_idx").on(table.workspaceId, table.tagId),
  ],
);
