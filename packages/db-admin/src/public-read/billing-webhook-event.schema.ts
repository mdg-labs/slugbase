import { pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Webhook ledger aggregates). */
export const billingWebhookEvents = pgTable("billing_webhook_events", {
  eventType: text("event_type").notNull(),
});
