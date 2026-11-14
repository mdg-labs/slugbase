import type { Port } from "./port.ts";

// The port of billing (doc 01 section 6, D18). It names no billing service, payment provider, price or product:
// a composition's adapter performs only the operations declared here, and a new operation is a contract change
// (doc 09 section 3.3). Application code decides on entitlements, never on billing state.

/**
 * Whose subscription an operation acts on. `Adapters.billing` is one adapter for the whole process, so every
 * operation that acts on a subscription takes the workspace and the account that owns it as its first argument,
 * as `EntitlementSource` takes the workspace it answers for.
 */
export interface BillingScope {
  readonly workspaceId: string;
  readonly accountId: string;
}

/**
 * Whom an operation acts for when no subscription is involved and no workspace need exist yet: the plan list,
 * the legal texts and a quote. A `BillingScope` satisfies it.
 */
export type BillingAccountScope = Pick<BillingScope, "accountId">;

/** An amount in the minor unit of an ISO 4217 currency. */
export interface BillingMoney {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Where a workspace stands with its subscription. `none` is the state of an instance with no billing behind it. */
export type BillingPlanState = "none" | "active" | "cancelling" | "past_due";

export type BillingInterval = "month" | "year";

/** The subscription a workspace holds. */
export interface BillingSubscription {
  readonly state: Exclude<BillingPlanState, "none">;
  readonly planCode: string;
  readonly quantity: number;
  readonly interval: BillingInterval;
  /** ISO 8601 instants. */
  readonly periodStart: string;
  readonly periodEnd: string;
  /** The instant a requested cancellation takes effect; null while none is pending. */
  readonly cancelAt: string | null;
}

/** The ways an operation can fail, a closed list; `billing_unavailable` is also what an unconfigured port reports. */
export const BILLING_ERROR_CODES = [
  "billing_unavailable",
  "already_subscribed",
  "subscription_not_changeable",
  "renewal_pending",
  "charge_changed",
  "plan_not_available",
  "quantity_below_minimum",
  "quantity_below_members",
  "mandate_required",
  "checkout_expired",
  "idempotency_conflict",
  "rate_limited",
  /** New checkouts are paused for the whole deployment. */
  "checkout_paused",
  /** Checkouts are paused for the requested plan. */
  "plan_checkout_paused",
  /** The consent names a version of a legal text that is no longer the one in force. */
  "legal_version_stale",
  /** The consent lacks a statement the operation needs. */
  "consent_required",
  /** The contract cannot be withdrawn from, for a reason of `BILLING_WITHDRAWAL_UNAVAILABLE_REASONS`. */
  "withdrawal_not_available",
  /** The period to withdraw from the contract has ended. */
  "withdrawal_period_expired",
  /** The contract has ended. */
  "contract_terminated",
  /** The customer's data has been erased. */
  "customer_erased",
  /** Sales to consumers are paused for the whole deployment. */
  "eu_consumer_sales_paused",
  /** Sales are paused because a tax threshold has been reached. */
  "sales_paused_tax_limit",
  /** The billing details lack what the operation needs. */
  "billing_details_incomplete",
  /** The address to return to is not one the billing side may send a member back to. */
  "return_url_not_allowed",
  /** The workspace holds no subscription a price-change agreement applies to, for a reason of `BILLING_PRICE_CHANGE_UNAVAILABLE_REASONS`. */
  "vat_consent_not_applicable",
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/** Narrows a code reported by an adapter to the closed list; anything it does not list is `billing_unavailable`. */
export function toBillingErrorCode(code: string): BillingErrorCode {
  return BILLING_ERROR_CODES.find((known) => known === code) ?? "billing_unavailable";
}

/** Why a contract cannot be withdrawn from. */
export const BILLING_WITHDRAWAL_UNAVAILABLE_REASONS = [
  "not_a_consumer",
  "digital_content_delivered",
  "service_fully_performed",
  "not_offered",
] as const;

export type BillingWithdrawalUnavailableReason = (typeof BILLING_WITHDRAWAL_UNAVAILABLE_REASONS)[number];

/** Why a price-change agreement does not apply. */
export const BILLING_PRICE_CHANGE_UNAVAILABLE_REASONS = ["no_subscription", "not_required", "not_a_consumer"] as const;

export type BillingPriceChangeUnavailableReason = (typeof BILLING_PRICE_CHANGE_UNAVAILABLE_REASONS)[number];

/** The kinds of statement a consent holds, besides the free `statement` kind that carries its own key. */
export const BILLING_STATEMENT_KINDS = ["legal_acceptance", "immediate_performance", "withdrawal_right_loss", "price_change_agreement", "statement"] as const;

export type BillingStatementKind = (typeof BILLING_STATEMENT_KINDS)[number];

/**
 * What a `BillingError` carries besides its code, by the code that has any. Every field is an identifier, a
 * version label, a kind from a closed list or a number: never a free-text value of the billing side.
 */
export type BillingErrorDetail =
  | {
      readonly code: "legal_version_stale";
      /** The version in force of each legal text. */
      readonly current: readonly BillingLegalAcceptance[];
    }
  | { readonly code: "consent_required"; readonly missing: readonly BillingStatementKind[] }
  | { readonly code: "withdrawal_not_available"; readonly reason: BillingWithdrawalUnavailableReason }
  | { readonly code: "vat_consent_not_applicable"; readonly reason: BillingPriceChangeUnavailableReason }
  | { readonly code: "rate_limited"; readonly retryAfterSeconds: number };

// An identifier or a version label: a short run of the characters such labels use, never a sentence.
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_DETAIL_ENTRIES = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && LABEL_PATTERN.test(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return list.find((known) => known === value) ?? null;
}

function currentVersions(value: unknown): readonly BillingLegalAcceptance[] | null {
  if (!Array.isArray(value) || value.length > MAX_DETAIL_ENTRIES) return null;
  const current: BillingLegalAcceptance[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || !isLabel(entry.code) || !isLabel(entry.version)) return null;
    current.push({ code: entry.code, version: entry.version });
  }
  return current;
}

function missingKinds(value: unknown): readonly BillingStatementKind[] | null {
  if (!Array.isArray(value) || value.length > MAX_DETAIL_ENTRIES) return null;
  const missing: BillingStatementKind[] = [];
  for (const entry of value as unknown[]) {
    const kind = oneOf(BILLING_STATEMENT_KINDS, entry);
    if (kind === null) return null;
    missing.push(kind);
  }
  return missing;
}

/**
 * Narrows the detail an adapter reports with a code to what `BillingErrorDetail` allows. Null when the code
 * carries none, or when any part of the detail is not an identifier, a version label, a kind of its closed list
 * or a non-negative integer: a detail is whole or absent, and the caller reads the code alone.
 */
export function toBillingErrorDetail(code: BillingErrorCode, detail: unknown): BillingErrorDetail | null {
  if (!isRecord(detail)) return null;
  switch (code) {
    case "legal_version_stale": {
      const current = currentVersions(detail.current);
      return current === null ? null : { code, current };
    }
    case "consent_required": {
      const missing = missingKinds(detail.missing);
      return missing === null ? null : { code, missing };
    }
    case "withdrawal_not_available": {
      const reason = oneOf(BILLING_WITHDRAWAL_UNAVAILABLE_REASONS, detail.reason);
      return reason === null ? null : { code, reason };
    }
    case "vat_consent_not_applicable": {
      const reason = oneOf(BILLING_PRICE_CHANGE_UNAVAILABLE_REASONS, detail.reason);
      return reason === null ? null : { code, reason };
    }
    case "rate_limited": {
      const seconds = detail.retryAfterSeconds;
      return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0 ? { code, retryAfterSeconds: seconds } : null;
    }
    default:
      return null;
  }
}

/**
 * Thrown by a configured adapter when an operation fails for a reason of the list. The message is fixed text:
 * it never carries the adapter's own wording or a value of the billing side. A code outside the list reaches
 * the caller as `billing_unavailable`, so a caller handles a closed set. The typed `detail` of the codes that
 * have one is narrowed to `BillingErrorDetail`; what does not fit it is dropped, never put into the message.
 */
export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly detail: BillingErrorDetail | null;

  constructor(code: string, detail?: unknown) {
    super("The billing operation failed");
    this.name = "BillingError";
    this.code = toBillingErrorCode(code);
    this.detail = toBillingErrorDetail(this.code, detail);
  }
}

/** One line of a tax breakdown. `rateBasisPoints` is the rate in hundredths of a percent. */
export interface BillingTaxLine {
  readonly label: string;
  readonly rateBasisPoints: number;
  readonly amount: BillingMoney;
}

/** What a charge is made of: the amount before tax, the tax by line, the total tax and the amount to pay. */
export interface BillingTaxBreakdown {
  readonly net: BillingMoney;
  readonly lines: readonly BillingTaxLine[];
  readonly tax: BillingMoney;
  readonly gross: BillingMoney;
}

/** What a plan costs per unit for one interval, before tax. */
export interface BillingPlanPrice {
  readonly interval: BillingInterval;
  readonly unitAmount: BillingMoney;
}

/** Which withdrawal rules a plan's contract falls under. */
export type BillingWithdrawalModel = "service" | "digital_content";

export interface BillingPlan {
  readonly code: string;
  readonly minQuantity: number;
  /** Null when the plan has no upper bound. */
  readonly maxQuantity: number | null;
  readonly prices: readonly BillingPlanPrice[];
  /** False while checkouts are paused for this plan. */
  readonly checkoutOpen: boolean;
  /** Which withdrawal rules apply to a contract of this plan. */
  readonly withdrawalModel: BillingWithdrawalModel;
  /** Whether the plan can be sold now: false outside its sales window or once it is sold out, whatever `checkoutOpen` says. */
  readonly availableNow: boolean;
  /** An ISO 8601 instant the sales window ends; null when it has no end. */
  readonly availableUntil: string | null;
  /** How many sales remain; null when the number is not limited. */
  readonly remainingSales: number | null;
  /** A note to show with the plan; null when there is none. */
  readonly displayNote: string | null;
}

/** One language's address of a legal text. */
export interface BillingLegalLink {
  /** A BCP 47 language tag. */
  readonly locale: string;
  readonly url: string;
}

/** The version in force of one legal text. */
export interface BillingLegalText {
  readonly code: string;
  readonly version: string;
  /** An ISO 8601 instant. */
  readonly effectiveAt: string;
  readonly links: readonly BillingLegalLink[];
}

/** Which version of which legal text a member accepted. */
export interface BillingLegalAcceptance {
  readonly code: string;
  readonly version: string;
}

/** The label and version of the button the member pressed to place the order. */
export interface BillingOrderButton {
  readonly label: string;
  readonly version: string;
}

/**
 * One statement the member agreed to: of a kind of the closed list, or a `statement` that carries its own key.
 * `version` is the version label of the statement and `text` the exact text the member was shown.
 */
export type BillingConsentStatement =
  | { readonly kind: Exclude<BillingStatementKind, "statement">; readonly key?: string; readonly version: string; readonly text: string }
  | { readonly kind: "statement"; readonly key: string; readonly version: string; readonly text: string };

/**
 * The evidence that the member agreed to the legal texts in force and to what the operation does. The hashes of
 * the client address and of the user agent are computed by the caller; the adapter never sees either value.
 */
export interface BillingConsent {
  readonly legal: readonly BillingLegalAcceptance[];
  readonly orderButton: BillingOrderButton;
  readonly statements: readonly BillingConsentStatement[];
  /** An ISO 8601 instant. */
  readonly acceptedAt: string;
  readonly clientAddressHash: string;
  readonly userAgentHash: string;
}

export interface BillingCheckoutRequest {
  readonly planCode: string;
  readonly quantity?: number;
  readonly consent: BillingConsent;
  /** The address the member is sent back to once the checkout ends; refused with `return_url_not_allowed` when the billing side may not use it. */
  readonly returnUrl: string;
  /** The member's language, a BCP 47 language tag. */
  readonly locale: string;
}

/** A checkout the member is sent to: the address to redirect to and the identifier of the checkout. */
export interface BillingCheckout {
  readonly id: string;
  readonly redirectUrl: string;
}

/** Why a checkout has not completed. */
export const BILLING_CHECKOUT_FAILURE_REASONS = ["payment_failed", "authentication_failed", "abandoned", "refused"] as const;

export type BillingCheckoutFailureReason = (typeof BILLING_CHECKOUT_FAILURE_REASONS)[number];

/** `failureReason` is null once the checkout completed, and while an open or expired one has no reason to report. */
export type BillingCheckoutState =
  | { readonly id: string; readonly status: "completed"; readonly failureReason: null }
  | { readonly id: string; readonly status: "open" | "expired"; readonly failureReason: BillingCheckoutFailureReason | null };

/** What `quote` is asked for: the checkout a request placed now would be. Nothing is created. */
export interface BillingQuoteRequest {
  readonly planCode: string;
  readonly quantity?: number;
  readonly interval: BillingInterval;
  /** An ISO 3166-1 alpha-2 country code. */
  readonly country: string;
  readonly taxId?: string;
}

export type BillingCheckoutRefusal = Extract<
  BillingErrorCode,
  | "already_subscribed"
  | "plan_not_available"
  | "quantity_below_minimum"
  | "mandate_required"
  | "checkout_paused"
  | "plan_checkout_paused"
  | "eu_consumer_sales_paused"
  | "sales_paused_tax_limit"
>;

export interface BillingQuote {
  readonly tax: BillingTaxBreakdown;
  /** A note on the tax to show with the quote; null when there is none. */
  readonly taxNote: string | null;
  /** Why a checkout placed now would be refused; null when it would not. */
  readonly refusal: BillingCheckoutRefusal | null;
}

/** Which change to a subscription is previewed; a field left out stays as it is. */
export interface BillingChangeRequest {
  readonly planCode?: string;
  readonly quantity?: number;
}

export type BillingChangeIneligibleReason = Extract<
  BillingErrorCode,
  | "subscription_not_changeable"
  | "renewal_pending"
  | "plan_not_available"
  | "quantity_below_minimum"
  | "quantity_below_members"
  | "mandate_required"
  | "eu_consumer_sales_paused"
  | "sales_paused_tax_limit"
>;

export interface BillingPeriod {
  /** ISO 8601 instants. */
  readonly start: string;
  readonly end: string;
}

/** What an immediate change would cost, as of the instant it was computed. */
export interface BillingChangePreview {
  readonly eligible: boolean;
  /** Why the change is not possible; null when `eligible`. */
  readonly ineligibleReason: BillingChangeIneligibleReason | null;
  /** The ISO 8601 instant the amounts were computed for. */
  readonly asOf: string;
  readonly creditForUnusedTime: BillingMoney;
  readonly chargeForRemainingTime: BillingMoney;
  /** The amount due now. */
  readonly charge: BillingMoney;
  readonly tax: BillingTaxBreakdown;
  /** The label of the payment method the charge would be made to; null when none is on file. */
  readonly paymentMethodLabel: string | null;
  /** An ISO 8601 instant. */
  readonly nextChargeDate: string;
  /** Null unless the change starts a new billing period. */
  readonly newPeriod: BillingPeriod | null;
}

/** The charge of the preview the member saw, with the instant that preview was computed for. */
export interface BillingExpectedCharge {
  readonly amount: BillingMoney;
  /** The ISO 8601 instant, as `BillingChangePreview.asOf` reports it. */
  readonly asOf: string;
}

/**
 * When a quantity or plan change takes effect. Without options it takes effect at the end of the period; an
 * immediate one carries the consent evidence and the charge of the preview the member saw, and is refused with
 * `charge_changed` when the charge or the instant it was computed for is no longer that one.
 */
export type BillingChangeOptions =
  | { readonly timing: "period_end" }
  | { readonly timing: "immediate"; readonly consent: BillingConsent; readonly expectedCharge: BillingExpectedCharge };

/** The address a member is sent to, for an action the billing side hosts. */
export interface BillingRedirect {
  readonly redirectUrl: string;
}

export interface BillingAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly postalCode: string;
  readonly city: string;
  readonly region?: string;
  /** An ISO 3166-1 alpha-2 country code. */
  readonly country: string;
}

/**
 * The billing details of a person, or of a company, which carries its name. `locale` is the member's language,
 * a BCP 47 language tag.
 */
export type BillingDetails =
  | {
      readonly kind: "person";
      readonly companyName?: never;
      readonly name: string;
      readonly email: string;
      readonly address: BillingAddress;
      readonly taxId?: string;
      readonly locale: string;
    }
  | {
      readonly kind: "company";
      readonly companyName: string;
      readonly name: string;
      readonly email: string;
      readonly address: BillingAddress;
      readonly taxId?: string;
      readonly locale: string;
    };

/**
 * Whether the member's agreement to a later price change applies and has been given. `required` and `given`
 * carry the price per renewal the agreement would apply to; `given` also carries when it was given.
 */
export type BillingPriceChangeAgreement =
  | { readonly state: "not_applicable"; readonly givenAt: null; readonly renewalAmount: null }
  | { readonly state: "required"; readonly givenAt: null; readonly renewalAmount: BillingMoney }
  | {
      readonly state: "given";
      /** An ISO 8601 instant. */
      readonly givenAt: string;
      readonly renewalAmount: BillingMoney;
    };

/** The subscription with what the next charge will be. */
export interface BillingSubscriptionDetails extends BillingSubscription {
  readonly unitAmount: BillingMoney;
  /** An ISO 8601 instant; null while the subscription is ending. */
  readonly nextChargeDate: string | null;
  readonly priceChangeAgreement: BillingPriceChangeAgreement;
}

/**
 * The record of a member's agreement to a later price change. The hashes of the client address and of the user
 * agent are computed by the caller.
 */
export interface BillingPriceChangeAgreementRecord {
  /** The exact text the member was shown. */
  readonly text: string;
  /** The version label of that text. */
  readonly version: string;
  /** An ISO 8601 instant. */
  readonly acceptedAt: string;
  readonly clientAddressHash: string;
  readonly userAgentHash: string;
}

export interface BillingCustomerDetails {
  readonly details: BillingDetails | null;
}

export interface BillingContract {
  readonly id: string;
  readonly planCode: string;
  /** ISO 8601 instants. */
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** True while the member can still withdraw from it. */
  readonly withdrawable: boolean;
  readonly withdrawnAt: string | null;
}

/** The member's statement of withdrawal. */
export interface BillingWithdrawalDeclaration {
  readonly name: string;
  readonly email: string;
  /** The statement as written. */
  readonly text: string;
  /** An ISO 8601 instant. */
  readonly declaredAt: string;
}

export interface BillingWithdrawal {
  readonly contractId: string;
  readonly declaration: BillingWithdrawalDeclaration;
  /** The member's language, a BCP 47 language tag. */
  readonly locale: string;
  /** The hash of the client address, computed by the caller. */
  readonly clientAddressHash: string;
  /** A repeated call with the same key returns the result of the first; the same key with another withdrawal is refused with `idempotency_conflict`. */
  readonly idempotencyKey: string;
}

export type BillingDocumentKind = "invoice" | "credit_note" | "cancellation_invoice";

export interface BillingDocument {
  readonly id: string;
  readonly kind: BillingDocumentKind;
  readonly number: string;
  /** An ISO 8601 instant. */
  readonly issuedAt: string;
  readonly total: BillingMoney;
}

/** One page of a listing; `nextCursor` is null on the last page. */
export interface BillingPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface BillingDocumentPdf {
  readonly filename: string;
  readonly content: Uint8Array;
}

/** A signed notification from the billing side, handed to the adapter as received so it can verify the sender. */
export interface BillingEventDelivery {
  readonly body: string;
  readonly signature: string;
  /** The timestamp the sender signed, as received. */
  readonly timestamp: string;
}

export interface BillingEventOutcome {
  readonly eventId: string;
  /** True when the event had been applied before: an event applies at most once. */
  readonly duplicate: boolean;
}

/**
 * Checkout, plan state, seat and plan changes, cancellation, contracts, billing documents and event intake (doc 01
 * section 6). `plans`, `legal` and `quote` act for an account and need no workspace; every other operation but
 * `receiveEvent` takes the `BillingScope` it acts on first. An inbound event has no principal (doc 01 section 4,
 * `audience: 'machine'`), so the adapter derives the scope from the event it has verified. A configured adapter
 * reports a failure as a `BillingError`. An unconfigured port answers `planState` with `none` and rejects every
 * other operation with `PortUnavailable` carrying `billing_unavailable`.
 */
export interface BillingPort extends Port {
  planState(scope: BillingScope): Promise<BillingPlanState>;
  plans(scope: BillingAccountScope): Promise<readonly BillingPlan[]>;
  /** The versions of the legal texts in force. */
  legal(scope: BillingAccountScope): Promise<readonly BillingLegalText[]>;
  /** Side-effect free: creates nothing, whatever it answers. */
  quote(scope: BillingAccountScope, request: BillingQuoteRequest): Promise<BillingQuote>;
  startCheckout(scope: BillingScope, request: BillingCheckoutRequest): Promise<BillingCheckout>;
  checkoutState(scope: BillingScope, id: string): Promise<BillingCheckoutState>;
  previewChange(scope: BillingScope, request: BillingChangeRequest): Promise<BillingChangePreview>;
  changeQuantity(scope: BillingScope, quantity: number, options?: BillingChangeOptions): Promise<BillingSubscription>;
  changePlan(scope: BillingScope, planCode: string, options?: BillingChangeOptions): Promise<BillingSubscription>;
  cancel(scope: BillingScope): Promise<BillingSubscription>;
  resume(scope: BillingScope): Promise<BillingSubscription>;
  updatePaymentMethod(scope: BillingScope): Promise<BillingRedirect>;
  updateBillingDetails(scope: BillingScope, details: BillingDetails): Promise<BillingCustomerDetails>;
  /** Null while the workspace holds no subscription. */
  subscriptionDetails(scope: BillingScope): Promise<BillingSubscriptionDetails | null>;
  customerDetails(scope: BillingScope): Promise<BillingCustomerDetails>;
  listContracts(scope: BillingScope, cursor?: string): Promise<BillingPage<BillingContract>>;
  withdraw(scope: BillingScope, withdrawal: BillingWithdrawal): Promise<BillingContract>;
  /**
   * Records the member's agreement to a later price change and answers the subscription as it now stands.
   * Idempotent: a second call returns the result of the first.
   */
  recordPriceChangeAgreement(scope: BillingScope, agreement: BillingPriceChangeAgreementRecord): Promise<BillingSubscriptionDetails>;
  listDocuments(scope: BillingScope, cursor?: string): Promise<BillingPage<BillingDocument>>;
  documentPdf(scope: BillingScope, id: string): Promise<BillingDocumentPdf>;
  receiveEvent(delivery: BillingEventDelivery): Promise<BillingEventOutcome>;
}
