import { describe, expect, it } from "vitest";

import { shouldRecordAnalyticsEvent } from "./analytics-consent.js";

describe("shouldRecordAnalyticsEvent", () => {
  it("returns false when analytics is not configured", () => {
    expect(shouldRecordAnalyticsEvent(false, { consentGranted: true })).toBe(
      false,
    );
  });

  it("returns false when consent is denied", () => {
    expect(shouldRecordAnalyticsEvent(true, { consentGranted: false })).toBe(
      false,
    );
  });

  it("returns true when configured and consent is granted", () => {
    expect(shouldRecordAnalyticsEvent(true, { consentGranted: true })).toBe(true);
  });

  it("returns true when configured and consent is not specified", () => {
    expect(shouldRecordAnalyticsEvent(true, undefined)).toBe(true);
  });
});
