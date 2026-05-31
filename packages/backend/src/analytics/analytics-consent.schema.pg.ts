import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { userAccounts } from "../db/schema/user-account.schema.pg.js";

export const analyticsConsents = pgTable(
  "analytics_consents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => userAccounts.id, {
      onDelete: "cascade",
    }),
    clientId: text("client_id").notNull(),
    granted: boolean("granted").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("analytics_consents_user_id_unique_idx").on(t.userId),
    uniqueIndex("analytics_consents_client_id_unique_idx").on(t.clientId),
    index("analytics_consents_granted_idx").on(t.granted),
  ],
);
