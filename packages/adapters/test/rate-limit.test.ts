import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RateLimitStore, RateLimitTake, RateLimitTaken } from "@slugbase/db";
import { RateLimitError, createRateLimiter } from "../src/index.ts";

const LIMITS = { login: { capacity: 10, refillPerSecond: 10 / 60 } };

function fakeStore(answer: (take: RateLimitTake) => RateLimitTaken | Error) {
  const takes: RateLimitTake[] = [];
  const store: Pick<RateLimitStore, "take"> = {
    take(request) {
      takes.push(request);
      const result = answer(request);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { store, takes };
}

const allowed: RateLimitTaken = { allowed: true, remaining: 6.7, retryAfterSeconds: 0 };
const refused: RateLimitTaken = { allowed: false, remaining: 0.4, retryAfterSeconds: 3.2 };

function limiter(answer: (take: RateLimitTake) => RateLimitTaken | Error = () => allowed) {
  const { store, takes } = fakeStore(answer);
  const port = createRateLimiter({ store, limits: (bucket) => (bucket === "login" ? LIMITS.login : undefined) });
  return { port, takes };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe("createRateLimiter", () => {
  it("is an available port that takes one token by default and reports the limit of the bucket", async () => {
    const { port, takes } = limiter();
    expect(port.available).toBe(true);
    const decision = await port.consume({ bucket: "login", key: "203.0.113.7" });
    expect(decision).toEqual({ allowed: true, limit: 10, remaining: 6, retryAfterSeconds: 0 });
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ capacity: 10, refillPerSecond: 10 / 60, cost: 1 });
  });

  it("passes the cost on", async () => {
    const { port, takes } = limiter();
    await port.consume({ bucket: "login", key: "k", cost: 3 });
    expect(takes[0]?.cost).toBe(3);
  });

  it("answers a refused take with whole seconds to wait, rounded up, and never fewer than the store says", async () => {
    const { port } = limiter(() => refused);
    expect(await port.consume({ bucket: "login", key: "k" })).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 4,
    });
  });

  it("keys the bucket by its name and a hash of the key, never by the key itself", async () => {
    const { port, takes } = limiter();
    await port.consume({ bucket: "login", key: "203.0.113.7" });
    await port.consume({ bucket: "login", key: "203.0.113.8" });
    const digest = createHash("sha256").update("203.0.113.7").digest("hex");
    expect(takes[0]?.key).toBe(`login:${digest}`);
    expect(takes[1]?.key).not.toBe(takes[0]?.key);
    expect(takes.map((take) => take.key).join()).not.toContain("203.0.113");
  });

  it("rejects a bucket that has no limit, without asking the store", async () => {
    const { port, takes } = limiter();
    const error = await failure(() => port.consume({ bucket: "nonesuch", key: "k" }));
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ reason: "unknown_bucket" });
    expect(takes).toEqual([]);
  });

  it("rejects an empty key and a cost that is not a positive number, without asking the store", async () => {
    const { port, takes } = limiter();
    for (const request of [
      { bucket: "login", key: "" },
      { bucket: "login", key: "k", cost: 0 },
      { bucket: "login", key: "k", cost: -1 },
      { bucket: "login", key: "k", cost: Number.NaN },
      { bucket: "login", key: "k", cost: Number.POSITIVE_INFINITY },
    ]) {
      const error = await failure(() => port.consume(request));
      expect(error).toMatchObject({ name: "RateLimitError", reason: "invalid_request" });
    }
    expect(takes).toEqual([]);
  });

  it("rejects when the store fails, so a limiter that cannot decide never allows", async () => {
    const outage = new Error("connection refused");
    const { port } = limiter(() => outage);
    expect(await failure(() => port.consume({ bucket: "login", key: "k" }))).toBe(outage);
  });

  it("rejects an answer no bucket can give, so a fault of the store never reaches a Retry-After", async () => {
    for (const answer of [
      { allowed: false, remaining: 10, retryAfterSeconds: -9000 },
      { allowed: false, remaining: 0.4, retryAfterSeconds: 0 },
      { allowed: false, remaining: 0.4, retryAfterSeconds: Number.NaN },
      { allowed: false, remaining: 0.4, retryAfterSeconds: Number.POSITIVE_INFINITY },
      { allowed: false, remaining: 10.5, retryAfterSeconds: 3 },
      { allowed: true, remaining: 10.5, retryAfterSeconds: 0 },
      { allowed: true, remaining: Number.NaN, retryAfterSeconds: 0 },
      { allowed: true, remaining: -1, retryAfterSeconds: 0 },
    ] satisfies RateLimitTaken[]) {
      const { port } = limiter(() => answer);
      const error = await failure(() => port.consume({ bucket: "login", key: "k" }));
      expect(error).toMatchObject({ name: "RateLimitError", reason: "invalid_store_answer" });
    }
  });

  it("accepts a refused take that leaves a full bucket's worth and a wait above 0", async () => {
    const { port } = limiter(() => ({ allowed: false, remaining: 10, retryAfterSeconds: 0.2 }));
    expect(await port.consume({ bucket: "login", key: "k", cost: 11 })).toEqual({
      allowed: false,
      limit: 10,
      remaining: 10,
      retryAfterSeconds: 1,
    });
  });
});
