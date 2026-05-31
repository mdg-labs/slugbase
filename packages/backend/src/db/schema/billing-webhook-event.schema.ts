import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Idempotency ledger for processed Stripe billing webhook events (spec §11.4, §16). */
export const billingWebhookEvents = sqliteTable("billing_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull(),
});
