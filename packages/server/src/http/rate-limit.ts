import type { ErrorReportPort, RateLimitPort } from "@slugbase/core";
import type { Logger } from "../create-server.ts";
import type { RateLimitRegistry, RateLimitWindow, ScopeLimit } from "../config/index.ts";
import type { ChainContext, RequestStage } from "./chain.ts";
import { ProblemError, describeError, problemDocument, requestIdOf } from "./problem.ts";
import { rateLimitKeyOf } from "./trusted-proxy.ts";

// Stages 3a and 6 of the chain (doc 01 section 4, doc 04 section 7, doc 10 T9):
// token buckets keyed by the bucket the operation declares in
// `x-slugbase-rate`. A request takes one token from the bucket of its client IP
// before it is authenticated (stage 3a), so a flood of unauthenticated or
// bad-credential requests is throttled before any credential lookup. Once it is
// authenticated it takes one from the buckets of its account and, for a bucket
// that has one, its workspace (stage 6); whichever is empty first denies it. The
// IP is the one the request-context stage derived across the trusted proxy
// hops, never a header read here; its bucket key is the IPv4 address, or the /64
// of an IPv6 one (`rateLimitKeyOf`). An operation that declares `none`, a
// `machine` route and a request that matches no operation are not limited by
// these stages.
//
// A limiter that cannot decide never lets a request through: a failure of its
// storage, an unconfigured port or a bucket the registry does not know answers
// `503 unavailable`, so a credential endpoint is not left unthrottled.

const FAILED_DETAIL = "The service is temporarily unavailable.";
const DENIED_DETAIL = "Too many requests. Try again later.";

// A request without a socket address (an in-process call) shares one bucket.
const UNKNOWN_CLIENT = "unknown";

/** What a request took from one bucket, for the `RateLimit` headers. */
export interface TakenLimit {
  readonly name: string;
  readonly window: RateLimitWindow;
  readonly limit: number;
  readonly remaining: number;
}

/** What the stage took from the buckets of the request, kept on the request context until the response is final. */
export interface RateLimitState {
  readonly taken: readonly TakenLimit[];
  /** Set when a bucket denied the request: the seconds until it holds a token again. */
  readonly retryAfterSeconds?: number;
}

export interface RateLimiting {
  /** Stage 3a: the per-IP take, before authentication. */
  readonly ipStage: RequestStage;
  /** Stage 6: the per-account and per-workspace takes, after authentication. */
  readonly stage: RequestStage;
  /** Sets the `RateLimit-Policy` and `RateLimit` headers on `context.res`; nothing happens for a request the stage did not limit. */
  apply(context: ChainContext): void;
}

export interface RateLimitingOptions {
  readonly limiter: RateLimitPort;
  readonly registry: RateLimitRegistry;
  readonly logger: Logger;
  readonly errors: ErrorReportPort;
  /** Counts a refusal under its bucket. */
  readonly recordRejection?: (bucket: string) => void;
}

function windowSeconds(window: RateLimitWindow): number {
  return Math.round(window.capacity / window.refillPerSecond);
}

function secondsToFull(taken: TakenLimit): number {
  return taken.remaining >= taken.limit ? 0 : Math.ceil((taken.limit - taken.remaining) / taken.window.refillPerSecond);
}

function headersOf(state: RateLimitState): Record<string, string> {
  const headers: Record<string, string> = {
    "ratelimit-policy": state.taken.map((taken) => `"${taken.name}";q=${String(taken.limit)};w=${String(windowSeconds(taken.window))}`).join(", "),
    ratelimit: state.taken.map((taken) => `"${taken.name}";r=${String(taken.remaining)};t=${String(secondsToFull(taken))}`).join(", "),
  };
  if (state.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(state.retryAfterSeconds);
  }
  return headers;
}

export function createRateLimiting({ limiter, registry, logger, errors, recordRejection }: RateLimitingOptions): RateLimiting {
  const failure = (context: ChainContext, bucket: string, error: unknown): ProblemError => {
    const requestId = requestIdOf(context);
    (context.get("logger") ?? logger).error("Rate limiter failed", { ...describeError(error), bucket, requestId });
    void Promise.resolve()
      .then(() => errors.capture(error, { requestId }))
      .catch((reportError: unknown) => {
        logger.warn("Error report failed", { ...describeError(reportError), requestId });
      });
    return new ProblemError("unavailable", FAILED_DETAIL);
  };

  const subjectOf = (context: ChainContext, limit: ScopeLimit): string | undefined => {
    const principal = context.get("principal");
    switch (limit.scope) {
      case "ip":
        return rateLimitKeyOf(context.get("clientIp") ?? UNKNOWN_CLIENT);
      case "account":
        return principal?.accountId;
      case "workspace":
        return principal?.kind === "api-token" ? principal.workspaceId : principal?.activeWorkspaceId;
      case "email":
        // Counted by the operation that takes the address.
        return undefined;
    }
  };

  // Takes one token from each of the bucket's limits that `include` selects, in
  // the registry's order, and answers the refusal of the first one that is empty.
  const take = async (context: ChainContext, include: (limit: ScopeLimit) => boolean): Promise<Response | undefined> => {
    const operation = context.get("route")?.operation;
    if (operation === undefined || operation.rate === "none" || operation.audience === "machine") {
      return undefined;
    }
    const bucket = operation.rate;
    const limits = registry.scopesOf(bucket);
    if (limits === undefined) {
      throw failure(context, bucket, new Error("the bucket is not in the registry"));
    }

    const taken: TakenLimit[] = [...(context.get("rateLimit")?.taken ?? [])];
    for (const limit of limits.filter(include)) {
      const key = subjectOf(context, limit);
      const window = registry.window(limit.name);
      if (key === undefined) {
        continue;
      }
      if (window === undefined) {
        throw failure(context, bucket, new Error("the limit is not in the registry"));
      }
      let decision;
      try {
        decision = await limiter.consume({ bucket: limit.name, key });
      } catch (error) {
        throw failure(context, bucket, error);
      }
      taken.push({ name: limit.name, window, limit: decision.limit, remaining: decision.remaining });
      if (!decision.allowed) {
        const state: RateLimitState = { taken, retryAfterSeconds: decision.retryAfterSeconds };
        context.set("rateLimit", state);
        recordRejection?.(bucket);
        const response = problemDocument(requestIdOf(context), { code: "rate_limited", detail: DENIED_DETAIL });
        for (const [name, value] of Object.entries(headersOf(state))) {
          response.headers.set(name, value);
        }
        return response;
      }
    }
    if (taken.length > 0) {
      context.set("rateLimit", { taken });
    }
    return undefined;
  };

  const ipStage: RequestStage = async (context, next) => {
    const refusal = await take(context, (limit) => limit.scope === "ip");
    return refusal ?? next();
  };

  const stage: RequestStage = async (context, next) => {
    const refusal = await take(context, (limit) => limit.scope !== "ip");
    return refusal ?? next();
  };

  const apply = (context: ChainContext): void => {
    const state = context.get("rateLimit");
    if (state === undefined) {
      return;
    }
    const response = context.res;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(headersOf(state))) {
      headers.set(name, value);
    }
    context.res = undefined;
    context.res = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };

  return { ipStage, stage, apply };
}
