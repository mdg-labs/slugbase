import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bookmarks } from "./bookmarks.ts";
import { workspaceMembers } from "./workspaces.ts";

// `slug_preferences` of doc 05 section 2.6. Row-level security, the policy, and the privileges of `slugbase_app` live in
// src/sql/570-slug-preferences.sql.

/**
 * The bookmark a member chose to always go to for a slug in a workspace (doc 02 section 6.4): one row for each member and slug, so choosing again
 * replaces the earlier choice. `slug` is `text` in the lower case the application writes, as `bookmarks.slug` is, so the lookup that reads the
 * preference beside the candidates compares two `text` values (doc 05 sections 2.4 and 4). The bookmark's key carries the workspace, so a preference never
 * names a bookmark of another workspace, and both keys cascade: a deleted bookmark is forgotten, and so is every preference of a member who leaves.
 * The index on the bookmark serves the cascade of a deleted bookmark; it leads with the bookmark, so the read of a member's choice by the primary key's three columns has
 * no other index to be planned on.
 */
export const slugPreferences = pgTable(
  "slug_preferences",
  {
    workspaceId: uuid().notNull(),
    accountId: uuid().notNull(),
    slug: text().notNull(),
    bookmarkId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "slug_preferences_pkey", columns: [table.workspaceId, table.accountId, table.slug] }),
    foreignKey({
      name: "slug_preferences_bookmark_fkey",
      columns: [table.workspaceId, table.bookmarkId],
      foreignColumns: [bookmarks.workspaceId, bookmarks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "slug_preferences_member_fkey",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    check("slug_preferences_slug_check", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`),
    index("slug_preferences_bookmark_idx").on(table.bookmarkId, table.workspaceId),
  ],
);
