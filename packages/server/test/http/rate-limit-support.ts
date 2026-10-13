import type { RateLimitDecision, RateLimitPort, RateLimitRequest } from "@slugbase/core";
import type { RateLimitRegistry } from "../../src/config/index.ts";

export interface MemoryRateLimiter extends RateLimitPort {
  /** Every take, in order. */
  readonly takes: { readonly bucket: string; readonly key: string }[];
  /** Moves the clock the buckets refill by. */
  advance(seconds: number): void;
}

/**
 * Token buckets in memory with the arithmetic of the Postgres adapter: a bucket
 * starts full, refills at the window's rate and refuses a take it cannot cover.
 * A name the registry does not know rejects, as the adapter does.
 */
export function memoryRateLimiter(registry: RateLimitRegistry): MemoryRateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const takes: { bucket: string; key: string }[] = [];
  let now = 0;
  return {
    available: true,
    takes,
    advance(seconds) {
      now += seconds;
    },
    consume(request: RateLimitRequest): Promise<RateLimitDecision> {
      const window = registry.window(request.bucket);
      if (window === undefined) {
        return Promise.reject(new Error("unknown bucket"));
      }
      takes.push({ bucket: request.bucket, key: request.key });
      const id = `${request.bucket}\u0000${request.key}`;
      const held = buckets.get(id) ?? { tokens: window.capacity, at: now };
      const tokens = Math.min(window.capacity, held.tokens + (now - held.at) * window.refillPerSecond);
      const cost = request.cost ?? 1;
      const allowed = tokens >= cost;
      const left = allowed ? tokens - cost : tokens;
      buckets.set(id, { tokens: left, at: now });
      return Promise.resolve({
        allowed,
        limit: window.capacity,
        remaining: Math.floor(left),
        retryAfterSeconds: allowed ? 0 : Math.ceil((cost - left) / window.refillPerSecond),
      });
    },
  };
}
