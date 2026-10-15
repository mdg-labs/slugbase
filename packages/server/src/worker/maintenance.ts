import type { RateLimitStore, RetentionStore } from "@slugbase/db";
import { z } from "zod";
import type { ModuleContribution } from "../create-server.ts";
import { defineJob, defineSchedule } from "./job.ts";

// The retention the worker applies on its own, whatever modules it composes
// (doc 05 section 6).

/** How often the idle buckets of the rate limiter are purged; they are idle for an hour before they go. */
const PURGE_IDLE_BUCKETS_CRON = "*/15 * * * *";

/** `retention.purge` runs at the top of every hour (doc 01 section 8.1). */
const RETENTION_PURGE_CRON = "0 * * * *";

export interface MaintenanceStores {
  readonly rateLimit: Pick<RateLimitStore, "purgeIdle">;
  readonly retention: Pick<RetentionStore, "purge">;
}

/**
 * The two jobs, each through a system operation of `@slugbase/db`.
 *
 * `rateLimit.purgeIdle` deletes the rate-limit buckets idle for more than an
 * hour; it is idempotent: a second run finds nothing more to delete than what
 * has become idle since. `retention.purge` deletes, per table, at most one
 * batch (5 000) of the rows past their retention (doc 05 section 6) and logs
 * how many it deleted per table, never a row; a second run can still find rows
 * that were already due when the first ran, and a table with more due rows
 * than a batch is finished by the next runs.
 * Its schedule is a pg-boss schedule, which runs once per tick across all
 * workers.
 */
export function maintenanceContribution(stores: MaintenanceStores): ModuleContribution {
  const purgeIdleBuckets = defineJob({
    name: "rateLimit.purgeIdle",
    payload: z.object({}),
    handle: async (_payload, context) => {
      const deleted = await stores.rateLimit.purgeIdle();
      context.logger.info("Idle rate-limit buckets purged", { deleted });
    },
  });
  const schedule = defineSchedule({
    name: "rateLimit.purgeIdle",
    cron: PURGE_IDLE_BUCKETS_CRON,
    job: purgeIdleBuckets.name,
  });
  const retentionPurge = defineJob({
    name: "retention.purge",
    payload: z.object({}),
    handle: async (_payload, context) => {
      const counts = await stores.retention.purge();
      context.logger.info("Retention purge finished", {
        deleted: Object.fromEntries(counts.map(({ table, deleted }) => [table, deleted])),
      });
    },
  });
  const retentionSchedule = defineSchedule({
    name: "retention.purge",
    cron: RETENTION_PURGE_CRON,
    job: retentionPurge.name,
  });
  return { jobs: [purgeIdleBuckets, retentionPurge], schedules: [schedule, retentionSchedule] };
}
