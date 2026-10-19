import type { Adapters, DomainEventName } from "@slugbase/core";
import { createDatabase, createRateLimitStore, createRetentionStore, createWorkspaceDeletionStore, type Database } from "@slugbase/db";
import { PgBoss } from "pg-boss";
import type { WorkerConfig } from "../config/index.ts";
import {
  assertAdapters,
  compose,
  type Composition,
  type Logger,
  type ModuleContext,
  type ServerModule,
} from "../create-server.ts";
import { subscribersOf, type RegisteredSubscriber } from "../events/subscriber.ts";
import { assertApplicationRole } from "../migrate/role-guard.ts";
import { createMetrics, startMetricsListener, type MetricsListener, type QueueSnapshot } from "../metrics/index.ts";
import type { JobDefinition, JobPayload, ScheduleDefinition } from "./job.ts";
import { createBuiltInModules } from "./built-in.ts";
import { queueSettings } from "./queues.ts";

export const DEFAULT_WORKER_POOL_SIZE = 5;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

const BOSS_SCHEMA = "pgboss";
const APPLICATION_NAME = "slugbase-worker";
const MAINTENANCE_POOL_SIZE = 1;

export interface CreateWorkerOptions {
  readonly config: WorkerConfig;
  readonly adapters: Adapters;
  readonly modules: readonly ServerModule[];
  readonly logger: Logger;
  /** Connections of the pg-boss pool and, separately, of the tenant pool the handlers use; default 5. */
  readonly poolSize?: number;
  /** The tenant database the handlers use; by default a pool on `DATABASE_URL`, closed on shutdown. */
  readonly database?: Database;
  /** How long a shutdown lets active jobs finish before it releases them (doc 01 section 3 rule 2). */
  readonly shutdownTimeoutMs?: number;
  /** How often an idle consumer asks for work, in seconds (at least 0.5); pg-boss's default is 2. */
  readonly pollingIntervalSeconds?: number;
}

export interface WorkerStartOptions {
  /** Overrides `METRICS_PORT`, which also turns the metrics listener on; 0 picks a free port. */
  readonly metricsPort?: number;
}

export interface RunningWorker {
  /** The port of the internal metrics listener; absent when `METRICS_PORT` is unset. */
  readonly metricsPort?: number;
  /** Puts a job on its queue. The payload is validated against the job's schema before anything is written. */
  enqueue<Payload extends JobPayload>(job: JobDefinition<Payload>, payload: Payload): Promise<string | null>;
  /**
   * Stops fetching, lets active jobs finish within the deadline, releases the
   * ones still running (they run again under their retry policy) and closes
   * the pools. Calling it again returns the same shutdown.
   */
  shutdown(): Promise<void>;
}

export interface Worker {
  readonly jobs: readonly JobDefinition[];
  readonly schedules: readonly ScheduleDefinition[];
  /**
   * In production it first refuses a `DATABASE_URL` role that is a superuser or owns the database
   * (Q56), unless `SLUGBASE_ALLOW_OWNER_CONNECTION` allows it with a warning. It then starts
   * pg-boss, registers every job's queue and consumer and every schedule, and opens the
   * internal `/metrics` listener when `METRICS_PORT` is set.
   */
  start(options?: WorkerStartOptions): Promise<RunningWorker>;
}

function errorFields(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.name : typeof error,
    code: (error as { code?: unknown } | null)?.code,
  };
}

/**
 * The worker process (doc 01 section 3): pg-boss as `slugbase_app` with the
 * modules' jobs as consumers and their schedules as pg-boss schedules. The retention
 * jobs and `mail.send` run in every worker, whatever modules it composes. It never
 * installs or migrates the pg-boss schema; `migrate` does (doc 05 section 5.5).
 * It fails before connecting when a port has no adapter or the modules conflict.
 */
export function createWorker(options: CreateWorkerOptions): Worker {
  const { config, logger } = options;
  assertAdapters(options.adapters);
  const poolSize = options.poolSize ?? DEFAULT_WORKER_POOL_SIZE;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const metrics = createMetrics();
  const database = options.database ?? createDatabase({ url: config.DATABASE_URL, poolSize });
  if (options.database === undefined) {
    metrics.setPoolSize(poolSize);
  }
  // The retention jobs the worker always runs reach their system operations on a pool of their own,
  // as the role of DATABASE_URL; it connects on first use.
  const maintenanceStores = {
    rateLimit: createRateLimitStore({ url: config.DATABASE_URL, poolSize: MAINTENANCE_POOL_SIZE }),
    retention: createRetentionStore({ url: config.DATABASE_URL, poolSize: MAINTENANCE_POOL_SIZE, auditRetentionDays: config.AUDIT_RETENTION_DAYS }),
    workspaceDeletion: createWorkspaceDeletionStore({ url: config.DATABASE_URL, poolSize: MAINTENANCE_POOL_SIZE }),
  };
  const closeMaintenanceStores = async (): Promise<void> => {
    try {
      await maintenanceStores.rateLimit.close();
    } finally {
      try {
        await maintenanceStores.retention.close();
      } finally {
        await maintenanceStores.workspaceDeletion.close();
      }
    }
  };
  const context: ModuleContext = Object.freeze({
    config,
    logger,
    adapters: Object.freeze({ ...options.adapters }),
    withTenant: metrics.instrumentTenant(database.withTenant.bind(database)),
  });

  // Every failed attempt is reported under the job's name; a failing reporter never changes the job's outcome.
  const reportFailure = async (error: unknown, jobName: string): Promise<void> => {
    try {
      await options.adapters.errors.capture(error, { route: jobName });
    } catch (reportError) {
      logger.warn("Error report failed", { job: jobName, ...errorFields(reportError) });
    }
  };

  let composition: Composition;
  try {
    // The event jobs read the subscribers when a job runs, which is after `composition` is assigned.
    const subscribersFor = (name: DomainEventName): readonly RegisteredSubscriber[] => subscribersOf(composition.subscribers, name);
    composition = compose([...createBuiltInModules(maintenanceStores, subscribersFor), ...options.modules], context, []);
  } catch (error) {
    void database.close();
    void closeMaintenanceStores();
    throw error;
  }

  return {
    jobs: composition.jobs,
    schedules: composition.schedules,

    async start(startOptions = {}) {
      // pg-boss always connects with DATABASE_URL, so that role is checked whether or not a tenant pool
      // was passed in (the server skips the check in that case). The role of a passed-in pool is the
      // composer's responsibility.
      if (config.NODE_ENV === "production") {
        try {
          await assertApplicationRole({
            url: config.DATABASE_URL,
            allowOwnerConnection: config.SLUGBASE_ALLOW_OWNER_CONNECTION,
            logger,
          });
        } catch (error) {
          await database.close();
          await closeMaintenanceStores();
          throw error;
        }
      }
      const boss = new PgBoss({
        connectionString: config.DATABASE_URL,
        schema: BOSS_SCHEMA,
        max: poolSize,
        application_name: APPLICATION_NAME,
        migrate: false,
        createSchema: false,
        reindex: false,
      });
      boss.on("error", (error) => {
        logger.error("pg-boss reported an error", errorFields(error));
      });
      boss.on("warning", (warning) => {
        logger.warn("pg-boss reported a warning", { message: warning.message });
      });

      let metricsListener: MetricsListener | undefined;
      let stopped: Promise<void> | undefined;
      const stop = async (): Promise<void> => {
        try {
          await metricsListener?.close();
          await boss.stop({ graceful: true, close: true, timeout: shutdownTimeoutMs });
        } finally {
          try {
            await database.close();
          } finally {
            await closeMaintenanceStores();
          }
        }
      };
      const shutdown = (): Promise<void> => (stopped ??= stop());

      try {
        await boss.start();
        for (const job of composition.jobs) {
          const queue = queueSettings(job);
          // `migrate` already created the queues of the built-in and the modules' jobs. createQueue leaves an
          // existing queue alone, so a changed policy is applied by updateQueue.
          await boss.createQueue(job.name, queue);
          await boss.updateQueue(job.name, queue);
          await boss.work<JobPayload>(
            job.name,
            { batchSize: 1, ...(options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds }) },
            async ([pending]) => {
              if (pending === undefined) {
                return;
              }
              try {
                await job.handle(pending.data, context);
              } catch (error) {
                logger.error("Job failed", { job: job.name, id: pending.id, attempt: pending.retryCount + 1, ...errorFields(error) });
                await reportFailure(error, job.name);
                throw error;
              }
            },
          );
        }
        for (const schedule of composition.schedules) {
          await boss.schedule(schedule.job, schedule.cron, schedule.payload ?? {}, { key: schedule.name });
        }

        metrics.observeJobQueues(async () => {
          const snapshots = await Promise.all(
            composition.jobs.map(async (job): Promise<QueueSnapshot | undefined> => {
              const stats = (await boss.getQueueStats(job.name, { force: true })).at(0);
              return stats === undefined
                ? undefined
                : {
                    queue: job.name,
                    deferred: stats.deferredCount,
                    ready: stats.readyCount,
                    active: stats.activeCount,
                    oldestReadySeconds: stats.readyOldestSeconds,
                  };
            }),
          );
          return snapshots.filter((snapshot) => snapshot !== undefined);
        });
        const metricsRequested = startOptions.metricsPort ?? config.METRICS_PORT;
        if (metricsRequested !== undefined) {
          metricsListener = await startMetricsListener({ metrics, port: metricsRequested, logger });
        }
      } catch (error) {
        await shutdown().catch((cleanup: unknown) => {
          logger.error("Cleanup after a failed start failed", errorFields(cleanup));
        });
        throw error;
      }

      logger.info("Worker started", { jobs: composition.jobs.length, schedules: composition.schedules.length });
      return {
        ...(metricsListener === undefined ? {} : { metricsPort: metricsListener.port }),
        enqueue: async (job, payload) => boss.send(job.name, job.parse(payload)),
        shutdown,
      };
    },
  };
}
