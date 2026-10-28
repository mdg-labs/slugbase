import type { Queue, QueueOptions, UpdateQueueOptions } from "pg-boss";
import type { JobDefinition } from "./job.ts";

/**
 * How long pg-boss keeps a finished job, completed or failed, before its
 * maintenance deletes it (doc 05 section 6). It is one setting per queue, so a
 * failed job is kept as long as a completed one.
 */
export const FINISHED_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The settings of a job's queue that follow its retry policy; the ones the worker may change on a queue that exists. */
function followingRetryPolicy(job: JobDefinition): QueueOptions {
  return {
    retryLimit: job.retry.limit,
    retryDelay: job.retry.delaySeconds,
    retryBackoff: job.retry.backoff,
    deleteAfterSeconds: FINISHED_JOB_RETENTION_SECONDS,
    ...(job.retry.maxDelaySeconds === undefined ? {} : { retryDelayMax: job.retry.maxDelaySeconds }),
  };
}

/**
 * The settings of a job's queue, from the job's retry policy and its `dedupe`. The worker applies
 * them to the queues it registers and `migrate` creates the queues with them,
 * so a queue is the same whichever process made it.
 */
export function queueSettings(job: JobDefinition): Omit<Queue, "name"> {
  return { ...(job.dedupe ? { policy: "short" as const } : {}), ...followingRetryPolicy(job) };
}

/**
 * The settings of an existing queue that the worker may change. pg-boss refuses a change of policy, so the policy is the one setting a queue
 * keeps from the call of `migrate` that created it.
 */
export function queueUpdates(job: JobDefinition): UpdateQueueOptions {
  return followingRetryPolicy(job);
}
