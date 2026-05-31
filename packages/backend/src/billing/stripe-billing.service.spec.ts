import { describe, expect, it, vi } from "vitest";

import { BillingSeatFloorError } from "@slugbase/shared-types";

import type { ConfigService } from "../config/config.service.js";
import { StripeBillingService, type StripeBillingClient } from "./stripe-billing.service.js";

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
        metadata: { workspace_id: "ws-1", plan: "team", included_seats: "5" },
        items: {
          data: [{ id: "si_1", quantity: 5, price: { metadata: { plan: "team" } } }],
        },
      }),
      update: vi.fn().mockResolvedValue({
        id: "sub_team_1",
        customer: "cus_team_1",
        status: "active",
        current_period_end: 1_735_689_600,
        metadata: { workspace_id: "ws-1", plan: "team", included_seats: "5" },
        items: {
          data: [{ id: "si_1", quantity: 8, price: { metadata: { plan: "team" } } }],
        },
      }),
    },
    ...overrides,
  };
}

describe("StripeBillingService", () => {
  it("reports available when Stripe key is configured", () => {
    const service = new StripeBillingService(createConfig(), createStripeClient());
    expect(service.isAvailable()).toBe(true);
    expect(service.isPlanGatingEnabled()).toBe(true);
  });

  it("maps subscription state from Stripe", async () => {
    const stripe = createStripeClient();
    const service = new StripeBillingService(createConfig(), stripe);

    const state = await service.getSubscriptionState({
      workspaceId: "ws-1",
      externalSubscriptionId: "sub_team_1",
    });

    expect(state.plan).toBe("team");
    expect(state.includedSeats).toBe(5);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_team_1");
  });

  it("creates checkout sessions via Stripe", async () => {
    const stripe = createStripeClient();
    const service = new StripeBillingService(createConfig(), stripe);

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

  it("enforces seat floor on quantity updates", async () => {
    const service = new StripeBillingService(createConfig(), createStripeClient());

    await expect(
      service.updateSeatQuantity({
        workspaceId: "ws-1",
        externalSubscriptionId: "sub_team_1",
        totalSeats: 2,
        currentMemberCount: 5,
      }),
    ).rejects.toBeInstanceOf(BillingSeatFloorError);
  });

  it("processes subscription webhook events", async () => {
    const service = new StripeBillingService(createConfig(), createStripeClient());
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
    const service = new StripeBillingService(createConfig(), createStripeClient());

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
