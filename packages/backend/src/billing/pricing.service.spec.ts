import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../config/config.service.js";
import type { StripeBillingClient } from "./stripe-billing.service.js";
import { PricingFetchError, PricingService } from "./pricing.service.js";

function createConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_PRICE_PERSONAL_MONTHLY: "price_pm_monthly",
    STRIPE_PRICE_PERSONAL_ANNUAL: "price_pm_annual",
    STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly",
    STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual",
    STRIPE_PRICE_SUPPORTER: "price_supporter_1x",
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

function createStripeClient(
  priceOverrides: Record<string, { unit_amount: number; currency: string; type: "recurring" | "one_time"; recurring: { interval: string } | null } | undefined> = {},
): StripeBillingClient {
  const defaultPrices: Record<string, { unit_amount: number; currency: string; type: "recurring" | "one_time"; recurring: { interval: string } | null }> = {
    price_pm_monthly: { unit_amount: 300, currency: "eur", type: "recurring", recurring: { interval: "month" } },
    price_pm_annual: { unit_amount: 3000, currency: "eur", type: "recurring", recurring: { interval: "year" } },
    price_team_monthly: { unit_amount: 900, currency: "eur", type: "recurring", recurring: { interval: "month" } },
    price_team_annual: { unit_amount: 9000, currency: "eur", type: "recurring", recurring: { interval: "year" } },
    price_supporter_1x: { unit_amount: 6900, currency: "eur", type: "one_time", recurring: null },
  };

  const merged = { ...defaultPrices, ...priceOverrides };

  return {
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    prices: {
      retrieve: vi.fn().mockImplementation((id: string) => {
        const price = merged[id];
        if (!price) {
          throw new Error(`No such price: ${id}`);
        }
        return { id, ...price };
      }),
    },
    invoices: { list: vi.fn() },
  };
}

describe("PricingService", () => {
  it("returns structured pricing from all configured price IDs", async () => {
    const config = createConfig();
    const stripe = createStripeClient();
    const service = new PricingService(config, stripe);

    const result = await service.getPricing();

    expect(result.freeBookmarkCap).toBe(50);
    expect(result.plans.personal.monthly).toBeDefined();
    expect(result.plans.personal.monthly?.priceId).toBe("price_pm_monthly");
    expect(result.plans.personal.monthly?.unitAmount).toBe(300);
    expect(result.plans.personal.monthly?.currency).toBe("eur");
    expect(result.plans.personal.monthly?.interval).toBe("month");
    expect(result.plans.personal.monthly?.display).toBe("€3");

    expect(result.plans.personal.annual).toBeDefined();
    expect(result.plans.personal.annual?.unitAmount).toBe(3000);
    expect(result.plans.personal.annual?.display).toBe("€30");

    expect(result.plans.team.monthly?.unitAmount).toBe(900);
    expect(result.plans.team.monthly?.display).toBe("€9");

    expect(result.plans.team.annual?.unitAmount).toBe(9000);
    expect(result.plans.team.annual?.display).toBe("€90");

    expect(result.plans.supporter).toBeDefined();
    expect(result.plans.supporter?.unitAmount).toBe(6900);
    expect(result.plans.supporter?.type).toBe("one_time");
    expect(result.plans.supporter?.display).toBe("€69");
  });

  it("calls stripe.prices.retrieve for each configured price ID", async () => {
    const config = createConfig();
    const stripe = createStripeClient();
    const service = new PricingService(config, stripe);

    await service.getPricing();

    expect(stripe.prices.retrieve).toHaveBeenCalledTimes(5);
    expect(stripe.prices.retrieve).toHaveBeenCalledWith("price_pm_monthly");
    expect(stripe.prices.retrieve).toHaveBeenCalledWith("price_supporter_1x");
  });

  it("skips price IDs that are not configured", async () => {
    const config = createConfig({
      STRIPE_PRICE_SUPPORTER: undefined,
    });
    const stripe = createStripeClient();
    const service = new PricingService(config, stripe);

    const result = await service.getPricing();

    expect(stripe.prices.retrieve).toHaveBeenCalledTimes(4);
    expect(result.plans.supporter).toBeUndefined();
  });

  it("throws PricingFetchError when a configured Stripe price is not found", async () => {
    const config = createConfig({
      STRIPE_PRICE_SUPPORTER: "price_nonexistent",
    });
    const stripe = createStripeClient({ price_nonexistent: undefined });
    const service = new PricingService(config, stripe);

    await expect(service.getPricing()).rejects.toThrow(PricingFetchError);
  });

  it("formats fractional cent amounts correctly", async () => {
    const config = createConfig({
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_frac",
      STRIPE_PRICE_PERSONAL_ANNUAL: undefined,
      STRIPE_PRICE_TEAM_MONTHLY: undefined,
      STRIPE_PRICE_TEAM_ANNUAL: undefined,
      STRIPE_PRICE_SUPPORTER: undefined,
    });
    const stripe = createStripeClient({
      price_frac: { unit_amount: 150, currency: "usd", type: "recurring", recurring: { interval: "month" } },
    });
    const service = new PricingService(config, stripe);

    const result = await service.getPricing();

    expect(result.plans.personal.monthly?.display).toBe("$1.50");
  });

  it("formats whole-dollar amounts without decimals", async () => {
    const config = createConfig({
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_whole",
      STRIPE_PRICE_PERSONAL_ANNUAL: undefined,
      STRIPE_PRICE_TEAM_MONTHLY: undefined,
      STRIPE_PRICE_TEAM_ANNUAL: undefined,
      STRIPE_PRICE_SUPPORTER: undefined,
    });
    const stripe = createStripeClient({
      price_whole: { unit_amount: 500, currency: "usd", type: "recurring", recurring: { interval: "month" } },
    });
    const service = new PricingService(config, stripe);

    const result = await service.getPricing();

    expect(result.plans.personal.monthly?.display).toBe("$5");
  });

  it("throws PricingFetchError when Stripe prices.retrieve throws (not 404)", async () => {
    const config = createConfig();
    const stripe = createStripeClient();
    (stripe.prices.retrieve as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Stripe API connection error"),
    );
    const service = new PricingService(config, stripe);

    await expect(service.getPricing()).rejects.toThrow(/Failed to fetch price/);
  });

  it("isAvailable returns true when STRIPE_SECRET_KEY is set", () => {
    const config = createConfig({ STRIPE_SECRET_KEY: "sk_live_abc" });
    const stripe = createStripeClient();
    const service = new PricingService(config, stripe);

    expect(service.isAvailable()).toBe(true);
  });

  it("isAvailable returns false when STRIPE_SECRET_KEY is absent", () => {
    const config = createConfig({ STRIPE_SECRET_KEY: undefined });
    const stripe = createStripeClient();
    const service = new PricingService(config, stripe);

    expect(service.isAvailable()).toBe(false);
  });
});
