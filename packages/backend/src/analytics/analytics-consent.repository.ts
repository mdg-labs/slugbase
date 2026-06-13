import { randomUUID } from "node:crypto";

import { eq, or } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { analyticsConsents } from "./analytics-consent.schema.js";

export interface AnalyticsConsentRecord {
  id: string;
  userId: string | null;
  clientId: string;
  granted: boolean;
  updatedAt: Date;
}

export interface UpsertAnalyticsConsentData {
  clientId: string;
  userId?: string | null;
  granted: boolean;
}

function toRecord(row: {
  id: string;
  userId: string | null;
  clientId: string;
  granted: boolean | number;
  updatedAt: Date | number;
}): AnalyticsConsentRecord {
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    granted: Boolean(row.granted),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  };
}

export class AnalyticsConsentRepository {
  constructor(private readonly db: DrizzleClient) {}

  async findByClientOrUser(
    clientId: string,
    userId?: string | null,
  ): Promise<AnalyticsConsentRecord | null> {

        const conditions = userId
      ? [
          eq(analyticsConsents.clientId, clientId),
          eq(analyticsConsents.userId, userId),
        ]
      : [eq(analyticsConsents.clientId, clientId)];

    const rows = await this.db
      .select()
      .from(analyticsConsents)
      .where(or(...conditions))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async upsert(data: UpsertAnalyticsConsentData): Promise<AnalyticsConsentRecord> {
    const nowMs = Date.now();
    const existing = await this.findByClientOrUser(data.clientId, data.userId);

    if (existing) {

    await this.db
          .update(analyticsConsents)
          .set({
            granted: data.granted,
            userId: data.userId ?? existing.userId,
            updatedAt: nowMs,
          })
          .where(eq(analyticsConsents.id, existing.id));

      return {
        ...existing,
        granted: data.granted,
        userId: data.userId ?? existing.userId,
        updatedAt: new Date(nowMs),
      };
    }

    const id = randomUUID();

    await this.db.insert(analyticsConsents).values({
        id,
        clientId: data.clientId,
        userId: data.userId ?? null,
        granted: data.granted,
        updatedAt: nowMs,
      });

    return {
      id,
      clientId: data.clientId,
      userId: data.userId ?? null,
      granted: data.granted,
      updatedAt: new Date(nowMs),
    };
  }
}
