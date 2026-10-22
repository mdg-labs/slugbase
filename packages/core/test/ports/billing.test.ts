import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_CODES,
  BillingError,
  PortUnavailable,
  toBillingErrorCode,
  unconfigured,
  type BillingConsent,
  type BillingErrorCode,
  type BillingMoney,
  type BillingPort,
  type BillingTaxBreakdown,
} from "../../src/index.ts";

const SCOPE = { workspaceId: "w-1", accountId: "a-1" };
const NOW = "2026-01-01T00:00:00.000Z";
const MONEY: BillingMoney = { amountMinor: 1000, currency: "EUR" };
const TAX: BillingTaxBreakdown = { net: MONEY, lines: [], tax: { amountMinor: 0, currency: "EUR" }, gross: MONEY };
const CONSENT: BillingConsent = { legal: [{ code: "terms", version: "1" }], acceptedAt: NOW };
const SUBSCRIPTION = { state: "active", planCode: "p", quantity: 1, interval: "month", periodStart: NOW, periodEnd: NOW, cancelAt: null } as const;
const CONTRACT = { id: "k", planCode: "p", startedAt: NOW, endedAt: null, withdrawable: true, withdrawnAt: null };
const CUSTOMER = { details: null };

// An adapter implementing the whole interface, as a composition's adapter does: it type-checks against
// BillingPort, so an operation removed from or added to the port fails this file's compilation.
function adapter(): BillingPort {
  return {
    available: true,
    planState: () => Promise.resolve("active"),
    plans: () => Promise.resolve([{ code: "p", minQuantity: 1, maxQuantity: null, prices: [{ interval: "month", unitAmount: MONEY }], checkoutOpen: true }]),
    legal: () => Promise.resolve([{ code: "terms", version: "1", effectiveAt: NOW, links: [{ locale: "en", url: "https://example.com/terms" }] }]),
    quote: () => Promise.resolve({ tax: TAX, refusal: null }),
    startCheckout: () => Promise.resolve({ id: "c", redirectUrl: "https://example.com/checkout" }),
    checkoutState: () => Promise.resolve({ id: "c", status: "open" }),
    previewChange: () =>
      Promise.resolve({
        eligible: true,
        ineligibleReason: null,
        asOf: NOW,
        creditForUnusedTime: MONEY,
        chargeForRemainingTime: MONEY,
        charge: MONEY,
        tax: TAX,
        nextChargeDate: NOW,
        newPeriod: null,
      }),
    changeQuantity: () => Promise.resolve(SUBSCRIPTION),
    changePlan: () => Promise.resolve(SUBSCRIPTION),
    cancel: () => Promise.resolve(SUBSCRIPTION),
    resume: () => Promise.resolve(SUBSCRIPTION),
    updatePaymentMethod: () => Promise.resolve({ redirectUrl: "https://example.com/payment" }),
    updateBillingDetails: () => Promise.resolve(CUSTOMER),
    subscriptionDetails: () => Promise.resolve({ ...SUBSCRIPTION, unitAmount: MONEY, nextChargeDate: NOW }),
    customerDetails: () => Promise.resolve(CUSTOMER),
    listContracts: () => Promise.resolve({ items: [CONTRACT], nextCursor: null }),
    withdraw: () => Promise.resolve(CONTRACT),
    listDocuments: () => Promise.resolve({ items: [], nextCursor: null }),
    documentPdf: () => Promise.resolve({ filename: "d.pdf", content: new Uint8Array() }),
    receiveEvent: () => Promise.resolve({ eventId: "e", duplicate: false }),
  };
}

describe("BillingPort", () => {
  it("is implemented whole by an adapter, with the immediate variants taking the consent and the previewed charge", async () => {
    const billing = adapter();
    await expect(billing.changeQuantity(SCOPE, 3, { timing: "immediate", consent: CONSENT, expectedCharge: MONEY })).resolves.toMatchObject({ planCode: "p" });
    await expect(billing.changePlan(SCOPE, "q", { timing: "period_end" })).resolves.toMatchObject({ planCode: "p" });
    await expect(billing.quote({ accountId: SCOPE.accountId }, { planCode: "p", interval: "year", country: "DE" })).resolves.toMatchObject({ refusal: null });
  });

  it("declares the same operations on the unconfigured default as on a complete adapter", () => {
    const declared = Object.keys(adapter()).sort();
    expect(Object.keys(unconfigured().billing).sort()).toEqual(declared);
  });

  it("rejects each operation of the unconfigured default with PortUnavailable carrying billing_unavailable and answers planState none", async () => {
    const { billing } = unconfigured();
    await expect(billing.planState(SCOPE)).resolves.toBe("none");
    const calls: Array<Promise<unknown>> = [
      billing.plans(SCOPE),
      billing.legal(SCOPE),
      billing.quote(SCOPE, { planCode: "p", interval: "month", country: "DE" }),
      billing.startCheckout(SCOPE, { planCode: "p", consent: CONSENT }),
      billing.checkoutState(SCOPE, "c"),
      billing.previewChange(SCOPE, {}),
      billing.changeQuantity(SCOPE, 2),
      billing.changePlan(SCOPE, "p"),
      billing.cancel(SCOPE),
      billing.resume(SCOPE),
      billing.updatePaymentMethod(SCOPE),
      billing.updateBillingDetails(SCOPE, { name: "n", email: "a@example.com", address: { line1: "l", postalCode: "p", city: "c", country: "DE" } }),
      billing.subscriptionDetails(SCOPE),
      billing.customerDetails(SCOPE),
      billing.listContracts(SCOPE),
      billing.withdraw(SCOPE, { contractId: "k", declaration: "d" }),
      billing.listDocuments(SCOPE),
      billing.documentPdf(SCOPE, "d"),
      billing.receiveEvent({ body: "{}", signature: "s", timestamp: "0" }),
    ];
    expect(calls).toHaveLength(Object.keys(billing).length - 2);
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(PortUnavailable);
      await expect(call).rejects.toMatchObject({ port: "billing", code: "billing_unavailable" });
    }
  });
});

describe("BillingError", () => {
  it("lists the closed set of codes an operation can report, including the two checkout-pause codes", () => {
    expect([...BILLING_ERROR_CODES].sort()).toEqual(
      [
        "already_subscribed",
        "billing_unavailable",
        "charge_changed",
        "checkout_expired",
        "checkout_paused",
        "idempotency_conflict",
        "mandate_required",
        "plan_checkout_paused",
        "plan_not_available",
        "quantity_below_members",
        "quantity_below_minimum",
        "rate_limited",
        "renewal_pending",
        "subscription_not_changeable",
      ].sort(),
    );
  });

  it.each(BILLING_ERROR_CODES)("carries %s as given", (code) => {
    const error = new BillingError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BillingError");
    expect(error.code).toBe(code);
  });

  it("reaches the caller as billing_unavailable when the code is not in the list, without echoing it", () => {
    const code: BillingErrorCode = new BillingError("card_declined_by_issuer").code;
    expect(code).toBe("billing_unavailable");
    expect(new BillingError("card_declined_by_issuer").message).toBe("The billing operation failed");
    expect(toBillingErrorCode("")).toBe("billing_unavailable");
    expect(toBillingErrorCode("toString")).toBe("billing_unavailable");
  });
});
