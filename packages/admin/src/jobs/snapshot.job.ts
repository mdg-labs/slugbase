import { dailySnapshots } from "@slugbase/db-admin/schema";
import type { PublicReadDb } from "@slugbase/db-admin/public-read";

import type { AdminDb } from "../db/create-db.js";
import { captureAdminJobFailure } from "../error-reporting/sentry.js";
import {
  createSnapshotPublicReadDb,
  fetchDailySnapshotRollup,
  priorUtcDate,
  type DailySnapshotRollup,
} from "./snapshot-rollup.js";

export class SnapshotJob {
  constructor(
    private readonly adminDb: AdminDb,
    private readonly publicReadDb: PublicReadDb,
  ) {}

  async run(snapshotDate: string = priorUtcDate()): Promise<DailySnapshotRollup> {
    const rollup = await fetchDailySnapshotRollup(this.publicReadDb, snapshotDate);
    await this.upsertSnapshot(rollup);
    return rollup;
  }

  async runSafe(snapshotDate: string = priorUtcDate()): Promise<DailySnapshotRollup | null> {
    try {
      return await this.run(snapshotDate);
    } catch (error) {
      captureAdminJobFailure(error, "snapshot");
      return null;
    }
  }

  private async upsertSnapshot(rollup: DailySnapshotRollup): Promise<void> {
    await this.adminDb.db
      .insert(dailySnapshots)
      .values({
        snapshotDate: rollup.snapshotDate,
        totalAccounts: rollup.totalAccounts,
        newAccounts: rollup.newAccounts,
        verifiedAccounts: rollup.verifiedAccounts,
        mfaEnrolledAccounts: rollup.mfaEnrolledAccounts,
        totalWorkspaces: rollup.totalWorkspaces,
        newWorkspaces: rollup.newWorkspaces,
        workspacesByPlan: rollup.workspacesByPlan,
        totalBookmarks: rollup.totalBookmarks,
        planArchivedBookmarks: rollup.planArchivedBookmarks,
        totalMemberships: rollup.totalMemberships,
        activeSubscriptions: rollup.activeSubscriptions,
        processedWebhookEvents: rollup.processedWebhookEvents,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: dailySnapshots.snapshotDate,
        set: {
          totalAccounts: rollup.totalAccounts,
          newAccounts: rollup.newAccounts,
          verifiedAccounts: rollup.verifiedAccounts,
          mfaEnrolledAccounts: rollup.mfaEnrolledAccounts,
          totalWorkspaces: rollup.totalWorkspaces,
          newWorkspaces: rollup.newWorkspaces,
          workspacesByPlan: rollup.workspacesByPlan,
          totalBookmarks: rollup.totalBookmarks,
          planArchivedBookmarks: rollup.planArchivedBookmarks,
          totalMemberships: rollup.totalMemberships,
          activeSubscriptions: rollup.activeSubscriptions,
          processedWebhookEvents: rollup.processedWebhookEvents,
          computedAt: new Date(),
        },
      });
  }
}

export function createSnapshotJob(
  adminDb: AdminDb,
  databaseUrl: string,
): SnapshotJob {
  return new SnapshotJob(adminDb, createSnapshotPublicReadDb(databaseUrl));
}
