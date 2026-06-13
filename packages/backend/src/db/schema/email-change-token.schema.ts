import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const emailChangeTokens = pgTable(
  "email_change_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    pendingEmail: text("pending_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    usedAt: bigint("used_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("email_change_tokens_user_id_idx").on(t.userId),
    index("email_change_tokens_token_hash_idx").on(t.tokenHash),
  ],
);
