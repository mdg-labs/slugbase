import { afterEach, describe, expect, it } from "vitest";

import {
  checkLoginRateLimit,
  resetLoginRateLimits,
} from "./rate-limit.js";

describe("login rate limit", () => {
  afterEach(() => {
    resetLoginRateLimits();
  });

  it("allows up to 10 attempts then blocks", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(checkLoginRateLimit("127.0.0.1")).toEqual({ allowed: true });
    }

    const blocked = checkLoginRateLimit("127.0.0.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });
});
