import { describe, expect, it } from "vitest";

import { NoopAnalyticsService } from "./noop-analytics.service.js";

describe("NoopAnalyticsService", () => {
  it("reports as not configured", () => {
    const service = new NoopAnalyticsService();
    expect(service.isConfigured()).toBe(false);
  });

  it("does not throw on recordEvent without consent", () => {
    const service = new NoopAnalyticsService();
    expect(() => {
      service.recordEvent("signup", { consentGranted: false });
    }).not.toThrow();
  });

  it("does not throw on recordEvent when unconfigured", () => {
    const service = new NoopAnalyticsService();
    expect(() => {
      service.recordEvent("signup", { consentGranted: true });
    }).not.toThrow();
  });
});
