import type { Adapters } from "@slugbase/core";
import { createDatabase, type Database } from "@slugbase/db";
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
import type { JobDefinition, JobPayload, ScheduleDefinition } from "./job.ts";

export const DEFAULT_WORKER_POOL_SIZE = 5;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
const BOSS_SCHEMA = "pgboss";
const APPLICATION_NAME = "slugbase-worker";

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

export interface RunningWorker {
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
  /** Starts pg-boss, registers every job's queue and consumer and every schedule. */
  start(): Promise<RunningWorker>;
}

function errorFields(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.name : typeof error,
    code: (error as { code?: unknown } | null)?.code,
  };
}

/**
 * The worker process (doc 01 section 3): pg-boss as `slugbase_app` with the
 * modules' jobs as consumers and their schedules as pg-boss schedules. It never
 * installs or migrates the pg-boss schema; `migrate` does (doc 05 section 5.5).
 * It fails before connecting when a port has no adapter or the modules conflict.
 */
export function createWorker(options: CreateWorkerOptions): Worker {
  const { config, logger } = options;
  assertAdapters(options.adapters);
  const poolSize = options.poolSize ?? DEFAULT_WORKER_POOL_SIZE;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const database = options.database ?? createDatabase({ url: config.DATABASE_URL, poolSize });
  const context: ModuleContext = Object.freeze({
    config,
    logger,
    adapters: Object.freeze({ ...options.adapters }),
    withTenant: database.withTenant.bind(database),
  });

  let composition: Composition;
  try {
    composition = compose(options.modules, context, []);
  } catch (error) {
    void database.close();
    throw error;
  }

  return {
    jobs: composition.jobs,
    schedules: composition.schedules,

    async start() {
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

      let stopped: Promise<void> | undefined;
      const stop = async (): Promise<void> => {
        try {
          await boss.stop({ graceful: true, close: true, timeout: shutdownTimeoutMs });
        } finally {
          await database.close();
        }
      };
      const shutdown = (): Promise<void> => (stopped ??= stop());

      try {
        await boss.start();
        for (const job of composition.jobs) {
          const queue = {
            retryLimit: job.retry.limit,
            retryDelay: job.retry.delaySeconds,
            retryBackoff: job.retry.backoff,
            ...(job.retry.maxDelaySeconds === undefined ? {} : { retryDelayMax: job.retry.maxDelaySeconds }),
          };
          await boss.createQueue(job.name, queue);
          // createQueue leaves an existing queue alone, so a changed policy is applied here.
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
                throw error;
              }
            },
          );
        }
        for (const schedule of composition.schedules) {
          await boss.schedule(schedule.job, schedule.cron, schedule.payload ?? {}, { key: schedule.name });
        }
      } catch (error) {
        await shutdown().catch((cleanup: unknown) => {
          logger.error("Cleanup after a failed start failed", errorFields(cleanup));
        });
        throw error;
      }

      logger.info("Worker started", { jobs: composition.jobs.length, schedules: composition.schedules.length });
      return {
        enqueue: async (job, payload) => boss.send(job.name, job.parse(payload)),
        shutdown,
      };
    },
  };
}
