import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const oidcAccounts = pgTable(
  "oidc_accounts",
  {
    id: text("id").primaryKey(),
    /** FK → user_accounts.id */
    userId: text("user_id").notNull(),
    /** Env-configured provider slug (no FK; spec §16) */
    providerId: text("provider_id").notNull(),
    /** The OIDC `sub` claim from the IdP */
    subject: text("subject").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("oidc_accounts_provider_subject_unique_idx").on(
      t.providerId,
      t.subject,
    ),
    index("oidc_accounts_user_id_idx").on(t.userId),
  ],
);
