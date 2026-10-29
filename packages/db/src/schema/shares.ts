import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bookmarks } from "./bookmarks.ts";
import { teams } from "./teams.ts";
import { workspaceMembers, workspaces } from "./workspaces.ts";

// `bookmark_shares` of doc 05 section 2.5. Row-level security, the policies and the privileges of `slugbase_app` live in
// src/sql/650-bookmark-shares.sql.

/**
 * A grant of read access to one bookmark of a workspace (doc 02 section 8) to one member or one team of that workspace. Exactly one of
 * `target_account_id` and `target_team_id` is set (the CHECK), and a bookmark is shared with a target at most once (a unique index per kind of
 * target). Every key carries the workspace, so a share never joins a bookmark, a member or a team of different workspaces, and all three
 * cascade: a deleted bookmark, a member who leaves the workspace and a deleted team take their shares with them. A share outlives the member
 * who granted it (`granted_by` is cleared when the account is deleted) and a bookmark whose owner has left.
 */
export const bookmarkShares = pgTable(
  "bookmark_shares",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    bookmarkId: uuid().notNull(),
    targetAccountId: uuid(),
    targetTeamId: uuid(),
    grantedBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "bookmark_shares_bookmark_fkey",
      columns: [table.workspaceId, table.bookmarkId],
      foreignColumns: [bookmarks.workspaceId, bookmarks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bookmark_shares_member_fkey",
      columns: [table.workspaceId, table.targetAccountId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    foreignKey({
      name: "bookmark_shares_team_fkey",
      columns: [table.workspaceId, table.targetTeamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    check("bookmark_shares_target_check", sql`(${table.targetAccountId} IS NULL) <> (${table.targetTeamId} IS NULL)`),
    uniqueIndex("bookmark_shares_account_key").on(table.bookmarkId, table.targetAccountId).where(sql`${table.targetAccountId} IS NOT NULL`),
    uniqueIndex("bookmark_shares_team_key").on(table.bookmarkId, table.targetTeamId).where(sql`${table.targetTeamId} IS NOT NULL`),
    // The "shared with me" lists and the access checks of `/go` (doc 05 section 2.5) read the shares of an account or of a team by the target.
    index("bookmark_shares_account_idx").on(table.workspaceId, table.targetAccountId, table.bookmarkId),
    index("bookmark_shares_team_idx").on(table.workspaceId, table.targetTeamId, table.bookmarkId),
  ],
);
