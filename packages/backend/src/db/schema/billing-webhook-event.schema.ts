import { bigint, pgTable, text } from "drizzle-orm/pg-core";

/** Idempotency ledger for processed Stripe billing webhook events (spec §11.4, §16). */
export const billingWebhookEvents = pgTable("billing_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: bigint("processed_at", { mode: "number" }).notNull(),
});
