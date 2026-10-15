import type { QueueOptions } from "pg-boss";
import type { JobDefinition } from "./job.ts";

/**
 * How long pg-boss keeps a finished job, completed or failed, before its
 * maintenance deletes it (doc 05 section 6). It is one setting per queue, so a
 * failed job is kept as long as a completed one.
 */
export const FINISHED_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * The settings of a job's queue, from the job's retry policy. The worker applies
 * them to the queues it registers and `migrate` creates the queues with them,
 * so a queue is the same whichever process made it.
 */
export function queueSettings(job: JobDefinition): QueueOptions {
  return {
    retryLimit: job.retry.limit,
    retryDelay: job.retry.delaySeconds,
    retryBackoff: job.retry.backoff,
    deleteAfterSeconds: FINISHED_JOB_RETENTION_SECONDS,
    ...(job.retry.maxDelaySeconds === undefined ? {} : { retryDelayMax: job.retry.maxDelaySeconds }),
  };
}
