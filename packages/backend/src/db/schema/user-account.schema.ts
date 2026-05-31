import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const userAccounts = sqliteTable(
  "user_accounts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    language: text("language").notNull().default("en"),
    theme: text("theme").notNull().default("auto"),
    isInstanceAdmin: integer("is_instance_admin", { mode: "boolean" })
      .notNull()
      .default(false),
    mfaState: text("mfa_state").notNull().default("not_enrolled"),
    mfaTotpSecretEncrypted: text("mfa_totp_secret_encrypted"),
    aiOptOut: integer("ai_opt_out", { mode: "boolean" })
      .notNull()
      .default(false),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("user_accounts_email_unique_idx").on(t.email),
    index("user_accounts_is_instance_admin_idx").on(t.isInstanceAdmin),
  ],
);
