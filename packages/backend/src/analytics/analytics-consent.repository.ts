import { randomUUID } from "node:crypto";

import { eq, or } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { analyticsConsents as sqliteAnalyticsConsents } from "./analytics-consent.schema.js";
import { analyticsConsents as pgAnalyticsConsents } from "./analytics-consent.schema.pg.js";

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
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async findByClientOrUser(
    clientId: string,
    userId?: string | null,
  ): Promise<AnalyticsConsentRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions = userId
        ? [
            eq(sqliteAnalyticsConsents.clientId, clientId),
            eq(sqliteAnalyticsConsents.userId, userId),
          ]
        : [eq(sqliteAnalyticsConsents.clientId, clientId)];

      const row = sqliteDb
        .select()
        .from(sqliteAnalyticsConsents)
        .where(or(...conditions))
        .get();
      return row ? toRecord(row) : null;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions = userId
      ? [
          eq(pgAnalyticsConsents.clientId, clientId),
          eq(pgAnalyticsConsents.userId, userId),
        ]
      : [eq(pgAnalyticsConsents.clientId, clientId)];

    const rows = await pgDb
      .select()
      .from(pgAnalyticsConsents)
      .where(or(...conditions))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async upsert(data: UpsertAnalyticsConsentData): Promise<AnalyticsConsentRecord> {
    const nowMs = Date.now();
    const existing = await this.findByClientOrUser(data.clientId, data.userId);

    if (existing) {
      if (this.dialect === "sqlite") {
        const sqliteDb = this.db as SqliteDrizzleClient;
        sqliteDb
          .update(sqliteAnalyticsConsents)
          .set({
            granted: data.granted,
            userId: data.userId ?? existing.userId,
            updatedAt: new Date(nowMs),
          })
          .where(eq(sqliteAnalyticsConsents.id, existing.id))
          .run();
      } else {
        const pgDb = this.db as PostgresDrizzleClient;
        await pgDb
          .update(pgAnalyticsConsents)
          .set({
            granted: data.granted,
            userId: data.userId ?? existing.userId,
            updatedAt: nowMs,
          })
          .where(eq(pgAnalyticsConsents.id, existing.id));
      }

      return {
        ...existing,
        granted: data.granted,
        userId: data.userId ?? existing.userId,
        updatedAt: new Date(nowMs),
      };
    }

    const id = randomUUID();
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteAnalyticsConsents)
        .values({
          id,
          clientId: data.clientId,
          userId: data.userId ?? null,
          granted: data.granted,
          updatedAt: new Date(nowMs),
        })
        .run();
    } else {
      const pgDb = this.db as PostgresDrizzleClient;
      await pgDb.insert(pgAnalyticsConsents).values({
        id,
        clientId: data.clientId,
        userId: data.userId ?? null,
        granted: data.granted,
        updatedAt: nowMs,
      });
    }

    return {
      id,
      clientId: data.clientId,
      userId: data.userId ?? null,
      granted: data.granted,
      updatedAt: new Date(nowMs),
    };
  }
}
