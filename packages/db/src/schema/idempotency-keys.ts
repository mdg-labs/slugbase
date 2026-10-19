import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { bytea } from "./types.ts";

// `idempotency_keys` of doc 05 section 2.10. Row-level security, the policy on the account and the privileges
// of `slugbase_app` live in src/sql/310-idempotency-keys.sql, which Drizzle cannot express.

/** Where a key stands: `in_progress` while the request that holds it runs, `done` once its response is stored. */
export type IdempotencyStatus = "in_progress" | "done";

/**
 * The `Idempotency-Key` of a request (doc 04 section 6.3), scoped to the account that sent it: the same UUID
 * from two accounts is two rows. The row is written and completed in the transaction that runs the request,
 * so another request with the key waits on the unique index until that transaction ends and then finds the
 * stored response, or finds no row when the request failed and runs itself. `request_hash` is the SHA-256 of
 * what the request asked for, so the same key with another request is a conflict and not a replay.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    key: uuid().notNull(),
    /** The operation the key was first used for. */
    operation: text().notNull(),
    requestHash: bytea().notNull(),
    status: text().notNull().default("in_progress"),
    /** The HTTP status of the stored response; null until the key is done. */
    responseStatus: integer(),
    /** The JSON body of the stored response; null for a response without one. */
    responseBody: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** 24 hours after the key was first used, on the database clock; an expired key is as good as absent. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "idempotency_keys_pkey", columns: [table.accountId, table.key] }),
    check("idempotency_keys_operation_check", sql`length(${table.operation}) BETWEEN 1 AND 100`),
    check("idempotency_keys_request_hash_check", sql`length(${table.requestHash}) = 32`),
    check("idempotency_keys_status_check", sql`${table.status} IN ('in_progress', 'done')`),
    check("idempotency_keys_done_check", sql`(${table.status} = 'done') = (${table.responseStatus} IS NOT NULL)`),
    check("idempotency_keys_response_status_check", sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 200 AND 299`),
    index("idempotency_keys_expires_at_idx").on(table.expiresAt),
  ],
);
