import { describe, expect, it } from "vitest";

import {
  mapStripeSubscriptionToState,
  mapSupporterCheckoutToState,
  parseStripeEvent,
  readProductMarker,
  resolveSubscriptionCurrentPeriodEnd,
  subscriptionFromStripeObject,
} from "./stripe-billing.mapper.js";

describe("stripe-billing.mapper", () => {
  it("maps an active Team subscription with pure per-seat model", () => {
    const state = mapStripeSubscriptionToState("ws-team", {
      id: "sub_team_1",
      customer: "cus_team_1",
      status: "active",
      current_period_end: 1_735_689_600,
      metadata: { workspace_id: "ws-team", plan: "team" },
      items: {
        data: [{ id: "si_1", quantity: 7, price: { metadata: { plan: "team" } } }],
      },
    });

    expect(state).toMatchObject({
      workspaceId: "ws-team",
      plan: "team",
      status: "active",
      billingInterval: null,
      externalCustomerId: "cus_team_1",
      externalSubscriptionId: "sub_team_1",
      includedSeats: null,
      extraSeats: 7,
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

  it("detects billingInterval from price recurring.interval", () => {
    const monthly = mapStripeSubscriptionToState("ws-monthly", {
      id: "sub_m",
      customer: "cus_m",
      status: "active",
      current_period_end: 1_735_689_600,
      metadata: { plan: "personal" },
      items: {
        data: [{
          id: "si_m",
          quantity: 1,
          price: {
            metadata: { plan: "personal" },
            recurring: { interval: "month" },
          },
        }],
      },
    });
    expect(monthly.billingInterval).toBe("monthly");

    const annual = mapStripeSubscriptionToState("ws-annual", {
      id: "sub_a",
      customer: "cus_a",
      status: "active",
      current_period_end: 1_735_689_600,
      metadata: { plan: "team" },
      items: {
        data: [{
          id: "si_a",
          quantity: 5,
          price: {
            metadata: { plan: "team" },
            recurring: { interval: "year" },
          },
        }],
      },
    });
    expect(annual.billingInterval).toBe("annual");
  });

  it("detects billingInterval from price metadata when recurring is absent", () => {
    const state = mapStripeSubscriptionToState("ws-meta", {
      id: "sub_meta",
      customer: "cus_meta",
      status: "active",
      current_period_end: 1_735_689_600,
      metadata: { plan: "personal" },
      items: {
        data: [{
          id: "si_meta",
          quantity: 1,
          price: { metadata: { plan: "personal", billing_interval: "annual" } },
        }],
      },
    });
    expect(state.billingInterval).toBe("annual");
  });

  it("maps supporter checkout to Personal-permanent state", () => {
    const state = mapSupporterCheckoutToState("ws-supporter", "cus_supporter");

    expect(state).toEqual({
      workspaceId: "ws-supporter",
      plan: "personal",
      status: "active",
      billingInterval: null,
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

  it("accepts Basil/Clover subscriptions with item-level current_period_end only", () => {
    const basilPayload = {
      id: "sub_1TkRXdL40gJO1frU1RI4uYNB",
      object: "subscription",
      status: "active",
      customer: "cus_team_1",
      metadata: {
        workspace_id: "6552ebd3-c418-4005-9677-3047f885c86e",
        plan: "team",
        product: "slugbase",
      },
      items: {
        data: [
          {
            id: "si_basil",
            quantity: 5,
            current_period_end: 1_813_508_084,
            price: { metadata: { plan: "team" } },
          },
        ],
      },
    };

    const subscription = subscriptionFromStripeObject(basilPayload);
    expect(subscription).not.toBeNull();
    if (!subscription) return;
    expect(subscription.id).toBe("sub_1TkRXdL40gJO1frU1RI4uYNB");

    const state = mapStripeSubscriptionToState(
      "6552ebd3-c418-4005-9677-3047f885c86e",
      subscription,
    );
    expect(state).toMatchObject({
      workspaceId: "6552ebd3-c418-4005-9677-3047f885c86e",
      plan: "team",
      status: "active",
      extraSeats: 5,
    });
    expect(state.currentPeriodEnd).toEqual(new Date(1_813_508_084 * 1000));
  });

  it("resolveSubscriptionCurrentPeriodEnd prefers top-level over items", () => {
    expect(
      resolveSubscriptionCurrentPeriodEnd({
        current_period_end: 100,
        items: { data: [{ current_period_end: 200 }] },
      }),
    ).toBe(100);
  });

  it("resolveSubscriptionCurrentPeriodEnd uses max item period end when top-level absent", () => {
    expect(
      resolveSubscriptionCurrentPeriodEnd({
        items: {
          data: [
            { current_period_end: 100 },
            { current_period_end: 250 },
          ],
        },
      }),
    ).toBe(250);
  });

  it("returns null for subscriptions with no resolvable period end", () => {
    expect(
      subscriptionFromStripeObject({
        id: "sub_no_period",
        object: "subscription",
        status: "active",
        customer: "cus_1",
      }),
    ).toBeNull();
  });

  describe("readProductMarker", () => {
    it("returns the product marker from object metadata", () => {
      const marker = readProductMarker({
        id: "evt_1",
        type: "customer.subscription.updated",
        data: {
          object: {
            metadata: { product: "slugbase", plan: "personal" },
          },
        },
      });
      expect(marker).toBe("slugbase");
    });

    it("returns null when metadata has no product key", () => {
      const marker = readProductMarker({
        id: "evt_2",
        type: "customer.subscription.updated",
        data: {
          object: {
            metadata: { plan: "personal" },
          },
        },
      });
      expect(marker).toBeNull();
    });

    it("returns null for null or undefined payload", () => {
      expect(readProductMarker(null)).toBeNull();
      expect(readProductMarker(undefined)).toBeNull();
    });

    it("returns null for non-object payload", () => {
      expect(readProductMarker("string")).toBeNull();
      expect(readProductMarker(42)).toBeNull();
    });

    it("returns null when data.object.metadata is absent", () => {
      const marker = readProductMarker({
        id: "evt_3",
        type: "checkout.session.completed",
        data: { object: { id: "cs_1" } },
      });
      expect(marker).toBeNull();
    });
  });
});
