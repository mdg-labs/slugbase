import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea } from "./types.ts";

// `mfa_backup_codes` of doc 05 section 2.1: the single-use codes that stand in
// for a TOTP code. `code_hash` is the argon2id PHC string of the 10-character
// code, as bytes: a code carries little entropy, so the hash is a slow one. The
// table has forced row-level security and no policy, and `slugbase_app` has no
// privilege on it; the system operations of src/sql/140-mfa.sql are its only
// readers and writers.
export const mfaBackupCodes = pgTable(
  "mfa_backup_codes",
  {
    id: uuid().primaryKey(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    codeHash: bytea().notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    check("mfa_backup_codes_code_hash_check", sql`length(${table.codeHash}) > 0`),
    index("mfa_backup_codes_unused_idx").on(table.accountId).where(sql`${table.usedAt} IS NULL`),
  ],
);
