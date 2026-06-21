import cron from "node-cron";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import { priorUtcDate } from "./snapshot-rollup.js";
import { createRetentionJob, DEFAULT_RETENTION_CRON } from "./retention.job.js";
import { createSnapshotJob } from "./snapshot.job.js";

export type AdminScheduler = {
  stop: () => void;
};

export function startAdminScheduler(
  adminDb: AdminDb,
  config: AdminEnv,
): AdminScheduler {
  const snapshotJob = createSnapshotJob(adminDb, config.DATABASE_URL);
  const retentionJob = createRetentionJob(adminDb);

  const snapshotTask = cron.schedule(
    config.ADMIN_SNAPSHOT_CRON,
    () => {
      void snapshotJob.runSafe(priorUtcDate());
    },
    { timezone: "UTC" },
  );

  const retentionTask = cron.schedule(
    DEFAULT_RETENTION_CRON,
    () => {
      void retentionJob.runSafe();
    },
    { timezone: "UTC" },
  );

  return {
    stop: () => {
      void snapshotTask.stop();
      void retentionTask.stop();
    },
  };
}
