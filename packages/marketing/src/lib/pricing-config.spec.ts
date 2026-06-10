import { describe, expect, it } from "vitest";

import {
  buildMarketingPlanFeatureRows,
  isSupporterPromotionActive,
  loadMarketingPricingConfig,
} from "./pricing-config.js";

describe("loadMarketingPricingConfig", () => {
  it("returns config-driven prices from overrides", async () => {
    const config = await loadMarketingPricingConfig({
      personalMonthlyPrice: "$4/mo",
      personalYearlyPrice: "$3.33/mo",
      teamSeatMonthlyPrice: "$9/seat/mo",
      teamSeatYearlyPrice: "$7.50/seat/mo",
      supporterPrice: "$59",
      freeBookmarkCap: 50,
    });

    expect(config.personalMonthlyPrice).toBe("$4/mo");
    expect(config.personalYearlyPrice).toBe("$3.33/mo");
    expect(config.teamSeatMonthlyPrice).toBe("$9/seat/mo");
    expect(config.freeBookmarkCap).toBe(50);
  });

  it("defaults free bookmark cap to 50 per spec §23.4", async () => {
    const config = await loadMarketingPricingConfig();
    expect(config.freeBookmarkCap).toBe(50);
  });
});

describe("buildMarketingPlanFeatureRows", () => {
  it("includes API tokens on all plans and omits folder caps", async () => {
    const rows = buildMarketingPlanFeatureRows(
      await loadMarketingPricingConfig({ freeBookmarkCap: 50 }),
    );
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
  it("returns false after the configured end date", async () => {
    const config = await loadMarketingPricingConfig({
      supporterPromotionEnd: "2020-01-01T00:00:00.000Z",
    });
    expect(isSupporterPromotionActive(config, new Date("2026-01-01T00:00:00.000Z"))).toBe(false);
  });
});
