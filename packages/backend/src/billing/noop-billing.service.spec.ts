import { describe, expect, it, vi } from "vitest";

import { BillingUnavailableError } from "@slugbase/shared-types";

import { NoopBillingService } from "./noop-billing.service.js";

describe("NoopBillingService", () => {
  it("reports billing as unavailable", () => {
    const service = new NoopBillingService();
    expect(service.isAvailable()).toBe(false);
  });

  it("does not enforce plan gating - grants unlimited entitlements", () => {
    const service = new NoopBillingService();
    expect(service.isPlanGatingEnabled()).toBe(false);
  });

  it("returns unrestricted subscription state", async () => {
    const service = new NoopBillingService();
    const state = await service.getSubscriptionState({ workspaceId: "ws-1" });

    expect(state).toMatchObject({
      workspaceId: "ws-1",
      planGatingEnabled: false,
      status: "none",
      externalCustomerId: null,
      externalSubscriptionId: null,
    });
  });

  it("rejects checkout with BillingUnavailableError", async () => {
    const service = new NoopBillingService();
    await expect(
      service.createCheckoutSession({
        workspaceId: "ws-1",
        plan: "personal",
        mode: "recurring",
        priceId: "price_test",
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
      }),
    ).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it("rejects cancel with BillingUnavailableError", async () => {
    const service = new NoopBillingService();
    await expect(
      service.cancelSubscription({
        workspaceId: "ws-1",
        externalCustomerId: "cus_test",
        externalSubscriptionId: "sub_test",
      }),
    ).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it("acknowledges async events without updating state", async () => {
    const service = new NoopBillingService();
    const warnSpy = vi.spyOn(service["logger"], "warn");

    const result = await service.handleAsyncEvent({
      eventId: "evt_noop_1",
      payload: { type: "customer.subscription.updated" },
    });

    expect(result).toEqual({ processed: true, stateUpdated: false });
    expect(warnSpy).toHaveBeenCalledWith(
      "Billing provider not configured - ignoring async event",
      expect.objectContaining({ eventId: "evt_noop_1" }),
    );
  });

  it("returns an empty invoice list without error", async () => {
    const service = new NoopBillingService();
    const result = await service.listInvoices({
      workspaceId: "ws-1",
      externalCustomerId: "cus_test",
      page: 1,
      pageSize: 20,
    });

    expect(result).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  });
});
