import { dailySnapshots } from "@slugbase/db-admin/schema";
import { lt } from "drizzle-orm";

import type { AdminDb } from "../db/create-db.js";
import { captureAdminJobFailure } from "../error-reporting/sentry.js";
import { formatUtcDate } from "./snapshot-rollup.js";

export const DEFAULT_RETENTION_CRON = "0 3 1 * *";

const RETENTION_DAYS = 400;

export class RetentionJob {
  constructor(private readonly adminDb: AdminDb) {}

  retentionCutoffDate(reference: Date = new Date()): string {
    const cutoff = new Date(reference);
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    return formatUtcDate(cutoff);
  }

  async run(reference: Date = new Date()): Promise<number> {
    const cutoffDate = this.retentionCutoffDate(reference);
    const deleted = await this.adminDb.db
      .delete(dailySnapshots)
      .where(lt(dailySnapshots.snapshotDate, cutoffDate))
      .returning({ id: dailySnapshots.id });

    return deleted.length;
  }

  async runSafe(reference: Date = new Date()): Promise<number | null> {
    try {
      return await this.run(reference);
    } catch (error) {
      captureAdminJobFailure(error, "retention");
      return null;
    }
  }
}

export function createRetentionJob(adminDb: AdminDb): RetentionJob {
  return new RetentionJob(adminDb);
}
