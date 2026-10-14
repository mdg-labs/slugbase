import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";

// `workspaces` and `workspace_members` of doc 05 section 2.2. Row-level
// security, the policies, the privileges of `slugbase_app`, the
// `app_member_workspace_ids()` function the workspaces policy relies on and the
// updated_at trigger live in src/sql/100-workspaces.sql, which Drizzle cannot
// express.

/** The role of a member in a workspace; adding a value is an expand-only migration (doc 05 section 5.4). */
export type MemberRole = "owner" | "admin" | "member";

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    createdBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
    /** Bumped on any plan or entitlement change; the key of the entitlement cache (doc 01 section 8.3). */
    entitlementVersion: integer().notNull().default(1),
    /** The workspace's bookmarks that are not plan-archived; maintained with every bookmark write (doc 05 section 2.2). */
    bookmarkCount: integer().notNull().default(0),
    /** Set when deletion is requested; the workspace is then hidden from every product query. */
    deletingAt: timestamp({ withTimezone: true }),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("workspaces_name_check", sql`length(${table.name}) BETWEEN 1 AND 64`),
    check("workspaces_bookmark_count_check", sql`${table.bookmarkCount} >= 0`),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: memberRole().notNull(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When the member last acted in the workspace; written at most once a minute. */
    lastActiveAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    primaryKey({ name: "workspace_members_pkey", columns: [table.workspaceId, table.accountId] }),
    index("workspace_members_account_id_idx").on(table.accountId),
  ],
);

// `workspace_settings` of doc 05 section 2.2: one row per workspace with typed
// columns, written in the transaction that creates the workspace. Its policy,
// privileges and updated_at trigger live in src/sql/120-setup.sql.
export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: uuid()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  aiEnabled: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
});
