import { eq } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { billingWebhookEvents } from "../db/schema/index.js";

export interface BillingWebhookEventRecord {
  eventId: string;
  eventType: string;
  processedAt: Date;
}

export class BillingWebhookEventRepository {
  constructor(private readonly db: DrizzleClient) {}

  async hasProcessed(eventId: string): Promise<boolean> {

    const rows = await this.db
      .select()
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.eventId, eventId))
      .limit(1);
    return rows.length > 0;
  }

  async recordProcessed(eventId: string, eventType: string): Promise<void> {
    const processedAt = Date.now();

    await this.db
      .insert(billingWebhookEvents)
      .values({ eventId, eventType, processedAt });
  }
}
