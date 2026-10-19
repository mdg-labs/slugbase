import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea, citext } from "./types.ts";
import { memberRole, workspaces } from "./workspaces.ts";

// `workspace_invitations` of doc 05 section 2.2. Row-level security, the policies, the privileges of
// `slugbase_app` (which has no INSERT privilege on `instance_issued`) and the updated_at trigger live in
// src/sql/300-workspace-invitations.sql, which Drizzle cannot express.

/** The states of an invitation; `pending` is the only one that can still be accepted. */
export type InvitationStatus = "pending" | "accepted" | "revoked";

/**
 * An invitation of an email address into a workspace with a role (doc 02 section 3.4). The token is found by
 * its SHA-256 and never stored; a resend replaces the hash, which ends the earlier link. Expiry is evaluated at
 * read time. The public operations never write an owner invitation: `instance_issued` is true only for the
 * one a system operation writes for a workspace created without an owner account.
 */
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: citext().notNull(),
    role: memberRole().notNull(),
    instanceIssued: boolean().notNull().default(false),
    /** The teams to join on accept; validated on invite and again on accept. */
    teamIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** SHA-256 of the token the link carries. */
    tokenHash: bytea().notNull().unique("workspace_invitations_token_hash_key"),
    invitedBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
    status: text().notNull().default("pending"),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
    /** When the status left `pending`; the retention purge counts its 30 days from it. Null exactly while the invitation is pending. */
    closedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("workspace_invitations_role_check", sql`${table.role} <> 'owner' OR ${table.instanceIssued}`),
    check("workspace_invitations_status_check", sql`${table.status} IN ('pending', 'accepted', 'revoked')`),
    check("workspace_invitations_closed_at_check", sql`(${table.status} = 'pending') = (${table.closedAt} IS NULL)`),
    check("workspace_invitations_token_hash_check", sql`length(${table.tokenHash}) = 32`),
    uniqueIndex("workspace_invitations_pending_email_key").on(table.workspaceId, table.email).where(sql`${table.status} = 'pending'`),
    index("workspace_invitations_invited_by_idx").on(table.invitedBy),
  ],
);
