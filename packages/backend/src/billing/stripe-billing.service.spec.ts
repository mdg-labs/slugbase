import { describe, expect, it, vi } from "vitest";

import { BillingSeatFloorError } from "@slugbase/shared-types";

import type { ConfigService } from "../config/config.service.js";
import { StripeBillingService, type StripeBillingClient } from "./stripe-billing.service.js";

function createErrorReporting() {
  return {
    isConfigured: () => false,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
}

function createConfig(overrides: Partial<Record<string, string>> = {}) {
  const values: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: "sk_test_example",
    ...overrides,
  };

  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

function createStripeClient(
  overrides: Partial<StripeBillingClient> = {},
): StripeBillingClient {
  return {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_test",
          url: "https://checkout.stripe.test/session",
        }),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          url: "https://billing.stripe.test/portal",
        }),
      },
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: "sub_team_1",
        customer: "cus_team_1",
        status: "active",
        current_period_end: 1_735_689_600,
        metadata: { workspace_id: "ws-1", plan: "team" },
        items: {
          data: [{ id: "si_1", quantity: 5, price: { metadata: { plan: "team" } } }],
        },
      }),
      update: vi.fn().mockResolvedValue({
        id: "sub_team_1",
        customer: "cus_team_1",
        status: "active",
        current_period_end: 1_735_689_600,
        metadata: { workspace_id: "ws-1", plan: "team" },
        items: {
          data: [{ id: "si_1", quantity: 8, price: { metadata: { plan: "team" } } }],
        },
      }),
    },
    prices: {
      retrieve: vi.fn().mockResolvedValue({
        id: "price_test",
        unit_amount: 300,
        currency: "eur",
        type: "recurring",
        recurring: { interval: "month" },
      }),
    },
    ...overrides,
  };
}

describe("StripeBillingService", () => {
  it("reports available when Stripe key is configured", () => {
    const service = new StripeBillingService(createConfig(), createStripeClient(), createErrorReporting());
    expect(service.isAvailable()).toBe(true);
    expect(service.isPlanGatingEnabled()).toBe(true);
  });

  it("maps subscription state from Stripe", async () => {
    const stripe = createStripeClient();
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    const state = await service.getSubscriptionState({
      workspaceId: "ws-1",
      externalSubscriptionId: "sub_team_1",
    });

    expect(state.plan).toBe("team");
    expect(state.extraSeats).toBe(5);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_team_1");
  });

  it("creates checkout sessions via Stripe", async () => {
    const stripe = createStripeClient();
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    const session = await service.createCheckoutSession({
      workspaceId: "ws-1",
      plan: "personal",
      mode: "recurring",
      priceId: "price_personal",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      customerEmail: "owner@example.com",
    });

    expect(session.checkoutUrl).toBe("https://checkout.stripe.test/session");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  });

  it("creates team checkout with requested seat quantity", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.test/session",
    });
    const stripe = createStripeClient({
      checkout: { sessions: { create: createMock } },
    });
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    await service.createCheckoutSession({
      workspaceId: "ws-1",
      plan: "team",
      mode: "recurring",
      priceId: "price_team",
      seatQuantity: 5,
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      customerEmail: "owner@example.com",
    });

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const lineItems = params.line_items as Array<{ quantity: number }>;
    expect(lineItems[0]?.quantity).toBe(5);
  });

  it("creates personal checkout with quantity 1 regardless of seatQuantity", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.test/session",
    });
    const stripe = createStripeClient({
      checkout: { sessions: { create: createMock } },
    });
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    await service.createCheckoutSession({
      workspaceId: "ws-1",
      plan: "personal",
      mode: "recurring",
      priceId: "price_personal",
      seatQuantity: 5,
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      customerEmail: "owner@example.com",
    });

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const lineItems = params.line_items as Array<{ quantity: number }>;
    expect(lineItems[0]?.quantity).toBe(1);
  });

  it("does not set included_seats in subscription metadata", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.test/session",
    });
    const stripe = createStripeClient({
      checkout: { sessions: { create: createMock } },
    });
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    await service.createCheckoutSession({
      workspaceId: "ws-1",
      plan: "team",
      mode: "recurring",
      priceId: "price_team",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      customerEmail: "owner@example.com",
    });

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const subscriptionData = params.subscription_data as Record<string, unknown> | undefined;
    expect(subscriptionData).toBeDefined();
    const subMetadata = (subscriptionData as Record<string, unknown>).metadata as Record<string, string>;
    expect(subMetadata.included_seats).toBeUndefined();
  });

  it("includes product slugbase in checkout session metadata", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.test/session",
    });
    const stripe = createStripeClient({
      checkout: { sessions: { create: createMock } },
    });
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    await service.createCheckoutSession({
      workspaceId: "ws-1",
      plan: "personal",
      mode: "recurring",
      priceId: "price_personal",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      customerEmail: "owner@example.com",
    });

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const metadata = params.metadata as Record<string, string>;
    expect(metadata.product).toBe("slugbase");

    const subscriptionData = params.subscription_data as Record<string, unknown> | undefined;
    expect(subscriptionData).toBeDefined();
    const subMetadata = (subscriptionData as Record<string, unknown>).metadata as Record<string, string>;
    expect(subMetadata.product).toBe("slugbase");
  });

  it("includes product slugbase in one-time checkout metadata", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.test/session",
    });
    const stripe = createStripeClient({
      checkout: { sessions: { create: createMock } },
    });
    const service = new StripeBillingService(createConfig(), stripe, createErrorReporting());

    await service.createCheckoutSession({
      workspaceId: "ws-1",
      plan: "personal",
      mode: "one_time",
      priceId: "price_supporter",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      customerEmail: "owner@example.com",
    });

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const metadata = params.metadata as Record<string, string>;
    expect(metadata.product).toBe("slugbase");
  });

  it("enforces seat floor on quantity updates", async () => {
    const service = new StripeBillingService(createConfig(), createStripeClient(), createErrorReporting());

    await expect(
      service.updateSeatQuantity({
        workspaceId: "ws-1",
        externalSubscriptionId: "sub_team_1",
        totalSeats: 2,
        currentMemberCount: 5,
      }),
    ).rejects.toBeInstanceOf(BillingSeatFloorError);
  });

  it("rejects seat updates below TEAM_MIN_SEATS", async () => {
    const service = new StripeBillingService(createConfig(), createStripeClient(), createErrorReporting());

    await expect(
      service.updateSeatQuantity({
        workspaceId: "ws-1",
        externalSubscriptionId: "sub_team_1",
        totalSeats: 1,
        currentMemberCount: 1,
      }),
    ).rejects.toThrow(/at least 2 seats/i);
  });

  it("processes subscription webhook events", async () => {
    const service = new StripeBillingService(createConfig(), createStripeClient(), createErrorReporting());
    const payload = {
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          object: "subscription",
          status: "active",
          current_period_end: 1_735_689_600,
          customer: "cus_1",
          metadata: { workspace_id: "ws-1", plan: "personal" },
        },
      },
    };

    const first = await service.handleAsyncEvent({ eventId: "evt_sub_updated", payload });

    expect(first.stateUpdated).toBe(true);
    expect(first.subscriptionState?.plan).toBe("personal");
  });

  it("maps supporter checkout completion to Personal-permanent", async () => {
    const service = new StripeBillingService(createConfig(), createStripeClient(), createErrorReporting());

    const result = await service.handleAsyncEvent({
      eventId: "evt_checkout_done",
      payload: {
        id: "evt_checkout_done",
        type: "checkout.session.completed",
        data: {
          object: {
            object: "checkout.session",
            mode: "payment",
            customer: "cus_supporter",
            metadata: { workspace_id: "ws-supporter" },
          },
        },
      },
    });

    expect(result.subscriptionState).toMatchObject({
      workspaceId: "ws-supporter",
      plan: "personal",
      permanentPersonal: true,
    });
  });
});
