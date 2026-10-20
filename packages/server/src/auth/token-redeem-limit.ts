import type { ErrorReportPort, RateLimitPort } from "@slugbase/core";
import type { RateLimitRegistry } from "../config/index.ts";
import type { Logger } from "../create-server.ts";
import type { ChainContext } from "../http/chain.ts";
import { ProblemError } from "../http/problem.ts";
import { limiterFailure, type TakenLimit } from "../http/rate-limit.ts";
import { rateLimitKeyOf } from "../http/trusted-proxy.ts";

// The `token_redeem` limits (doc 04 section 7, doc 10 T9) for an operation that does not declare that bucket: the
// start of a provider sign-in that carries an invitation token declares `login`, and redeems the token all the same.
// It takes one token from the bucket's per-address limit, and from its per-account limit when the browser holds a
// complete session, so redeeming invitation tokens through a provider is limited as redeeming them through the
// invitation operations is. A limiter that cannot decide never lets the request through.

const BUCKET = "token_redeem";
const DENIED_DETAIL = "Too many requests. Try again later.";
const UNKNOWN_CLIENT = "unknown";

/** Takes one redemption from the limits of the client address and, with `accountId`, of that account. Throws `429 rate_limited` or `503 unavailable`. */
export type TakeTokenRedeemLimit = (context: ChainContext, accountId: string | undefined) => Promise<void>;

export interface TokenRedeemLimitOptions {
  readonly limiter: Pick<RateLimitPort, "consume">;
  readonly registry: RateLimitRegistry;
  readonly logger: Logger;
  readonly errors: ErrorReportPort;
  /** Counts a refusal under its bucket. */
  readonly recordRejection?: (bucket: string) => void;
}

export function createTokenRedeemLimit({ limiter, registry, logger, errors, recordRejection }: TokenRedeemLimitOptions): TakeTokenRedeemLimit {
  return async (context, accountId) => {
    const unavailable = (error: unknown): ProblemError => limiterFailure({ logger, errors }, context, BUCKET, error);
    const limits = registry.scopesOf(BUCKET);
    if (limits === undefined) {
      throw unavailable(new Error("the bucket is not in the registry"));
    }
    const taken: TakenLimit[] = [...(context.get("rateLimit")?.taken ?? [])];
    for (const limit of limits) {
      let key: string;
      if (limit.scope === "ip") {
        key = rateLimitKeyOf(context.get("clientIp") ?? UNKNOWN_CLIENT);
      } else if (limit.scope === "account" && accountId !== undefined) {
        key = accountId;
      } else {
        continue;
      }
      const window = registry.window(limit.name);
      if (window === undefined) {
        throw unavailable(new Error("the limit is not in the registry"));
      }
      let decision;
      try {
        decision = await limiter.consume({ bucket: limit.name, key });
      } catch (error) {
        throw unavailable(error);
      }
      taken.push({ name: limit.name, window, limit: decision.limit, remaining: decision.remaining });
      if (!decision.allowed) {
        context.set("rateLimit", { taken, retryAfterSeconds: decision.retryAfterSeconds });
        recordRejection?.(BUCKET);
        throw new ProblemError("rate_limited", DENIED_DETAIL);
      }
    }
    if (taken.length > 0) {
      context.set("rateLimit", { taken });
    }
  };
}
