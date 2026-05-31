import { describe, expect, it } from "vitest";

import {
  mapStripeSubscriptionToState,
  mapSupporterCheckoutToState,
  parseStripeEvent,
  subscriptionFromStripeObject,
} from "./stripe-billing.mapper.js";

describe("stripe-billing.mapper", () => {
  it("maps an active Team subscription with extra seats", () => {
    const state = mapStripeSubscriptionToState("ws-team", {
      id: "sub_team_1",
      customer: "cus_team_1",
      status: "active",
      current_period_end: 1_735_689_600,
      metadata: { workspace_id: "ws-team", plan: "team", included_seats: "5" },
      items: {
        data: [{ id: "si_1", quantity: 7, price: { metadata: { plan: "team" } } }],
      },
    });

    expect(state).toMatchObject({
      workspaceId: "ws-team",
      plan: "team",
      status: "active",
      externalCustomerId: "cus_team_1",
      externalSubscriptionId: "sub_team_1",
      includedSeats: 5,
      extraSeats: 2,
      planGatingEnabled: true,
    });
    expect(state.currentPeriodEnd).toEqual(new Date(1_735_689_600 * 1000));
  });

  it("maps cancel-at-period-end to cancelled status", () => {
    const state = mapStripeSubscriptionToState("ws-1", {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: true,
      current_period_end: 1_735_689_600,
      metadata: { plan: "personal" },
    });

    expect(state.status).toBe("cancelled");
    expect(state.plan).toBe("personal");
  });

  it("maps supporter checkout to Personal-permanent state", () => {
    const state = mapSupporterCheckoutToState("ws-supporter", "cus_supporter");

    expect(state).toEqual({
      workspaceId: "ws-supporter",
      plan: "personal",
      status: "active",
      externalCustomerId: "cus_supporter",
      externalSubscriptionId: null,
      currentPeriodEnd: null,
      includedSeats: null,
      extraSeats: 0,
      permanentPersonal: true,
      planGatingEnabled: true,
    });
  });

  it("parses Stripe webhook events", () => {
    const event = parseStripeEvent({
      id: "evt_123",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", object: "subscription" } },
    });

    expect(event).toEqual({
      id: "evt_123",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", object: "subscription" } },
    });
  });

  it("extracts subscription objects from Stripe event payloads", () => {
    const subscription = subscriptionFromStripeObject({
      id: "sub_1",
      object: "subscription",
      status: "active",
      current_period_end: 1_735_689_600,
      customer: "cus_1",
      metadata: { workspace_id: "ws-1", plan: "personal" },
    });

    expect(subscription?.id).toBe("sub_1");
  });
});
