import { describe, expect, it } from "vitest";

import {
  formatMarketingBrandTitle,
  formatMarketingPageTitle,
} from "./format-marketing-page-title.js";

describe("formatMarketingPageTitle", () => {
  it("formats en title with brand first and pipe separator", () => {
    expect(formatMarketingPageTitle("en", "marketing.pricing.page_title")).toBe(
      "SlugBase | Pricing",
    );
  });

  it("formats de title with localized page label", () => {
    expect(formatMarketingPageTitle("de", "marketing.pricing.page_title")).toBe(
      "SlugBase | Preise",
    );
  });

  it("returns brand-only title for landing", () => {
    expect(formatMarketingBrandTitle("en")).toBe("SlugBase");
    expect(formatMarketingBrandTitle("de")).toBe("SlugBase");
  });
});
