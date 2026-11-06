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
    /**
     * True for a workspace an instance admin made from the instance console (sys_instance_create_workspace) for another first owner; false
     * for one an account made for itself. Written with `selfCreated` and read by nothing since the strip that verifying an address runs
     * moved to `selfCreated`; it stays until a later release drops it (expand/contract, doc 05 section 5.2).
     */
    instanceCreated: boolean().notNull().default(false),
    /**
     * True for a workspace whose first owner is its creator: the one an account makes for itself (sys_create_workspace, which setup,
     * registration and an account's own workspaces use) and a console workspace whose first owner is the admin who made it. False for a
     * console workspace made for another owner, and for every workspace that predates the column, whose first owner is not known. The strip
     * that verifying an address runs reads `createdBy` as the founding owner only where this is true (doc 02 section 2.6), so a workspace
     * of unknown origin is judged by the only-owner rule alone, as it was before the column.
     */
    selfCreated: boolean().notNull().default(false),
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
    // The workspaces an account created: read by the foreign-key action of `created_by` (ON DELETE SET NULL) when the account is deleted,
    // and by any lookup by creator. Partial like the other indexes of a nullable foreign key, since an account's deletion clears the column
    // and no lookup asks for a missing creator (doc 05 section 2.2).
    index("workspaces_created_by_idx").on(table.createdBy).where(sql`${table.createdBy} IS NOT NULL`),
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
