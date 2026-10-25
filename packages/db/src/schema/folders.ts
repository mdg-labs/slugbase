import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, smallint, text, timestamp, unique, uuid, type UpdateDeleteAction } from "drizzle-orm/pg-core";
import { bookmarks } from "./bookmarks.ts";
import { citext } from "./types.ts";
import { workspaceMembers, workspaces } from "./workspaces.ts";

// `folders` and `folder_bookmarks` of doc 05 section 2.4. Row-level security, the policies, the privileges of `slugbase_app` and the
// triggers live in src/sql/520-folders.sql.

// The action of the owner's foreign key. A member who leaves takes the ownership with them and not the folder, so only `owner_id` is
// cleared: the key shares `workspace_id`, which is NOT NULL, and a plain `SET NULL` would clear that too and refuse to delete the
// membership. PostgreSQL 15 puts the columns to clear after the action. drizzle-orm's `onDelete` types a closed list without them, but
// drizzle-kit copies the string into the migration as it is. The column must never be given a default.
const CLEAR_OWNER = "set null (owner_id)" as UpdateDeleteAction;

/**
 * A folder of a member of a workspace (doc 02 section 7.1). A folder is its owner's: the repository names the owner in every
 * statement. A member who leaves the workspace leaves their folders with it: `owner_id` becomes NULL (doc 02 section 3.5). The name is
 * unique per owner without regard to case (`citext`), and ownerless folders share one namespace (`NULLS NOT DISTINCT`). `icon` is a
 * lucide icon name from the allowlist `@slugbase/contracts` publishes; the allowlist is configuration in code, so the table holds
 * only a length rule. `color` is the number of the `--folder-N` theme token.
 */
export const folders = pgTable(
  "folders",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid(),
    name: citext().notNull(),
    icon: text().notNull().default("folder"),
    color: smallint().notNull().default(1),
    /** The `ETag` of the folder. */
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("folders_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("folders_owner_name_key").on(table.workspaceId, table.ownerId, table.name).nullsNotDistinct(),
    foreignKey({
      name: "folders_owner_fkey",
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete(CLEAR_OWNER),
    check("folders_name_check", sql`length(${table.name}::text) BETWEEN 1 AND 64`),
    check("folders_icon_check", sql`length(${table.icon}) BETWEEN 1 AND 40`),
    check("folders_color_check", sql`${table.color} BETWEEN 1 AND 8`),
  ],
);

/**
 * The bookmarks filed in a folder. Both keys carry the workspace, so a link never joins a folder and a bookmark of different
 * workspaces, and both cascade: deleting a folder or a bookmark deletes its links.
 */
export const folderBookmarks = pgTable(
  "folder_bookmarks",
  {
    workspaceId: uuid().notNull(),
    folderId: uuid().notNull(),
    bookmarkId: uuid().notNull(),
    addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "folder_bookmarks_pkey", columns: [table.folderId, table.bookmarkId] }),
    foreignKey({
      name: "folder_bookmarks_folder_fkey",
      columns: [table.workspaceId, table.folderId],
      foreignColumns: [folders.workspaceId, folders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "folder_bookmarks_bookmark_fkey",
      columns: [table.workspaceId, table.bookmarkId],
      foreignColumns: [bookmarks.workspaceId, bookmarks.id],
    }).onDelete("cascade"),
    index("folder_bookmarks_bookmark_idx").on(table.workspaceId, table.bookmarkId),
  ],
);
