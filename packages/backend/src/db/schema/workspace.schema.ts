import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull().default("free"),
    planSeats: integer("plan_seats"),
    planArchived: integer("plan_archived", { mode: "boolean" })
      .notNull()
      .default(false),
    billingCustomerId: text("billing_customer_id"),
    billingSubscriptionId: text("billing_subscription_id"),
    billingStatus: text("billing_status"),
    billingPeriodEnd: integer("billing_period_end", { mode: "timestamp_ms" }),
    permanentPersonal: integer("permanent_personal", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("workspaces_slug_unique_idx").on(t.slug)],
);
