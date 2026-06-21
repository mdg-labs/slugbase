import { describe, expect, it, vi } from "vitest";

import { ConfigService } from "../config/config.service.js";
import { validateEnvConfig } from "../config/env.schema.js";
import type { UmamiHttpExecutor } from "./umami-analytics.service.js";
import { UmamiAnalyticsService } from "./umami-analytics.service.js";

function buildConfig(overrides: Record<string, string | undefined>) {
  const base = validateEnvConfig({
    NODE_ENV: "test",
    SLUGBASE_EDITION: "cloud",
    SESSION_SECRET: "a".repeat(32),
    ENCRYPTION_KEY: "b".repeat(32),
    DATABASE_URL: "file:./test.db",
    APP_BASE_URL: "https://app.slugbase.test",
    FRONTEND_ORIGIN: "https://app.slugbase.test",
    UMAMI_HOST: "https://analytics.slugbase.test",
    UMAMI_WEBSITE_ID: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  });
  return new ConfigService(base);
}

describe("UmamiAnalyticsService", () => {
  it("reports as not configured when Umami env is absent", () => {
    const http = vi.fn<UmamiHttpExecutor>();
    const service = new UmamiAnalyticsService(
      buildConfig({ UMAMI_HOST: undefined, UMAMI_WEBSITE_ID: undefined }),
      http,
    );
    expect(service.isConfigured()).toBe(false);
  });

  it("skips recordEvent when consent is denied", () => {
    const http = vi.fn<UmamiHttpExecutor>();
    const service = new UmamiAnalyticsService(buildConfig({}), http);
    service.recordEvent("signup", { consentGranted: false });
    expect(http).not.toHaveBeenCalled();
  });

  it("records when configured and consent is granted", async () => {
    const http = vi.fn<UmamiHttpExecutor>().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const service = new UmamiAnalyticsService(buildConfig({}), http);
    service.recordEvent("signup", {
      consentGranted: true,
      url: "/signup",
      data: { source: "landing" },
    });

    await vi.waitFor(() => {
      expect(http).toHaveBeenCalledOnce();
    });

    const [url, init] = http.mock.calls[0] ?? [];
    expect(url).toBe("https://analytics.slugbase.test/api/send");
    expect(init?.method).toBe("POST");
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    const body = JSON.parse(bodyText) as {
      type: string;
      payload: { name: string; website: string; url: string };
    };
    expect(body.type).toBe("event");
    expect(body.payload.name).toBe("signup");
    expect(body.payload.website).toBe("00000000-0000-4000-8000-000000000001");
    expect(body.payload.url).toBe("/signup");
  });
});
