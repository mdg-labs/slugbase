import { bigint, boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const userAccounts = pgTable(
  "user_accounts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    language: text("language").notNull().default("en"),
    theme: text("theme").notNull().default("auto"),
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    mfaState: text("mfa_state").notNull().default("not_enrolled"),
    aiOptOut: boolean("ai_opt_out").notNull().default(false),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("user_accounts_email_unique_idx").on(t.email),
    index("user_accounts_is_instance_admin_idx").on(t.isInstanceAdmin),
  ],
);
