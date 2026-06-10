import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module.js";
import { STRIPE_CLIENT } from "../src/billing/billing.tokens.js";
import type { StripeBillingClient } from "../src/billing/stripe-billing.service.js";
import type { PricingResponse } from "../src/billing/pricing.service.js";
import { applyTestEnv, clearTestEnv } from "../src/test-utils/test-env.js";
import { createTestDatabase } from "./test-database.js";

describe("GET /pricing/public (integration)", () => {
  let app: INestApplication | undefined;
  let cleanup: () => Promise<void> = async () => {};

  const stripeClient: StripeBillingClient = {
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    prices: {
      retrieve: vi.fn().mockImplementation((id: string) => {
        const prices: Record<string, { unit_amount: number; currency: string; type: "recurring" | "one_time"; recurring: { interval: string } | null }> = {
          price_pm_monthly: { unit_amount: 300, currency: "eur", type: "recurring", recurring: { interval: "month" } },
          price_pm_annual: { unit_amount: 3000, currency: "eur", type: "recurring", recurring: { interval: "year" } },
          price_team_monthly: { unit_amount: 900, currency: "eur", type: "recurring", recurring: { interval: "month" } },
          price_team_annual: { unit_amount: 9000, currency: "eur", type: "recurring", recurring: { interval: "year" } },
          price_seat_monthly: { unit_amount: 200, currency: "eur", type: "recurring", recurring: { interval: "month" } },
          price_seat_annual: { unit_amount: 2000, currency: "eur", type: "recurring", recurring: { interval: "year" } },
          price_supporter_1x: { unit_amount: 6900, currency: "eur", type: "one_time", recurring: null },
        };
        const price = prices[id];
        if (!price) throw new Error(`No such price: ${id}`);
        return { id, ...price };
      }),
    },
  };

  beforeAll(async () => {
    const testDatabase = await createTestDatabase();
    cleanup = testDatabase.cleanup;
    applyTestEnv({
      DATABASE_URL: testDatabase.databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_pricing_integration",
      STRIPE_PRICE_PERSONAL_MONTHLY: "price_pm_monthly",
      STRIPE_PRICE_PERSONAL_ANNUAL: "price_pm_annual",
      STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly",
      STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual",
      STRIPE_PRICE_TEAM_EXTRA_SEAT_MONTHLY: "price_seat_monthly",
      STRIPE_PRICE_TEAM_EXTRA_SEAT_ANNUAL: "price_seat_annual",
      STRIPE_PRICE_SUPPORTER: "price_supporter_1x",
      TEAM_BASE_SEATS: "5",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STRIPE_CLIENT)
      .useValue(stripeClient)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    clearTestEnv();
    await cleanup();
  });

  it("returns 200 with structured pricing data", async () => {
    const server = (app as INestApplication).getHttpServer() as Server;
    const response = await request(server).get("/pricing/public");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");

    const body = response.body as PricingResponse;
    expect(body.teamBaseSeats).toBe(5);
    expect(body.freeBookmarkCap).toBe(50);

    expect(body.plans.personal.monthly).toBeDefined();
    expect(body.plans.personal.monthly?.priceId).toBe("price_pm_monthly");
    expect(body.plans.personal.monthly?.unitAmount).toBe(300);
    expect(body.plans.personal.monthly?.currency).toBe("eur");
    expect(body.plans.personal.monthly?.interval).toBe("month");
    expect(body.plans.personal.monthly?.display).toBe("€3");

    expect(body.plans.personal.annual).toBeDefined();
    expect(body.plans.personal.annual?.priceId).toBe("price_pm_annual");
    expect(body.plans.personal.annual?.unitAmount).toBe(3000);
    expect(body.plans.personal.annual?.display).toBe("€30");

    expect(body.plans.team.monthly?.unitAmount).toBe(900);
    expect(body.plans.team.annual?.unitAmount).toBe(9000);

    expect(body.plans.teamExtraSeat.monthly?.unitAmount).toBe(200);
    expect(body.plans.teamExtraSeat.annual?.unitAmount).toBe(2000);

    expect(body.plans.supporter).toBeDefined();
    expect(body.plans.supporter?.priceId).toBe("price_supporter_1x");
    expect(body.plans.supporter?.unitAmount).toBe(6900);
    expect(body.plans.supporter?.type).toBe("one_time");
    expect(body.plans.supporter?.display).toBe("€69");
  });

  it("does not require authentication", async () => {
    const server = (app as INestApplication).getHttpServer() as Server;
    const response = await request(server).get("/pricing/public");

    expect(response.status).toBe(200);
  });

  it("calls Stripe prices.retrieve for each configured price", () => {
    // Two requests so far (first test + this) × 7 configured prices = 14 calls
    expect(stripeClient.prices.retrieve).toHaveBeenCalledTimes(14);
  });
});
