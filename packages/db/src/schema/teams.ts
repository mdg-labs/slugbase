import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { citext } from "./types.ts";
import { workspaceMembers, workspaces } from "./workspaces.ts";

// `teams` and `team_members` of doc 05 section 2.3. Row-level security, the policies, the privileges of `slugbase_app` and the triggers
// live in src/sql/640-teams.sql.

/**
 * A team of a workspace (doc 02 section 4): a named group of its members. A team belongs to the workspace and to no member, so the
 * policies name the workspace only; who may change one is the operations' rule (an admin, with the `teams.manage` entitlement). The name is
 * unique per workspace without regard to case (`citext`) and is stored as entered.
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: citext().notNull(),
    description: text().notNull().default(""),
    /** The `ETag` of the team. */
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("teams_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("teams_name_key").on(table.workspaceId, table.name),
    check("teams_name_check", sql`length(${table.name}::text) BETWEEN 1 AND 64`),
    check("teams_description_check", sql`length(${table.description}) <= 280`),
  ],
);

/**
 * The members of a team. Both keys carry the workspace, so a membership never joins a team and a member of different workspaces, and
 * both cascade: deleting a team deletes its memberships, and a member who leaves the workspace leaves its teams.
 */
export const teamMembers = pgTable(
  "team_members",
  {
    workspaceId: uuid().notNull(),
    teamId: uuid().notNull(),
    accountId: uuid().notNull(),
  },
  (table) => [
    primaryKey({ name: "team_members_pkey", columns: [table.teamId, table.accountId] }),
    foreignKey({
      name: "team_members_team_fkey",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "team_members_member_fkey",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    index("team_members_account_idx").on(table.workspaceId, table.accountId),
  ],
);
