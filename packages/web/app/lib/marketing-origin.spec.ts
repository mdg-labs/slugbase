import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMarketingLegalUrl,
  getMarketingOrigin,
  parseMarketingOrigin,
} from "./marketing-origin.js";

describe("parseMarketingOrigin", () => {
  it("returns null for empty or whitespace values", () => {
    expect(parseMarketingOrigin(undefined)).toBeNull();
    expect(parseMarketingOrigin("")).toBeNull();
    expect(parseMarketingOrigin("   ")).toBeNull();
  });

  it("strips trailing slashes", () => {
    expect(parseMarketingOrigin("https://marketing.example.com/")).toBe(
      "https://marketing.example.com",
    );
    expect(parseMarketingOrigin("https://marketing.example.com///")).toBe(
      "https://marketing.example.com",
    );
  });

  it("preserves a valid origin without trailing slash", () => {
    expect(parseMarketingOrigin("http://localhost:4321")).toBe("http://localhost:4321");
  });
});

describe("getMarketingOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when VITE_MARKETING_ORIGIN is unset", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "");
    expect(getMarketingOrigin()).toBeNull();
  });

  it("returns normalized origin when set", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "https://marketing.example.com/");
    expect(getMarketingOrigin()).toBe("https://marketing.example.com");
  });
});

describe("buildMarketingLegalUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when marketing origin is unset", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "");
    expect(buildMarketingLegalUrl("en", "impressum")).toBeNull();
    expect(buildMarketingLegalUrl("de", "datenschutz")).toBeNull();
  });

  it("builds English legal paths without locale prefix", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "https://marketing.example.com");

    expect(buildMarketingLegalUrl("en", "impressum")).toBe(
      "https://marketing.example.com/legal/impressum",
    );
    expect(buildMarketingLegalUrl("en", "datenschutz")).toBe(
      "https://marketing.example.com/legal/datenschutz",
    );
    expect(buildMarketingLegalUrl("en", "agb")).toBe(
      "https://marketing.example.com/legal/agb",
    );
  });

  it("builds German legal paths with /de prefix", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "https://marketing.example.com");

    expect(buildMarketingLegalUrl("de", "impressum")).toBe(
      "https://marketing.example.com/de/legal/impressum",
    );
    expect(buildMarketingLegalUrl("de", "datenschutz")).toBe(
      "https://marketing.example.com/de/legal/datenschutz",
    );
    expect(buildMarketingLegalUrl("de", "agb")).toBe(
      "https://marketing.example.com/de/legal/agb",
    );
  });
});
