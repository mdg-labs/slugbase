import type { Port } from "./port.js";

export interface RateLimitRequest {
  /** The bucket the operation names in its contract. */
  readonly bucket: string;
  /** What the bucket is keyed by: an IP, a principal or a route. */
  readonly key: string;
  readonly cost?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/** Token buckets keyed by IP, principal and route (doc 01 section 6). */
export interface RateLimitPort extends Port {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}
