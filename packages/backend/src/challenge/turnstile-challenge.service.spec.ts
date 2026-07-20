import { describe, expect, it, vi } from "vitest";

import { ChallengeVerificationError } from "./challenge.interface.js";
import type { ConfigService } from "../config/config.service.js";
import { TurnstileChallengeService } from "./turnstile-challenge.service.js";

function createConfig(overrides: Partial<Record<string, unknown>> = {}): ConfigService {
  const values: Record<string, unknown> = {
    isProduction: true,
    CHALLENGE_DEV_SKIP: false,
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

describe("TurnstileChallengeService", () => {
  it("reports challenge as available when secret is configured", () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const service = new TurnstileChallengeService(createConfig(), vi.fn());
    expect(service.isAvailable()).toBe(true);
  });

  it("skips verification when dev-skip is enabled", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const http = vi.fn();
    const service = new TurnstileChallengeService(
      createConfig({ isProduction: false, CHALLENGE_DEV_SKIP: undefined }),
      http,
    );

    await expect(service.verify({ token: "any-token" })).resolves.toBeUndefined();
    expect(http).not.toHaveBeenCalled();
  });

  it("verifies a token via Turnstile siteverify", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const http = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const service = new TurnstileChallengeService(createConfig(), http);

    await expect(
      service.verify({ token: "valid-token", remoteIp: "203.0.113.1" }),
    ).resolves.toBeUndefined();

    expect(http).toHaveBeenCalledOnce();
    const [, init] = http.mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("test-turnstile-secret");
    expect(body.get("response")).toBe("valid-token");
    expect(body.get("remoteip")).toBe("203.0.113.1");
  });

  it("rejects when Turnstile reports failure", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const http = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
        status: 200,
      }),
    );
    const service = new TurnstileChallengeService(createConfig(), http);

    await expect(service.verify({ token: "bad-token" })).rejects.toBeInstanceOf(
      ChallengeVerificationError,
    );
  });

  it("rejects missing tokens when dev-skip is disabled", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const http = vi.fn();
    const service = new TurnstileChallengeService(createConfig(), http);

    await expect(service.verify({ token: "   " })).rejects.toBeInstanceOf(
      ChallengeVerificationError,
    );
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects when siteverify returns a non-success HTTP status", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const http = vi.fn().mockResolvedValue(new Response("error", { status: 503 }));
    const service = new TurnstileChallengeService(createConfig(), http);

    await expect(service.verify({ token: "token" })).rejects.toBeInstanceOf(
      ChallengeVerificationError,
    );
  });

  it("rejects when the HTTP request fails", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    const http = vi.fn().mockRejectedValue(new Error("network down"));
    const service = new TurnstileChallengeService(createConfig(), http);

    await expect(service.verify({ token: "token" })).rejects.toBeInstanceOf(
      ChallengeVerificationError,
    );
  });
});
