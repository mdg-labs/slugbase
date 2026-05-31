import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const emailVerificationTokens = sqliteTable(
  "email_verification_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("email_verification_tokens_user_id_idx").on(t.userId),
    index("email_verification_tokens_token_hash_idx").on(t.tokenHash),
  ],
);
