import { describe, expect, it } from "vitest";

import {
  allowsPii,
  scrubExtra,
  shouldCaptureError,
} from "./error-reporting-pii.js";

describe("error-reporting-pii", () => {
  it("shouldCaptureError is false when unconfigured", () => {
    expect(shouldCaptureError(false)).toBe(false);
  });

  it("shouldCaptureError is false when consent is denied", () => {
    expect(shouldCaptureError(true, { consentGranted: false })).toBe(false);
  });

  it("shouldCaptureError is true when configured and consent not denied", () => {
    expect(shouldCaptureError(true, { consentGranted: true })).toBe(true);
  });

  it("allowsPii only with explicit consent and includePii", () => {
    expect(allowsPii({ consentGranted: true, includePii: true })).toBe(true);
    expect(allowsPii({ consentGranted: true, includePii: false })).toBe(false);
    expect(allowsPii({ consentGranted: false, includePii: true })).toBe(false);
  });

  it("scrubExtra removes sensitive keys", () => {
    expect(
      scrubExtra({
        password: "secret",
        route: "/bookmarks",
      }),
    ).toEqual({ route: "/bookmarks" });
  });
});
