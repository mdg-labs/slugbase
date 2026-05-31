import { describe, expect, it, vi } from "vitest";

import { PlanConfigService, DEFAULT_TEAM_BASE_SEATS } from "./plan-config.service.js";
import type { ConfigService } from "../../config/config.service.js";

function createPlanConfig(overrides: Record<string, string | number | undefined> = {}): PlanConfigService {
  const config = {
    get: vi.fn((key: string) => overrides[key]),
  } as unknown as ConfigService;
  return new PlanConfigService(config);
}

describe("PlanConfigService", () => {
  it("defaults team base seats to 5 when unset", () => {
    const service = createPlanConfig({ TEAM_BASE_SEATS: DEFAULT_TEAM_BASE_SEATS });
    expect(service.getTeamBaseSeats()).toBe(5);
  });

  it("reads config-driven Stripe price ids", () => {
    const service = createPlanConfig({
      STRIPE_PRICE_PERSONAL: "price_personal",
      STRIPE_PRICE_TEAM: "price_team",
      STRIPE_PRICE_TEAM_EXTRA_SEAT: "price_extra",
      STRIPE_PRICE_SUPPORTER: "price_supporter",
      TEAM_BASE_SEATS: 7,
    });

    expect(service.getPriceConfig()).toEqual({
      personalRecurringPriceId: "price_personal",
      teamRecurringPriceId: "price_team",
      teamExtraSeatPriceId: "price_extra",
      supporterOneTimePriceId: "price_supporter",
    });
    expect(service.resolveCheckoutPriceId("personal", "recurring")).toBe("price_personal");
    expect(service.resolveCheckoutPriceId("team", "recurring")).toBe("price_team");
    expect(service.resolveCheckoutPriceId("personal", "one_time")).toBe("price_supporter");
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
