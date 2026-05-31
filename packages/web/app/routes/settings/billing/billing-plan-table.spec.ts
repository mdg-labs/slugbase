import { describe, expect, it } from "vitest";

import {
  buildPlanFeatureRows,
  formatPlanPriceLabel,
  planRank,
  resolvePlanCta,
} from "./billing-plan-table.js";
import type { BillingPlanDisplayConfig } from "./billing.types.js";

const sampleConfig: BillingPlanDisplayConfig = {
  billingEnabled: true,
  personalMonthlyPrice: "$4",
  personalYearlyPrice: "$40",
  teamSeatPrice: "$9",
  supporterPrice: "$59",
  supporterPromotionEnd: "2026-12-31T23:59:59.000Z",
  teamBaseSeats: 5,
  freeBookmarkCap: 50,
};

describe("billing plan table", () => {
  it("builds feature rows from config without folder cap or API gating", () => {
    const rows = buildPlanFeatureRows(sampleConfig);
    const keys = rows.map((row) => row.key);

    expect(keys).toContain("settings.billing.feature.bookmarks");
    expect(keys).toContain("settings.billing.feature.ai_suggestions");
    expect(keys).not.toContain("settings.billing.feature.folders");
    expect(keys).not.toContain("settings.billing.feature.api_access");

    const bookmarks = rows.find((row) => row.key === "settings.billing.feature.bookmarks");
    expect(bookmarks?.free).toBe("50");
    expect(bookmarks?.personal).toBe("settings.billing.feature.unlimited");
  });

  it("uses team base seats from config for members row", () => {
    const rows = buildPlanFeatureRows({ ...sampleConfig, teamBaseSeats: 8 });
    const members = rows.find((row) => row.key === "settings.billing.feature.members");
    expect(members?.team).toBe("8");
  });

  it("resolves upgrade and downgrade CTAs by plan rank", () => {
    expect(resolvePlanCta("free", "personal")).toBe("upgrade");
    expect(resolvePlanCta("team", "personal")).toBe("downgrade");
    expect(resolvePlanCta("personal", "personal")).toBe("current");
    expect(planRank("team")).toBeGreaterThan(planRank("personal"));
  });

  it("formats plan prices from config", () => {
    expect(formatPlanPriceLabel("personal", sampleConfig)).toEqual({
      price: "$4",
      periodKey: "settings.billing.plan_period_monthly",
    });
    expect(formatPlanPriceLabel("team", sampleConfig)).toEqual({
      price: "$9",
      periodKey: "settings.billing.plan_period_seat_monthly",
    });
  });
});
