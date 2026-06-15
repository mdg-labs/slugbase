import { describe, expect, it } from "vitest";

import {
  buildUmamiHostAllowlist,
  isUmamiHostAllowed,
  parseUmamiAllowedOrigins,
} from "./umami-host-allowlist.js";

describe("umami-host-allowlist", () => {
  it("parses comma-separated HTTPS origins", () => {
    const allowed = parseUmamiAllowedOrigins(
      "https://analytics.example.com, https://stats.slugbase.app",
    );
    expect(allowed.has("https://analytics.example.com")).toBe(true);
    expect(allowed.has("https://stats.slugbase.app")).toBe(true);
    expect(allowed.size).toBe(2);
  });

  it("rejects non-HTTPS origins", () => {
    const allowed = parseUmamiAllowedOrigins("http://insecure.example.com");
    expect(allowed.size).toBe(0);
  });

  it("uses explicit origins when ALLOWED_ORIGINS is set", () => {
    const allowlist = buildUmamiHostAllowlist(
      "https://analytics.slugbase.app/",
      "https://analytics.slugbase.app, https://backup-analytics.example.com",
    );
    expect(isUmamiHostAllowed("https://analytics.slugbase.app", allowlist)).toBe(true);
    expect(isUmamiHostAllowed("https://backup-analytics.example.com", allowlist)).toBe(
      true,
    );
    expect(isUmamiHostAllowed("https://evil.example.com", allowlist)).toBe(false);
  });

  it("falls back to configured host when allowlist env is unset", () => {
    const allowlist = buildUmamiHostAllowlist("https://analytics.slugbase.app", undefined);
    expect(isUmamiHostAllowed("https://analytics.slugbase.app", allowlist)).toBe(true);
    expect(isUmamiHostAllowed("https://evil.example.com", allowlist)).toBe(false);
  });
});
