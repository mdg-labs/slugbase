import { eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { billingWebhookEvents as sqliteBillingWebhookEvents } from "../db/schema/index.js";
import { billingWebhookEvents as pgBillingWebhookEvents } from "../db/schema/pg-index.js";

export interface BillingWebhookEventRecord {
  eventId: string;
  eventType: string;
  processedAt: Date;
}

export class BillingWebhookEventRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async hasProcessed(eventId: string): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteBillingWebhookEvents)
        .where(eq(sqliteBillingWebhookEvents.eventId, eventId))
        .get();
      return row !== undefined;
    }

    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgBillingWebhookEvents)
      .where(eq(pgBillingWebhookEvents.eventId, eventId))
      .limit(1);
    return rows.length > 0;
  }

  async recordProcessed(eventId: string, eventType: string): Promise<void> {
    const processedAt = Date.now();

    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .insert(sqliteBillingWebhookEvents)
        .values({
          eventId,
          eventType,
          processedAt: new Date(processedAt),
        })
        .run();
      return;
    }

    await (this.db as PostgresDrizzleClient)
      .insert(pgBillingWebhookEvents)
      .values({ eventId, eventType, processedAt });
  }
}
