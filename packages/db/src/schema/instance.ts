import { sql } from "drizzle-orm";
import { check, pgTable, smallint, timestamp, uuid } from "drizzle-orm/pg-core";
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
