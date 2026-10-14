import type { RateLimitStore } from "@slugbase/db";
import { z } from "zod";
import type { ServerModule } from "../create-server.ts";
import { defineJob, defineSchedule } from "./job.ts";

// The retention the worker applies on its own, whatever modules it composes
// (doc 05 section 6).

/** How often the idle buckets of the rate limiter are purged; they are idle for an hour before they go. */
const PURGE_IDLE_BUCKETS_CRON = "*/15 * * * *";

/**
 * Deletes the rate-limit buckets idle for more than an hour through the
 * system operation of `@slugbase/db`. A second run finds nothing more to
 * delete, so the job is idempotent.
 */
export function createMaintenanceModule(store: Pick<RateLimitStore, "purgeIdle">): ServerModule {
  const purgeIdleBuckets = defineJob({
    name: "rateLimit.purgeIdle",
    payload: z.object({}),
    handle: async (_payload, context) => {
      const deleted = await store.purgeIdle();
      context.logger.info("Idle rate-limit buckets purged", { deleted });
    },
  });
  const schedule = defineSchedule({
    name: "rateLimit.purgeIdle",
    cron: PURGE_IDLE_BUCKETS_CRON,
    job: purgeIdleBuckets.name,
  });
  return { name: "@slugbase/server/maintenance", register: () => ({ jobs: [purgeIdleBuckets], schedules: [schedule] }) };
}
