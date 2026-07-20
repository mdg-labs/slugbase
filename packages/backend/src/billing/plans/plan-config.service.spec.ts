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
  it("returns null price ids on CE", () => {
    const service = createPlanConfig();

    expect(service.getPriceConfig()).toEqual({
      personalMonthlyPriceId: null,
      personalAnnualPriceId: null,
      teamMonthlyPriceId: null,
      teamAnnualPriceId: null,
      supporterOneTimePriceId: null,
    });
  });

  it("resolveCheckoutPriceId returns null when prices are not configured", () => {
    const service = createPlanConfig();
    expect(service.resolveCheckoutPriceId("personal", "recurring")).toBeNull();
    expect(service.resolveCheckoutPriceId("team", "recurring", "annual")).toBeNull();
    expect(service.resolveCheckoutPriceId("personal", "one_time")).toBeNull();
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
