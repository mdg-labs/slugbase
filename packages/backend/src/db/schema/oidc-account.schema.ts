import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const oidcAccounts = sqliteTable(
  "oidc_accounts",
  {
    id: text("id").primaryKey(),
    /** FK → user_accounts.id */
    userId: text("user_id").notNull(),
    /** FK → oidc_providers.id */
    providerId: text("provider_id").notNull(),
    /** The OIDC `sub` claim from the IdP */
    subject: text("subject").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("oidc_accounts_provider_subject_unique_idx").on(
      t.providerId,
      t.subject,
    ),
    index("oidc_accounts_user_id_idx").on(t.userId),
  ],
);
