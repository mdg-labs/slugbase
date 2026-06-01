import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull().default("free"),
    planSeats: integer("plan_seats"),
    planArchived: boolean("plan_archived").notNull().default(false),
    billingCustomerId: text("billing_customer_id"),
    billingSubscriptionId: text("billing_subscription_id"),
    billingStatus: text("billing_status"),
    billingPeriodEnd: bigint("billing_period_end", { mode: "number" }),
    permanentPersonal: boolean("permanent_personal").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workspaces_slug_unique_idx").on(t.slug)],
);
