import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** First 8 hex chars of the raw token (after the `slb_` prefix) — used for fast lookup. */
    tokenPrefix: text("token_prefix").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("api_tokens_user_id_name_unique_idx").on(t.userId, t.name),
    index("api_tokens_token_prefix_idx").on(t.tokenPrefix),
  ],
);
