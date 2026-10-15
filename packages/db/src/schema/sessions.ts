import { sql } from "drizzle-orm";
import { boolean, check, cidr, index, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea } from "./types.ts";
import { workspaces } from "./workspaces.ts";

// `sessions` of doc 05 section 2.1: server-side sessions looked up by the
// SHA-256 of the cookie's token before any account context exists. The table
// has forced row-level security and no policy, and `slugbase_app` has no
// privilege on it: the system operations of src/sql/070-session-functions.sql
// are its only readers and writers (src/sql/060-accounts-sessions.sql).
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    /** SHA-256 of the 32-byte token; the token itself is never stored. */
    tokenHash: bytea().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    level: text().notNull(),
    /** The workspace the session acts in; the workspace's deletion sets it to null, and the tenant resolver re-derives it. */
    activeWorkspaceId: uuid().references(() => workspaces.id, { onDelete: "set null" }),
    reauthAt: timestamp({ withTimezone: true }),
    remember: boolean().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp({ withTimezone: true }).notNull(),
    /** The first two octets of an IPv4 address (a /16) or an IPv6 /48; never a precise address. */
    ipPrefix: cidr(),
    /** Truncated to 256 characters. */
    userAgent: text(),
    /** Codes refused while the session is partial; the fifth deletes it (sys_session_mfa_failure). */
    mfaFailures: smallint().notNull().default(0),
  },
  (table) => [
    unique("sessions_token_hash_key").on(table.tokenHash),
    check("sessions_token_hash_check", sql`length(${table.tokenHash}) = 32`),
    check("sessions_level_check", sql`${table.level} IN ('partial', 'full')`),
    check("sessions_user_agent_check", sql`length(${table.userAgent}) <= 256`),
    check("sessions_mfa_failures_check", sql`${table.mfaFailures} >= 0`),
    index("sessions_account_id_idx").on(table.accountId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);
