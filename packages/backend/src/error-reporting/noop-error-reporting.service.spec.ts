import { describe, expect, it } from "vitest";

import { NoopErrorReportingService } from "./noop-error-reporting.service.js";

describe("NoopErrorReportingService", () => {
  it("reports as not configured", () => {
    const service = new NoopErrorReportingService();
    expect(service.isConfigured()).toBe(false);
  });

  it("does not throw on captureException", () => {
    const service = new NoopErrorReportingService();
    expect(() => {
      service.captureException(new Error("test"));
    }).not.toThrow();
  });

  it("does not throw on captureMessage", () => {
    const service = new NoopErrorReportingService();
    expect(() => {
      service.captureMessage("diagnostic");
    }).not.toThrow();
  });
});
