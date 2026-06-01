import {
  bigint,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** First 8 hex chars of the raw token (after the `slb_` prefix) — used for fast lookup. */
    tokenPrefix: text("token_prefix").notNull(),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("api_tokens_user_id_name_unique_idx").on(t.userId, t.name),
    index("api_tokens_token_prefix_idx").on(t.tokenPrefix),
  ],
);
