import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("analytics-client Umami allowlist", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.head.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects hosts outside the build-time allowlist", async () => {
    vi.stubEnv("VITE_UMAMI_HOST", "https://evil.example.com");
    vi.stubEnv("VITE_UMAMI_WEBSITE_ID", "00000000-0000-4000-8000-000000000001");
    vi.stubEnv("VITE_UMAMI_ALLOWED_ORIGINS", "https://analytics.slugbase.app");

    const { isClientAnalyticsConfigured, isPermittedUmamiHost } = await import(
      "./analytics-client.js"
    );

    expect(isPermittedUmamiHost("https://evil.example.com")).toBe(false);
    expect(isClientAnalyticsConfigured()).toBe(false);
  });

  it("loads the tracker when host origin is allowlisted", async () => {
    vi.stubEnv("VITE_UMAMI_HOST", "https://analytics.slugbase.app");
    vi.stubEnv("VITE_UMAMI_WEBSITE_ID", "00000000-0000-4000-8000-000000000001");
    localStorage.setItem("slugbase_analytics_consent", "granted");

    const { initAnalyticsClient } = await import("./analytics-client.js");
    initAnalyticsClient();

    const script = document.querySelector(
      'script[data-website-id="00000000-0000-4000-8000-000000000001"]',
    );
    expect(script).not.toBeNull();
    expect(script?.getAttribute("src")).toBe("https://analytics.slugbase.app/script.js");
  });
});
