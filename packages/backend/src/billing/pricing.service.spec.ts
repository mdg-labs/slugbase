import { describe, expect, it } from "vitest";

import { PricingService } from "./pricing.service.js";

describe("PricingService", () => {
  it("returns static CE pricing metadata without live prices", async () => {
    const service = new PricingService();

    const result = await service.getPricing();

    expect(result.freeBookmarkCap).toBe(50);
    expect(result.teamBaseSeats).toBe(5);
    expect(result.plans.personal).toEqual({});
    expect(result.plans.team).toEqual({});
    expect(result.plans.supporter).toBeUndefined();
  });

  it("isAvailable returns false on CE", () => {
    const service = new PricingService();
    expect(service.isAvailable()).toBe(false);
  });
});
