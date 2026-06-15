import { describe, expect, it } from "vitest";

import { isSensitiveReplayRoute } from "./sentry-replay-routes.js";

describe("isSensitiveReplayRoute", () => {
  it("flags auth and settings routes", () => {
    expect(isSensitiveReplayRoute("/login")).toBe(true);
    expect(isSensitiveReplayRoute("/settings/account")).toBe(true);
    expect(isSensitiveReplayRoute("/mfa/enroll")).toBe(true);
  });

  it("allows general app routes", () => {
    expect(isSensitiveReplayRoute("/bookmarks")).toBe(false);
    expect(isSensitiveReplayRoute("/dashboard")).toBe(false);
  });
});
