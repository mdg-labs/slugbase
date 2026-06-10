import { describe, expect, it, vi } from "vitest";

import { PlanConfigService } from "./plan-config.service.js";
import type { ConfigService } from "../../config/config.service.js";

function createPlanConfig(overrides: Record<string, string | number | undefined> = {}): PlanConfigService {
  const config = {
    get: vi.fn((key: string) => overrides[key]),
  } as unknown as ConfigService;
  return new PlanConfigService(config);
}

describe("PlanConfigService", () => {
  it("reads per-interval Stripe price ids", () => {
    const service = createPlanConfig({
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_personal_monthly",
      STRIPE_PRICE_PERSONAL_ANNUAL: "price_personal_annual",
      STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly",
      STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual",
      STRIPE_PRICE_SUPPORTER: "price_supporter",
    });

    expect(service.getPriceConfig()).toEqual({
      personalMonthlyPriceId: "price_personal_monthly",
      personalAnnualPriceId: "price_personal_annual",
      teamMonthlyPriceId: "price_team_monthly",
      teamAnnualPriceId: "price_team_annual",
      supporterOneTimePriceId: "price_supporter",
    });
  });

  it("resolveCheckoutPriceId defaults to monthly interval", () => {
    const service = createPlanConfig({
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_personal_monthly",
      STRIPE_PRICE_PERSONAL_ANNUAL: "price_personal_annual",
      STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly",
      STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual",
      STRIPE_PRICE_SUPPORTER: "price_supporter",
    });

    expect(service.resolveCheckoutPriceId("personal", "recurring")).toBe("price_personal_monthly");
    expect(service.resolveCheckoutPriceId("team", "recurring")).toBe("price_team_monthly");
  });

  it("resolveCheckoutPriceId resolves monthly prices", () => {
    const service = createPlanConfig({
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_personal_monthly",
      STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly",
      STRIPE_PRICE_SUPPORTER: "price_supporter",
    });

    expect(service.resolveCheckoutPriceId("personal", "recurring", "monthly")).toBe("price_personal_monthly");
    expect(service.resolveCheckoutPriceId("team", "recurring", "monthly")).toBe("price_team_monthly");
    expect(service.resolveCheckoutPriceId("personal", "one_time", "monthly")).toBe("price_supporter");
  });

  it("resolveCheckoutPriceId resolves annual prices", () => {
    const service = createPlanConfig({
      STRIPE_PRICE_PERSONAL_ANNUAL: "price_personal_annual",
      STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual",
      STRIPE_PRICE_SUPPORTER: "price_supporter",
    });

    expect(service.resolveCheckoutPriceId("personal", "recurring", "annual")).toBe("price_personal_annual");
    expect(service.resolveCheckoutPriceId("team", "recurring", "annual")).toBe("price_team_annual");
    expect(service.resolveCheckoutPriceId("personal", "one_time", "annual")).toBe("price_supporter");
  });

  it("resolveCheckoutPriceId returns null when price is not configured", () => {
    const service = createPlanConfig({});
    expect(service.resolveCheckoutPriceId("personal", "recurring")).toBeNull();
    expect(service.resolveCheckoutPriceId("team", "recurring", "annual")).toBeNull();
  });

  it("treats supporter promotion as active when end date is unset", () => {
    const service = createPlanConfig({});
    expect(service.isSupporterPromotionActive()).toBe(true);
  });

  it("respects supporter promotion end date from config", () => {
    const service = createPlanConfig({
      SUPPORTER_PROMOTION_END: "2026-12-31T23:59:59Z",
    });
    expect(service.isSupporterPromotionActive(new Date("2026-06-01T00:00:00Z"))).toBe(true);
    expect(service.isSupporterPromotionActive(new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });
});
