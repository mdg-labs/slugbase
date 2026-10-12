import { isDeepStrictEqual } from "node:util";
import type { ModuleContext } from "../create-server.ts";
import type { JobDefinition, JobPayload } from "./job.ts";

export interface IdempotencyCheck<Payload extends JobPayload> {
  readonly job: JobDefinition<Payload>;
  readonly payload: Payload;
  readonly context: ModuleContext;
  /** Reads everything the job writes, as plain comparable data. */
  readonly state: () => Promise<unknown>;
}

/** The job left a different state when it ran a second time with the same payload. */
export class NotIdempotentError extends Error {
  constructor(job: string) {
    super(`job ${job} left a different state when it ran twice with one payload`);
    this.name = "NotIdempotentError";
  }
}

/**
 * The check every job's tests run (doc 01 section 3 rule 4): the job runs
 * twice with the same payload, as when a queue delivers it twice, and the state
 * after the second run must equal the state after the first. A second run that
 * throws fails the check too.
 */
export async function assertIdempotent<Payload extends JobPayload>(check: IdempotencyCheck<Payload>): Promise<void> {
  await check.job.handle(check.payload, check.context);
  const afterFirst = await check.state();
  await check.job.handle(check.payload, check.context);
  const afterSecond = await check.state();
  if (!isDeepStrictEqual(afterFirst, afterSecond)) {
    throw new NotIdempotentError(check.job.name);
  }
}
