import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMarketingPlanFeatureRows,
  createStaticMarketingPricingConfig,
  isSupporterPromotionActive,
  mapPricingResponseToConfig,
} from "./pricing-config.js";
import { fetchPublicPricing } from "./pricing-api.client.js";
import type { PricingResponse } from "./pricing-api-types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("mapPricingResponseToConfig", () => {
  it("maps API response display strings", () => {
    const config = mapPricingResponseToConfig({
      plans: {
        personal: {
          monthly: { display: "€3/mo" },
          annual: { display: "€30/yr" },
        },
        team: {
          monthly: { display: "€9/seat/mo" },
          annual: { display: "€90/seat/yr" },
        },
        supporter: { display: "€69" },
      },
      freeBookmarkCap: 50,
    } as PricingResponse);

    expect(config.personalMonthlyPrice).toBe("€3/mo");
    expect(config.teamSeatMonthlyPrice).toBe("€9/seat/mo");
    expect(config.supporterPrice).toBe("€69");
    expect(config.freeBookmarkCap).toBe(50);
  });
});

describe("createStaticMarketingPricingConfig", () => {
  it("defaults free bookmark cap to 50 per spec §23.4", () => {
    const config = createStaticMarketingPricingConfig();
    expect(config.freeBookmarkCap).toBe(50);
    expect(config.personalMonthlyPrice).toBe("");
  });
});

describe("fetchPublicPricing", () => {
  it("fetches GET /pricing/public from PUBLIC_API_BASE_URL", async () => {
    vi.stubEnv("PUBLIC_API_BASE_URL", "https://api.example.com");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          plans: {
            personal: { monthly: { display: "€3/mo" } },
            team: { monthly: { display: "€9/seat/mo" } },
          },
          freeBookmarkCap: 50,
        }),
    });

    const response = await fetchPublicPricing();

    expect(response.freeBookmarkCap).toBe(50);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.example.com/pricing/public");
  });
});

describe("buildMarketingPlanFeatureRows", () => {
  it("includes API tokens on all plans and omits folder caps", () => {
    const rows = buildMarketingPlanFeatureRows(createStaticMarketingPricingConfig());
    const labels = rows.map((row) => row.labelKey);

    expect(labels).toContain("marketing.pricing.feature.api_tokens");
    expect(labels).not.toContain("marketing.pricing.feature.folders");

    const apiRow = rows.find((row) => row.labelKey === "marketing.pricing.feature.api_tokens");
    expect(apiRow?.free).toBe("included");
    expect(apiRow?.personal).toBe("included");
    expect(apiRow?.team).toBe("included");
  });
});

describe("isSupporterPromotionActive", () => {
  it("returns false after the configured end date", () => {
    const config = createStaticMarketingPricingConfig({
      supporterPromotionEnd: "2020-01-01T00:00:00.000Z",
    });
    expect(isSupporterPromotionActive(config, new Date("2026-01-01T00:00:00.000Z"))).toBe(false);
  });
});
