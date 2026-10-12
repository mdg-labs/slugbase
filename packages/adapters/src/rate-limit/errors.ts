/** Why a consume call could not be decided: refused before it reached the store, or answered by the store with values no bucket can hold. Carries nothing of the request. */
export type RateLimitErrorReason = "unknown_bucket" | "invalid_request" | "invalid_store_answer";

/**
 * The rate limiter could not decide. Callers treat it as a failure of the
 * limiter's storage (doc 01 section 4 step 6): the request answers `503`, never
 * goes through unthrottled.
 */
export class RateLimitError extends Error {
  readonly reason: RateLimitErrorReason;

  constructor(reason: RateLimitErrorReason) {
    super(`the rate limiter refused the request: ${reason}`);
    this.name = "RateLimitError";
    this.reason = reason;
  }
}
