import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPublicReadDb, fetchLiveOverviewStats } from "./index.js";
import {
  ensurePublicProductTables,
  resetPublicProductTables,
  seedPublicProductOverviewData,
} from "./test/public-product-fixture.js";

const FIXED_NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);

function assertNoSensitiveFields(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/password_hash/i);
  expect(serialized).not.toMatch(/token_hash/i);
  expect(serialized).not.toMatch(/secret-hash/i);
  expect(serialized).not.toMatch(/invite-token-hash/i);
  expect(serialized).not.toMatch(/session-secret/i);
}

describe("public-read overview queries (integration)", () => {
  let sql: postgres.Sql;
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    sql = postgres(databaseUrl, { max: 1 });
    await ensurePublicProductTables(sql);
  });

  beforeEach(async () => {
    await resetPublicProductTables(sql);
    await seedPublicProductOverviewData(sql, { nowMs: FIXED_NOW_MS });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("returns §9.1 live overview aggregates without sensitive fields", async () => {
    const publicReadDb = createPublicReadDb(databaseUrl);

    try {
      const stats = await fetchLiveOverviewStats(publicReadDb, FIXED_NOW_MS);

      expect(stats.totalAccounts).toBe(3);
      expect(stats.totalWorkspaces).toBe(3);
      expect(stats.signupsLast7Days).toBe(2);
      expect(stats.signupsLast30Days).toBe(2);
      expect(stats.planDistribution).toEqual(
        expect.arrayContaining([
          { plan: "free", count: 1 },
          { plan: "personal", count: 1 },
          { plan: "team", count: 1 },
        ]),
      );
      expect(stats.paidVsFree.freeWorkspaces).toBe(1);
      expect(stats.paidVsFree.paidWorkspaces).toBe(2);
      expect(stats.activeBookmarks).toBe(2);
      expect(stats.planArchivedBookmarks).toBe(1);
      expect(stats.mfaAdoption).toEqual({ enrolled: 1, total: 3 });
      expect(stats.emailVerification).toEqual({ verified: 2, total: 3 });
      expect(stats.activeSessions).toBe(1);
      expect(stats.pendingInvitations).toBe(1);
      expect(stats.processedWebhookEvents.total).toBe(3);
      expect(stats.processedWebhookEvents.byEventType).toEqual(
        expect.arrayContaining([
          { eventType: "customer.subscription.updated", count: 2 },
          { eventType: "invoice.paid", count: 1 },
        ]),
      );

      assertNoSensitiveFields(stats);
    } finally {
      await publicReadDb.close();
    }
  });
});
