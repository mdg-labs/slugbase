import { sql } from "drizzle-orm";
import { boolean, check, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea } from "./types.ts";

// `instance_state` of doc 05 section 2.2: the one row that records whether
// first-run setup happened. It holds no personal data and has no row-level
// security; `slugbase_app` has no privilege on it, and the system operations of
// src/sql/120-setup.sql (sys_setup_status, sys_setup_token_set, sys_complete_setup)
// are its only readers and writers.
export const instanceState = pgTable(
  "instance_state",
  {
    id: smallint().primaryKey(),
    /** Set once, by the setup that created the first account; the setup endpoint is closed for good after it. */
    setupCompletedAt: timestamp({ withTimezone: true }),
    setupBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
    /** SHA-256 of the one-time setup token; the token itself is never stored. Cleared when setup completes. */
    setupTokenHash: bytea(),
  },
  (table) => [
    check("instance_state_id_check", sql`${table.id} = 1`),
    check("instance_state_setup_token_hash_check", sql`length(${table.setupTokenHash}) = 32`),
  ],
);

// `instance_settings` of doc 05 section 2.2: the one row of typed values the instance admin edits (doc 02 section
// 11.3). It holds no personal data and has no row-level security: the display name and the sign-in notice are
// public on the sign-in page. `slugbase_app` has SELECT only; the row is written by `sys_instance_update_settings`
// of src/sql/370-instance-settings.sql, which checks the admin and writes the instance audit event. A column of
// NULL means the setting was never set (or was cleared), and the deployment's own default applies. The row is
// created by the first update, so a reader treats a missing row as every column NULL.
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: smallint().primaryKey(),
    /** NULL uses the default the composition root supplies; a stored value overrides it on the next request. */
    allowWorkspaceCreation: boolean(),
    /** The instance name the sign-in page shows. */
    displayName: text(),
    /** Plain text, at most 500 characters; the sign-in page renders it as text only. */
    signInNotice: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => accounts.id, { onDelete: "set null" }),
  },
  (table) => [
    check("instance_settings_id_check", sql`${table.id} = 1`),
    check("instance_settings_display_name_check", sql`length(${table.displayName}) BETWEEN 1 AND 100`),
    check("instance_settings_sign_in_notice_check", sql`length(${table.signInNotice}) BETWEEN 1 AND 500`),
  ],
);
