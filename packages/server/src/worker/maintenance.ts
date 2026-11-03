import { endAccessMode, type AccessModeEndRequest } from "@slugbase/core";
import { accessModeEndStore, type AccessModeStore, type QueuedJob, type RateLimitStore, type RetentionStore, type WorkspaceDeletionStore } from "@slugbase/db";
import { z } from "zod";
import { uuidv7 } from "../auth/uuidv7.ts";
import type { ModuleContext, ModuleContribution } from "../create-server.ts";
import { queueDomainEvent } from "../events/publish.ts";
import { defineJob, defineSchedule } from "./job.ts";
import { WORKSPACE_DELETE_JOB } from "./jobs/workspace-delete.ts";

// The retention the worker applies on its own, whatever modules it composes
// (doc 05 section 6).

/** How often the idle buckets of the rate limiter are purged; they are idle for an hour before they go. */
const PURGE_IDLE_BUCKETS_CRON = "*/15 * * * *";

/** `retention.purge` runs at the top of every hour (doc 01 section 8.1). */
const RETENTION_PURGE_CRON = "0 * * * *";

/** `accounts.endAccessMode` runs once a day (doc 02 section 2.11). */
const END_ACCESS_MODE_CRON = "20 3 * * *";

/** How many accounts whose period ended one read of the job takes, and at most how many reads one run makes. */
const END_ACCESS_MODE_BATCH = 100;
const END_ACCESS_MODE_MAX_BATCHES = 20;

/** The request id of the tenant transaction that ends one account's period; there is no request. */
const END_ACCESS_MODE_REQUEST_ID = "accounts.endAccessMode";

export interface MaintenanceStores {
  readonly accessMode: Pick<AccessModeStore, "due">;
  readonly rateLimit: Pick<RateLimitStore, "purgeIdle">;
  readonly retention: Pick<RetentionStore, "purge">;
  readonly workspaceDeletion: WorkspaceDeletionStore;
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
 *
 * `accounts.endAccessMode` applies the end action of the export-only periods whose end date has passed (doc 02 section 2.11): it reads the
 * accounts that are due and ends each in a tenant transaction of its own, acting as that account, so one account's failure leaves the others
 * ended and the run then fails to be tried again. `disable` disables the account; `delete` deletes it as `DELETE /me` does, queueing the
 * `workspace.delete` job of each workspace it was the only member of and `account.deleted` in that transaction, and disables it instead
 * when ownership of a workspace cannot be resolved by a job. An account whose period ended is no longer due, so a second run, or two
 * workers, act once; the database decides again under its locks. The log lines carry counts and identifiers, never an address or a name.
 */
export function maintenanceContribution(stores: MaintenanceStores, context: Pick<ModuleContext, "withTenant">): ModuleContribution {
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
  const endAccessModes = defineJob({
    name: "accounts.endAccessMode",
    payload: z.object({}),
    handle: async (_payload, jobContext) => {
      const ended = { disabled: 0, deleted: 0, deletionBlocked: 0, notDue: 0, unavailable: 0 };
      let failed = 0;
      for (let batch = 0; batch < END_ACCESS_MODE_MAX_BATCHES; batch += 1) {
        const due = await stores.accessMode.due(END_ACCESS_MODE_BATCH);
        let settled = 0;
        for (const { accountId, endAction } of due) {
          try {
            const outcome = await context.withTenant({ accountId, requestId: END_ACCESS_MODE_REQUEST_ID }, (tx) =>
              endAccessMode({ store: accessModeEndStore(tx, endJobs), newId: uuidv7 }, { accountId, endAction }),
            );
            switch (outcome.kind) {
              case "disabled":
                ended.disabled += 1;
                ended.deletionBlocked += outcome.deletionBlocked ? 1 : 0;
                settled += 1;
                break;
              case "deleted":
                ended.deleted += 1;
                settled += 1;
                break;
              case "not_due":
                ended.notDue += 1;
                settled += 1;
                break;
              case "unavailable":
                ended.unavailable += 1;
                break;
            }
          } catch (error) {
            failed += 1;
            jobContext.logger.warn("Ending an export-only period failed", { accountId, error: error instanceof Error ? error.name : "unknown" });
          }
        }
        // A batch that left an account unended would return it again; the next run tries it.
        if (due.length < END_ACCESS_MODE_BATCH || settled < due.length) {
          break;
        }
      }
      jobContext.logger.info("Export-only periods ended", ended);
      if (failed > 0 || ended.unavailable > 0) {
        throw new Error(`ending the export-only period failed for ${String(failed + ended.unavailable)} accounts`);
      }
    },
  });
  const endAccessModeSchedule = defineSchedule({
    name: "accounts.endAccessMode",
    cron: END_ACCESS_MODE_CRON,
    job: endAccessModes.name,
  });
  return { jobs: [purgeIdleBuckets, retentionPurge, endAccessModes], schedules: [schedule, retentionSchedule, endAccessModeSchedule] };
}

/** The jobs and events a deletion queues in the transaction that deletes the account: the deletion of each workspace it was the only member of, and `account.deleted`. */
function endJobs(request: AccessModeEndRequest): readonly QueuedJob[] {
  return [
    ...request.soleWorkspaceIds.map((workspaceId) => ({ id: uuidv7(), queue: WORKSPACE_DELETE_JOB, data: { workspaceId } })),
    ...request.events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
  ];
}
