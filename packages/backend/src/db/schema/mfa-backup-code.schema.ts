import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const mfaBackupCodes = pgTable(
  "mfa_backup_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { mode: "date" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("mfa_backup_codes_user_id_idx").on(t.userId)],
);
