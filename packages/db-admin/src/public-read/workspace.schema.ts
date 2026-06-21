import { bigint, boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Workspaces). */
export const workspaces = pgTable("workspaces", {
  id: text("id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  plan: text("plan").notNull(),
  planSeats: integer("plan_seats"),
  planArchived: boolean("plan_archived").notNull(),
  billingStatus: text("billing_status"),
  billingPeriodEnd: bigint("billing_period_end", { mode: "number" }),
  permanentPersonal: boolean("permanent_personal").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
