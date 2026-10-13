import { createHash } from "node:crypto";
import type { RateLimitDecision, RateLimitPort, RateLimitRequest } from "@slugbase/core";
import type { RateLimitStore } from "@slugbase/db";
import { RateLimitError } from "./errors.ts";

/** What a bucket holds and how fast it refills: `capacity` tokens at most, `refillPerSecond` new ones every second. */
export interface BucketLimit {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface CreateRateLimiterOptions {
  /** The store the tokens live in: the system operation of `@slugbase/db`. */
  readonly store: Pick<RateLimitStore, "take">;
  /** The limit of a bucket by the name an operation's contract gives it, or `undefined` for a name that is no bucket. */
  readonly limits: (bucket: string) => BucketLimit | undefined;
}

// The table stores tokens as a 4-byte real, which can round a balance a hair
// above the capacity it was computed against.
const REAL_PRECISION = 1 + 1e-6;

// The storage key is the bucket and a hash of what the bucket is keyed by, so the
// table never holds an IP address or an account id (doc 05 section 2.10), and the
// key has a fixed length whatever the caller passes.
function storageKey(bucket: string, key: string): string {
  return `${bucket}:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * The rate-limit port over Postgres token buckets (doc 01 section 8.2). Each
 * `consume` is one `sys_rate_limit_take` call, which takes the tokens in a
 * single statement, so concurrent callers cannot spend the same token. A bucket
 * with no limit, a malformed request and a store that fails all reject:
 * a limiter that cannot decide never allows.
 */
export function createRateLimiter(options: CreateRateLimiterOptions): RateLimitPort {
  return {
    available: true,
    async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
      const cost = request.cost ?? 1;
      if (request.key === "" || !Number.isFinite(cost) || cost <= 0) {
        throw new RateLimitError("invalid_request");
      }
      const limit = options.limits(request.bucket);
      if (limit === undefined) {
        throw new RateLimitError("unknown_bucket");
      }
      const taken = await options.store.take({
        key: storageKey(request.bucket, request.key),
        capacity: limit.capacity,
        refillPerSecond: limit.refillPerSecond,
        cost,
      });
      // A refused take owes the caller a wait above 0, and no bucket holds more
      // than its capacity: any other answer is a fault of the store, and it must
      // not reach a Retry-After header.
      const wellFormed =
        Number.isFinite(taken.remaining) &&
        taken.remaining >= 0 &&
        taken.remaining <= limit.capacity * REAL_PRECISION &&
        Number.isFinite(taken.retryAfterSeconds) &&
        (taken.allowed || taken.retryAfterSeconds > 0);
      if (!wellFormed) {
        throw new RateLimitError("invalid_store_answer");
      }
      return {
        allowed: taken.allowed,
        limit: limit.capacity,
        remaining: Math.max(0, Math.floor(taken.remaining)),
        retryAfterSeconds: taken.allowed ? 0 : Math.ceil(taken.retryAfterSeconds),
      };
    },
  };
}
