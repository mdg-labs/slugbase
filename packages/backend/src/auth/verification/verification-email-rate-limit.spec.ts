import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../../config/config.service.js";
import {
  assertVerificationEmailRateLimit,
  verificationEmailRateLimitSinceMs,
} from "./verification-email-rate-limit.js";

function mockConfig(overrides: {
  max?: number;
  ttlSeconds?: number;
}): ConfigService {
  return {
    get: (key: string) => {
      if (key === "RATE_LIMIT_EMAIL_VERIFICATION_MAX") {
        return overrides.max ?? 3;
      }
      if (key === "RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS") {
        return overrides.ttlSeconds ?? 3600;
      }
      throw new Error(`unexpected config key: ${key}`);
    },
  } as unknown as ConfigService;
}

describe("verificationEmailRateLimitSinceMs", () => {
  it("uses configured TTL seconds for the rolling window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    try {
      const since = verificationEmailRateLimitSinceMs(mockConfig({ ttlSeconds: 120 }));
      expect(since).toBe(Date.parse("2026-06-02T12:00:00Z") - 120_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assertVerificationEmailRateLimit", () => {
  it("allows when count is below max", () => {
    expect(() => {
      assertVerificationEmailRateLimit(2, mockConfig({ max: 3 }));
    }).not.toThrow();
  });

  it("throws 429 when count reaches max", () => {
    expect(() => {
      assertVerificationEmailRateLimit(3, mockConfig({ max: 3 }));
    }).toThrow(HttpException);
    try {
      assertVerificationEmailRateLimit(3, mockConfig({ max: 3 }));
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });
});
