import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea, citext } from "./types.ts";

// `credential_tokens` of doc 05 section 2.1: one table for every emailed single-use
// token. Row-level security (enabled and forced, no policy), the missing privileges of
// `slugbase_app` and the system operations that issue and redeem a token live in
// src/sql/190-credential-tokens.sql, which Drizzle cannot express.

/**
 * A single-use token that was emailed to an address, found by the SHA-256 of the value in the link; the
 * value itself is never stored. Issuing a token of a purpose deletes the account's older unused ones of
 * that purpose. A token is redeemed once, before `expiresAt`; a used or expired row stays for 7 days and
 * is then purged (doc 05 section 6). The purposes are those of `CREDENTIAL_TOKEN_PURPOSES` in `@slugbase/core`.
 */
export const credentialTokens = pgTable(
  "credential_tokens",
  {
    id: uuid().primaryKey(),
    purpose: text().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** SHA-256 of the token as the link carries it. */
    tokenHash: bytea().notNull().unique("credential_tokens_token_hash_key"),
    /** The address an `email_change` token moves the account to, and the one an `email_change_cancel` token puts back. */
    targetEmail: citext(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "credential_tokens_purpose_check",
      sql`${table.purpose} IN ('email_verify', 'email_change', 'email_change_cancel', 'password_reset')`,
    ),
    check("credential_tokens_token_hash_check", sql`length(${table.tokenHash}) = 32`),
    index("credential_tokens_account_id_purpose_idx").on(table.accountId, table.purpose),
    index("credential_tokens_expires_at_idx").on(table.expiresAt),
  ],
);
