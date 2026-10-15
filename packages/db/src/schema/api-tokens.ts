import { sql } from "drizzle-orm";
import { check, cidr, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./types.ts";
import { workspaceMembers } from "./workspaces.ts";

// `api_tokens` of doc 05 section 2.1: personal API tokens, stored only as the
// SHA-256 of the token and bound to one workspace the account is a member of.
// Losing the membership deletes the token (the composite foreign key). Row-level
// security, the privileges of `slugbase_app` and the column list it may read
// (never `token_hash`) live in src/sql/150-api-tokens.sql, which Drizzle cannot
// express. A revoked token keeps its row, so revoking it again is the same
// answer as the first time (doc 04 section 2.4); a name is unique among the
// account's tokens that are not revoked.
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid().primaryKey(),
    accountId: uuid().notNull(),
    workspaceId: uuid().notNull(),
    name: text().notNull(),
    /** SHA-256 of the token as the bearer presents it; the token itself is never stored. */
    tokenHash: bytea().notNull().unique("api_tokens_token_hash_key"),
    /** The first six characters after `slb_`, for display and leak scanning. */
    tokenPrefix: text().notNull(),
    scope: text().notNull(),
    /** Null means the token never expires. */
    expiresAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    /** The coarse network of the last use, written with `last_used_at`. */
    lastUsedIpPrefix: cidr(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "api_tokens_workspace_id_account_id_fkey",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.accountId],
    }).onDelete("cascade"),
    check("api_tokens_name_check", sql`length(${table.name}) BETWEEN 1 AND 64`),
    check("api_tokens_token_hash_check", sql`length(${table.tokenHash}) = 32`),
    check("api_tokens_token_prefix_check", sql`length(${table.tokenPrefix}) = 6`),
    check("api_tokens_scope_check", sql`${table.scope} IN ('read', 'read-write')`),
    uniqueIndex("api_tokens_account_id_name_key").on(table.accountId, table.name).where(sql`${table.revokedAt} IS NULL`),
    index("api_tokens_account_id_idx").on(table.accountId),
    index("api_tokens_workspace_id_account_id_idx").on(table.workspaceId, table.accountId),
  ],
);
