import type { ErrorReportPort, RateLimitPort } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { createTokenRedeemLimit } from "../../src/auth/token-redeem-limit.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import type { ChainContext } from "../../src/http/chain.ts";
import { ProblemError } from "../../src/http/problem.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { recordingLogger, serverConfig } from "../support.ts";

// The `token_redeem` limits taken for an operation that does not declare that bucket (doc 04 section 7, doc 10
// T9): a refusal is counted under its bucket like the rate-limit stage counts one, and a limiter that cannot
// decide is reported like the stage reports it, while the answer stays 429 or 503.

const REQUEST_ID = "req-1";

function contextOf(): ChainContext {
  const values = new Map<string, unknown>([
    ["requestId", REQUEST_ID],
    ["clientIp", "203.0.113.7"],
  ]);
  return { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) } as unknown as ChainContext;
}

function build(options: { readonly env?: Record<string, string>; readonly limiter?: Pick<RateLimitPort, "consume">; readonly errors?: ErrorReportPort } = {}) {
  const registry = createRateLimitRegistry(serverConfig(options.env));
  const logger = recordingLogger();
  const captured: { readonly error: unknown; readonly requestId: string | undefined }[] = [];
  const rejections: string[] = [];
  const errors: ErrorReportPort = options.errors ?? {
    available: true,
    capture: (error, report) => {
      captured.push({ error, requestId: report?.requestId });
      return Promise.resolve();
    },
  };
  const take = createTokenRedeemLimit({
    limiter: options.limiter ?? memoryRateLimiter(registry),
    registry,
    logger,
    errors,
    recordRejection: (bucket) => {
      rejections.push(bucket);
    },
  });
  return { take, logger, captured, rejections };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function refusal(promise: Promise<void>): Promise<ProblemError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ProblemError);
  return error as ProblemError;
}

describe("the token_redeem limits of a provider sign-in", () => {
  it("counts a refusal under the token_redeem bucket once and answers 429 rate_limited", async () => {
    const { take, rejections } = build({ env: { RATE_LIMIT_TOKEN_REDEEM_IP: "1/hour" } });
    await take(contextOf(), undefined);
    expect(rejections).toEqual([]);

    const denied = await refusal(take(contextOf(), undefined));
    expect(denied.code).toBe("rate_limited");
    expect(rejections).toEqual(["token_redeem"]);
  });

  it("reports a limiter that fails with the request ID and answers 503 unavailable", async () => {
    const failure = new Error("storage down");
    const { take, captured, logger, rejections } = build({ limiter: { consume: () => Promise.reject(failure) } });

    const unavailable = await refusal(take(contextOf(), undefined));
    await settle();

    expect(unavailable.code).toBe("unavailable");
    expect(captured).toEqual([{ error: failure, requestId: REQUEST_ID }]);
    expect(logger.entries.some((entry) => entry.level === "error" && entry.message === "Rate limiter failed" && entry.fields.bucket === "token_redeem")).toBe(true);
    expect(rejections).toEqual([]);
  });

  it("still answers 503 unavailable and logs the failure when the report itself fails", async () => {
    const { take, logger } = build({
      limiter: { consume: () => Promise.reject(new Error("storage down")) },
      errors: { available: true, capture: () => Promise.reject(new Error("sink down")) },
    });

    const unavailable = await refusal(take(contextOf(), undefined));
    await settle();

    expect(unavailable.code).toBe("unavailable");
    expect(logger.entries.some((entry) => entry.level === "warn" && entry.message === "Error report failed")).toBe(true);
  });
});
