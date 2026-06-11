import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import { NoopChallengeService } from "./noop-challenge.service.js";

function createConfig(overrides: Partial<Record<string, unknown>> = {}): ConfigService {
  const values: Record<string, unknown> = {
    isProduction: false,
    CHALLENGE_DEV_SKIP: undefined,
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

describe("NoopChallengeService", () => {
  it("reports challenge as unavailable", () => {
    const service = new NoopChallengeService(createConfig());
    expect(service.isAvailable()).toBe(false);
  });

  it("passes verification in development without a token", async () => {
    const service = new NoopChallengeService(createConfig({ isProduction: false }));
    await expect(service.verify({ token: "" })).resolves.toBeUndefined();
  });

  it("enables dev-skip in non-production by default", () => {
    const service = new NoopChallengeService(createConfig({ isProduction: false }));
    expect(service.isDevSkipEnabled()).toBe(true);
  });

  it("disables dev-skip in production unless explicitly enabled", () => {
    const service = new NoopChallengeService(createConfig({ isProduction: true }));
    expect(service.isDevSkipEnabled()).toBe(false);
  });

  it("respects explicit CHALLENGE_DEV_SKIP=false in development", () => {
    const service = new NoopChallengeService(
      createConfig({ isProduction: false, CHALLENGE_DEV_SKIP: false }),
    );
    expect(service.isDevSkipEnabled()).toBe(false);
  });

  it("logs at debug level when verification is skipped", async () => {
    const service = new NoopChallengeService(createConfig());
    const debugSpy = vi.spyOn(service["logger"], "debug");

    await service.verify({ token: "unused" });

    expect(debugSpy).toHaveBeenCalledWith(
      "Challenge provider not configured - verification skipped",
      expect.objectContaining({ hasToken: true }),
    );
  });
});
