import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Accounts). */
export const userAccounts = pgTable("user_accounts", {
  id: text("id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  emailVerified: boolean("email_verified").notNull(),
  mfaState: text("mfa_state").notNull(),
  language: text("language").notNull(),
  aiOptOut: boolean("ai_opt_out").notNull(),
});
