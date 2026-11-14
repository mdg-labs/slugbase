import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_CODES,
  BillingError,
  PortUnavailable,
  toBillingErrorCode,
  unconfigured,
  type BillingChangePreview,
  type BillingCheckoutState,
  type BillingConsent,
  type BillingContract,
  type BillingDetails,
  type BillingErrorCode,
  type BillingMoney,
  type BillingPlan,
  type BillingPort,
  type BillingPriceChangeAgreement,
  type BillingPriceChangeAgreementRecord,
  type BillingQuote,
  type BillingSubscriptionDetails,
  type BillingTaxBreakdown,
  type BillingWithdrawal,
} from "../../src/index.ts";

const SCOPE = { workspaceId: "w-1", accountId: "a-1" };
const NOW = "2026-01-01T00:00:00.000Z";
const MONEY: BillingMoney = { amountMinor: 1000, currency: "EUR" };
const TAX: BillingTaxBreakdown = { net: MONEY, lines: [], tax: { amountMinor: 0, currency: "EUR" }, gross: MONEY };
const CONSENT: BillingConsent = {
  legal: [{ code: "terms", version: "1" }],
  orderButton: { label: "Order with obligation to pay", version: "2" },
  statements: [
    { kind: "legal_acceptance", version: "1", text: "I accept the terms." },
    { kind: "immediate_performance", key: "start", version: "1", text: "Start now." },
    { kind: "statement", key: "custom", version: "3", text: "Another statement." },
  ],
  acceptedAt: NOW,
  clientAddressHash: "h-addr",
  userAgentHash: "h-agent",
};
const SUBSCRIPTION = { state: "active", planCode: "p", quantity: 1, interval: "month", periodStart: NOW, periodEnd: NOW, cancelAt: null } as const;
const DETAILS: BillingDetails = {
  kind: "company",
  companyName: "Example Co",
  name: "n",
  email: "a@example.com",
  address: { line1: "l", postalCode: "p", city: "c", country: "DE" },
  locale: "de",
};
const EXPECTED = { amount: MONEY, asOf: NOW };
const WITHDRAWAL: BillingWithdrawal = {
  contractId: "k",
  declaration: { name: "n", email: "a@example.com", text: "I withdraw.", declaredAt: NOW },
  locale: "en",
  clientAddressHash: "h-addr",
  idempotencyKey: "key-1",
};
const AGREEMENT: BillingPriceChangeAgreementRecord = { text: "I agree.", version: "1", acceptedAt: NOW, clientAddressHash: "h-addr", userAgentHash: "h-agent" };
const PLAN: BillingPlan = {
  code: "p",
  minQuantity: 1,
  maxQuantity: null,
  prices: [{ interval: "month", unitAmount: MONEY }],
  checkoutOpen: true,
  withdrawalModel: "digital_content",
  availableNow: true,
  availableUntil: NOW,
  remainingSales: 5,
  displayNote: "note",
};
const QUOTE: BillingQuote = { tax: TAX, taxNote: "reverse charge", refusal: "sales_paused_tax_limit" };
const PREVIEW: BillingChangePreview = {
  eligible: false,
  ineligibleReason: "mandate_required",
  asOf: NOW,
  creditForUnusedTime: MONEY,
  chargeForRemainingTime: MONEY,
  charge: MONEY,
  tax: TAX,
  paymentMethodLabel: "Card ending 4242",
  nextChargeDate: NOW,
  newPeriod: null,
};
const CHECKOUT_STATES: readonly BillingCheckoutState[] = [
  { id: "c", status: "completed", failureReason: null },
  { id: "c", status: "expired", failureReason: "abandoned" },
  { id: "c", status: "open", failureReason: "payment_failed" },
];
const AGREEMENTS: readonly BillingPriceChangeAgreement[] = [
  { state: "not_applicable", givenAt: null, renewalAmount: null },
  { state: "required", givenAt: null, renewalAmount: MONEY },
  { state: "given", givenAt: NOW, renewalAmount: MONEY },
];
const SUBSCRIPTION_DETAILS: BillingSubscriptionDetails = {
  ...SUBSCRIPTION,
  unitAmount: MONEY,
  nextChargeDate: NOW,
  priceChangeAgreement: AGREEMENTS[2] as BillingPriceChangeAgreement,
};
const CONTRACT: BillingContract = { id: "k", planCode: "p", startedAt: NOW, endedAt: null, withdrawable: true, withdrawnAt: null };
const CUSTOMER = { details: null };

// An adapter implementing the whole interface, as a composition's adapter does: it type-checks against
// BillingPort, so an operation removed from or added to the port fails this file's compilation.
function adapter(): BillingPort {
  return {
    available: true,
    planState: () => Promise.resolve("active"),
    plans: () => Promise.resolve([PLAN]),
    legal: () => Promise.resolve([{ code: "terms", version: "1", effectiveAt: NOW, links: [{ locale: "en", url: "https://example.com/terms" }] }]),
    quote: () => Promise.resolve(QUOTE),
    startCheckout: () => Promise.resolve({ id: "c", redirectUrl: "https://example.com/checkout" }),
    checkoutState: () => Promise.resolve(CHECKOUT_STATES[1] as BillingCheckoutState),
    previewChange: () => Promise.resolve(PREVIEW),
    changeQuantity: () => Promise.resolve(SUBSCRIPTION),
    changePlan: () => Promise.resolve(SUBSCRIPTION),
    cancel: () => Promise.resolve(SUBSCRIPTION),
    resume: () => Promise.resolve(SUBSCRIPTION),
    updatePaymentMethod: () => Promise.resolve({ redirectUrl: "https://example.com/payment" }),
    updateBillingDetails: () => Promise.resolve(CUSTOMER),
    subscriptionDetails: () => Promise.resolve(SUBSCRIPTION_DETAILS),
    customerDetails: () => Promise.resolve(CUSTOMER),
    listContracts: () => Promise.resolve({ items: [CONTRACT], nextCursor: null }),
    withdraw: () => Promise.resolve(CONTRACT),
    recordPriceChangeAgreement: () => Promise.resolve(SUBSCRIPTION_DETAILS),
    listDocuments: () => Promise.resolve({ items: [], nextCursor: null }),
    documentPdf: () => Promise.resolve({ filename: "d.pdf", content: new Uint8Array() }),
    receiveEvent: () => Promise.resolve({ eventId: "e", duplicate: false }),
  };
}

describe("BillingPort", () => {
  it("is implemented whole by an adapter, with the immediate variants taking the consent and the previewed charge with its instant", async () => {
    const billing = adapter();
    await expect(billing.changeQuantity(SCOPE, 3, { timing: "immediate", consent: CONSENT, expectedCharge: EXPECTED })).resolves.toMatchObject({ planCode: "p" });
    await expect(billing.changePlan(SCOPE, "q", { timing: "immediate", consent: CONSENT, expectedCharge: { amount: MONEY, asOf: PREVIEW.asOf } })).resolves.toMatchObject({
      planCode: "p",
    });
    await expect(billing.changePlan(SCOPE, "q", { timing: "period_end" })).resolves.toMatchObject({ planCode: "p" });
    await expect(billing.quote({ accountId: SCOPE.accountId }, { planCode: "p", interval: "year", country: "DE" })).resolves.toMatchObject({
      taxNote: "reverse charge",
      refusal: "sales_paused_tax_limit",
    });
  });

  it("carries the order evidence, the return address and the language of a checkout, and the kind of the billing details", async () => {
    const billing = adapter();
    const seen: unknown[] = [];
    billing.startCheckout = (_scope, request) => {
      seen.push(request);
      return Promise.resolve({ id: "c", redirectUrl: "https://example.com/checkout" });
    };
    billing.updateBillingDetails = (_scope, details) => {
      seen.push(details);
      return Promise.resolve({ details });
    };
    await billing.startCheckout(SCOPE, { planCode: "p", consent: CONSENT, returnUrl: "https://example.com/back", locale: "de" });
    await billing.updateBillingDetails(SCOPE, DETAILS);
    await billing.updateBillingDetails(SCOPE, { kind: "person", name: "n", email: "a@example.com", address: DETAILS.address, locale: "en" });
    expect(seen).toMatchObject([
      { returnUrl: "https://example.com/back", locale: "de", consent: { orderButton: { label: "Order with obligation to pay", version: "2" }, clientAddressHash: "h-addr", userAgentHash: "h-agent" } },
      { kind: "company", companyName: "Example Co", locale: "de" },
      { kind: "person", locale: "en" },
    ]);
  });

  it("reports the plan's withdrawal model and availability, the payment method of a change and why a checkout has not completed", async () => {
    const billing = adapter();
    await expect(billing.plans({ accountId: SCOPE.accountId })).resolves.toEqual([PLAN]);
    await expect(billing.previewChange(SCOPE, {})).resolves.toMatchObject({ ineligibleReason: "mandate_required", paymentMethodLabel: "Card ending 4242" });
    await expect(billing.checkoutState(SCOPE, "c")).resolves.toMatchObject({ status: "expired", failureReason: "abandoned" });
    expect(CHECKOUT_STATES.map((state) => state.status)).toEqual(["completed", "expired", "open"]);
  });

  it("withdraws with a structured declaration, a language, the client address hash and an idempotency key, and returns the first result for a repeated key", async () => {
    const results = new Map<string, BillingContract>();
    const billing = adapter();
    billing.withdraw = (_scope, withdrawal) => {
      const first = results.get(withdrawal.idempotencyKey);
      if (first !== undefined) return Promise.resolve(first);
      const contract = { ...CONTRACT, withdrawnAt: withdrawal.declaration.declaredAt };
      results.set(withdrawal.idempotencyKey, contract);
      return Promise.resolve(contract);
    };
    const first = await billing.withdraw(SCOPE, WITHDRAWAL);
    const second = await billing.withdraw(SCOPE, { ...WITHDRAWAL, declaration: { ...WITHDRAWAL.declaration, declaredAt: "2026-02-01T00:00:00.000Z" } });
    expect(second).toBe(first);
    expect(first.withdrawnAt).toBe(NOW);
  });

  it("reports the agreement to a later price change on the subscription and records it idempotently", async () => {
    const billing = adapter();
    let recorded: BillingSubscriptionDetails | undefined;
    billing.recordPriceChangeAgreement = (_scope, agreement) => {
      recorded ??= { ...SUBSCRIPTION_DETAILS, priceChangeAgreement: { state: "given", givenAt: agreement.acceptedAt, renewalAmount: MONEY } };
      return Promise.resolve(recorded);
    };
    const first = await billing.recordPriceChangeAgreement(SCOPE, AGREEMENT);
    const second = await billing.recordPriceChangeAgreement(SCOPE, { ...AGREEMENT, acceptedAt: "2026-02-01T00:00:00.000Z" });
    expect(second).toBe(first);
    expect(first.priceChangeAgreement).toEqual({ state: "given", givenAt: NOW, renewalAmount: MONEY });
    expect(AGREEMENTS.map((agreement) => agreement.state)).toEqual(["not_applicable", "required", "given"]);
    await expect(billing.subscriptionDetails(SCOPE)).resolves.toMatchObject({ priceChangeAgreement: { state: "given" } });
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
      billing.startCheckout(SCOPE, { planCode: "p", consent: CONSENT, returnUrl: "https://example.com/back", locale: "en" }),
      billing.checkoutState(SCOPE, "c"),
      billing.previewChange(SCOPE, {}),
      billing.changeQuantity(SCOPE, 2),
      billing.changePlan(SCOPE, "p"),
      billing.cancel(SCOPE),
      billing.resume(SCOPE),
      billing.updatePaymentMethod(SCOPE),
      billing.updateBillingDetails(SCOPE, DETAILS),
      billing.subscriptionDetails(SCOPE),
      billing.customerDetails(SCOPE),
      billing.listContracts(SCOPE),
      billing.withdraw(SCOPE, WITHDRAWAL),
      billing.recordPriceChangeAgreement(SCOPE, AGREEMENT),
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
  it("lists the closed set of codes an operation can report", () => {
    expect([...BILLING_ERROR_CODES].sort()).toEqual(
      [
        "already_subscribed",
        "billing_unavailable",
        "billing_details_incomplete",
        "charge_changed",
        "checkout_expired",
        "checkout_paused",
        "consent_required",
        "contract_terminated",
        "customer_erased",
        "eu_consumer_sales_paused",
        "idempotency_conflict",
        "legal_version_stale",
        "mandate_required",
        "plan_checkout_paused",
        "plan_not_available",
        "quantity_below_members",
        "quantity_below_minimum",
        "rate_limited",
        "renewal_pending",
        "return_url_not_allowed",
        "sales_paused_tax_limit",
        "subscription_not_changeable",
        "vat_consent_not_applicable",
        "withdrawal_not_available",
        "withdrawal_period_expired",
      ].sort(),
    );
  });

  it.each(BILLING_ERROR_CODES)("carries %s as given", (code) => {
    const error = new BillingError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BillingError");
    expect(error.code).toBe(code);
    expect(error.detail).toBeNull();
  });

  it("reaches the caller as billing_unavailable when the code is not in the list, without echoing it", () => {
    const code: BillingErrorCode = new BillingError("card_declined_by_issuer").code;
    expect(code).toBe("billing_unavailable");
    expect(new BillingError("card_declined_by_issuer").message).toBe("The billing operation failed");
    expect(toBillingErrorCode("")).toBe("billing_unavailable");
    expect(toBillingErrorCode("toString")).toBe("billing_unavailable");
  });

  it("carries the typed detail of the codes that have one", () => {
    expect(new BillingError("legal_version_stale", { current: [{ code: "terms", version: "2026-01" }, { code: "privacy", version: "3" }] }).detail).toEqual({
      code: "legal_version_stale",
      current: [
        { code: "terms", version: "2026-01" },
        { code: "privacy", version: "3" },
      ],
    });
    expect(new BillingError("consent_required", { missing: ["immediate_performance", "statement"] }).detail).toEqual({
      code: "consent_required",
      missing: ["immediate_performance", "statement"],
    });
    expect(new BillingError("withdrawal_not_available", { reason: "service_fully_performed" }).detail).toEqual({
      code: "withdrawal_not_available",
      reason: "service_fully_performed",
    });
    expect(new BillingError("vat_consent_not_applicable", { reason: "not_required" }).detail).toEqual({ code: "vat_consent_not_applicable", reason: "not_required" });
    expect(new BillingError("rate_limited", { retryAfterSeconds: 30 }).detail).toEqual({ code: "rate_limited", retryAfterSeconds: 30 });
  });

  it("drops a detail that is not whole, so only identifiers, labels, closed kinds and numbers get through", () => {
    const wording = "Card 4242 4242 was declined by the issuer, please call them";
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["legal_version_stale", { current: [{ code: "terms", version: wording }] }],
      ["legal_version_stale", { current: [{ code: "terms", version: "1" }, { code: "privacy" }] }],
      ["legal_version_stale", { current: "terms" }],
      ["consent_required", { missing: ["immediate_performance", wording] }],
      ["consent_required", { missing: wording }],
      ["withdrawal_not_available", { reason: wording }],
      ["vat_consent_not_applicable", { reason: "service_fully_performed" }],
      ["rate_limited", { retryAfterSeconds: -1 }],
      ["rate_limited", { retryAfterSeconds: 1.5 }],
      ["rate_limited", { retryAfterSeconds: "30" }],
      ["rate_limited", { retryAfterSeconds: Number.POSITIVE_INFINITY }],
      ["rate_limited", wording],
      ["rate_limited", null],
      ["rate_limited", ["30"]],
    ];
    for (const [code, detail] of cases) {
      expect(new BillingError(code, detail).detail, JSON.stringify(detail)).toBeNull();
    }
  });

  it("keeps only the fields of a detail, and ignores a detail for a code that has none", () => {
    const error = new BillingError("legal_version_stale", { current: [{ code: "terms", version: "1", note: "free text" }], note: "free text" });
    expect(error.detail).toEqual({ code: "legal_version_stale", current: [{ code: "terms", version: "1" }] });
    expect(new BillingError("plan_not_available", { reason: "not_offered", retryAfterSeconds: 3 }).detail).toBeNull();
    expect(new BillingError("card_declined_by_issuer", { retryAfterSeconds: 3 }).detail).toBeNull();
  });

  it("bounds the entries of a detail", () => {
    const many = Array.from({ length: 33 }, (_, index) => ({ code: `t${String(index)}`, version: "1" }));
    expect(new BillingError("legal_version_stale", { current: many }).detail).toBeNull();
    expect(new BillingError("legal_version_stale", { current: many.slice(0, 32) }).detail).toMatchObject({ code: "legal_version_stale" });
  });

  it("keeps the message fixed whatever the code and the detail carry", () => {
    const wording = "The card of Jane Doe was declined";
    const details: unknown[] = [undefined, wording, { reason: wording, missing: [wording], current: [{ code: wording, version: wording }], retryAfterSeconds: wording }];
    for (const code of [...BILLING_ERROR_CODES, wording]) {
      for (const detail of details) {
        const error = new BillingError(code, detail);
        expect(error.message).toBe("The billing operation failed");
        expect(JSON.stringify(error.detail)).not.toContain("Jane");
      }
    }
  });
});
