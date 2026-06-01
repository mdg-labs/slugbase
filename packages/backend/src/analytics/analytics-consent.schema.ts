import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { userAccounts } from "../db/schema/user-account.schema.js";

/**
 * Persisted analytics consent decisions (spec §11.6, §18).
 * Anonymous visitors are keyed by client_id cookie; signed-in users by user_id.
 */
export const analyticsConsents = sqliteTable(
  "analytics_consents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => userAccounts.id, {
      onDelete: "cascade",
    }),
    clientId: text("client_id").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("analytics_consents_user_id_unique_idx").on(t.userId),
    uniqueIndex("analytics_consents_client_id_unique_idx").on(t.clientId),
    index("analytics_consents_granted_idx").on(t.granted),
  ],
);
