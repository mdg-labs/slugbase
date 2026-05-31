import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mfaBackupCodes = sqliteTable(
  "mfa_backup_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("mfa_backup_codes_user_id_idx").on(t.userId)],
);
