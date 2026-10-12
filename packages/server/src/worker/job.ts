import { z } from "zod";
import type { ModuleContext } from "../create-server.ts";

/** What a job payload may hold: scalar identifiers and flags, never a document (doc 05 section 2.10). */
export type JobScalar = string | number | boolean | null | undefined;

export type JobPayload = Readonly<Record<string, JobScalar>>;

/** How often and how fast a failed job runs again before it ends failed. */
export interface RetryPolicy {
  /** Retries after the first attempt; the job runs `limit + 1` times at most. */
  readonly limit?: number;
  /** Seconds before the first retry. */
  readonly delaySeconds?: number;
  /** Doubles the delay with every retry, with jitter. */
  readonly backoff?: boolean;
  /** Upper bound of the delay in seconds; only with `backoff`. */
  readonly maxDelaySeconds?: number;
}

export interface ResolvedRetryPolicy {
  readonly limit: number;
  readonly delaySeconds: number;
  readonly backoff: boolean;
  readonly maxDelaySeconds: number | undefined;
}

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  limit: 3,
  delaySeconds: 10,
  backoff: true,
  maxDelaySeconds: undefined,
};

/** A background job: a name, the payload it accepts and the handler that runs it. */
export interface JobDefinition<Payload extends JobPayload = JobPayload> {
  readonly name: string;
  readonly retry: ResolvedRetryPolicy;
  /** The payload as the schema accepts it; throws when it does not. */
  parse(payload: unknown): Payload;
  /** Validates the payload, then runs the handler. Every job is idempotent (doc 01 section 3 rule 4). */
  handle(payload: unknown, context: ModuleContext): Promise<void>;
}

export interface DefineJobOptions<Shape extends z.ZodRawShape> {
  /** A dotted name such as `mail.send`: it names the pg-boss queue. */
  readonly name: string;
  /** An object of scalar fields; a field that is an object, array or record is refused. */
  readonly payload: z.ZodObject<Shape>;
  /** Must leave the same state whether it runs once or several times for one payload. */
  readonly handle: (payload: z.infer<z.ZodObject<Shape>>, context: ModuleContext) => Promise<void>;
  readonly retry?: RetryPolicy;
}

/** A schedule: the named job runs on the cron expression, once across all workers. */
export interface ScheduleDefinition {
  readonly name: string;
  readonly cron: string;
  readonly job: string;
  /** The payload each run carries; empty when the job takes none. */
  readonly payload?: JobPayload;
}

export class JobDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobDefinitionError";
  }
}

const JOB_NAME = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const SCHEDULE_NAME = /^[a-z][a-zA-Z0-9]*(?:[.-][a-z][a-zA-Z0-9]*)*$/;
const MAX_RETRY_LIMIT = 100;

interface SchemaDefinition {
  readonly type: string;
  readonly innerType?: z.core.$ZodType;
}

function isScalar(schema: z.core.$ZodType): boolean {
  const definition = schema._zod.def as SchemaDefinition;
  switch (definition.type) {
    case "string":
    case "number":
    case "boolean":
    case "enum":
    case "literal":
      return true;
    case "optional":
    case "nullable":
    case "default":
      return definition.innerType !== undefined && isScalar(definition.innerType);
    default:
      return false;
  }
}

function resolveRetry(name: string, retry: RetryPolicy | undefined): ResolvedRetryPolicy {
  const resolved: ResolvedRetryPolicy = {
    limit: retry?.limit ?? DEFAULT_RETRY_POLICY.limit,
    delaySeconds: retry?.delaySeconds ?? DEFAULT_RETRY_POLICY.delaySeconds,
    backoff: retry?.backoff ?? DEFAULT_RETRY_POLICY.backoff,
    maxDelaySeconds: retry?.maxDelaySeconds,
  };
  if (!Number.isInteger(resolved.limit) || resolved.limit < 0 || resolved.limit > MAX_RETRY_LIMIT) {
    throw new JobDefinitionError(`job ${name}: retry limit must be an integer from 0 to ${String(MAX_RETRY_LIMIT)}`);
  }
  if (!Number.isInteger(resolved.delaySeconds) || resolved.delaySeconds < 0) {
    throw new JobDefinitionError(`job ${name}: retry delay must be a whole number of seconds`);
  }
  if (resolved.maxDelaySeconds !== undefined) {
    if (!resolved.backoff) {
      throw new JobDefinitionError(`job ${name}: a maximum delay needs backoff`);
    }
    if (!Number.isInteger(resolved.maxDelaySeconds) || resolved.maxDelaySeconds < resolved.delaySeconds) {
      throw new JobDefinitionError(`job ${name}: the maximum delay must be a whole number of seconds, not below the delay`);
    }
  }
  return resolved;
}

/**
 * Declares a job. The payload schema is limited to scalar fields because a
 * payload carries identifiers and the handler re-reads current state; the
 * schema is strict, so a payload with any other key is refused.
 */
export function defineJob<const Shape extends z.ZodRawShape>(options: DefineJobOptions<Shape>): JobDefinition<z.infer<z.ZodObject<Shape>> & JobPayload> {
  const { name } = options;
  if (!JOB_NAME.test(name)) {
    throw new JobDefinitionError(`job name "${name}" must be dotted lower camel case such as mail.send`);
  }
  for (const [field, schema] of Object.entries(options.payload.shape)) {
    if (!isScalar(schema)) {
      throw new JobDefinitionError(`job ${name}: payload field ${field} must be a string, number, boolean, enum or literal`);
    }
  }
  const schema = z.strictObject(options.payload.shape);
  const retry = resolveRetry(name, options.retry);
  type Payload = z.infer<z.ZodObject<Shape>> & JobPayload;

  const parse = (payload: unknown): Payload => schema.parse(payload) as Payload;
  return {
    name,
    retry,
    parse,
    handle: async (payload, context) => options.handle(parse(payload), context),
  };
}

/** Declares a schedule for a job (doc 01 section 8.1). */
export function defineSchedule(options: ScheduleDefinition): ScheduleDefinition {
  if (!SCHEDULE_NAME.test(options.name)) {
    throw new JobDefinitionError(`schedule name "${options.name}" must be lower camel case words joined by dots or hyphens`);
  }
  const fields = options.cron.trim().split(/\s+/).length;
  if (fields !== 5 && fields !== 6) {
    throw new JobDefinitionError(`schedule ${options.name}: the cron expression needs five fields, or six with a seconds field`);
  }
  return options;
}
