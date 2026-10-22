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
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/** Narrows a code reported by an adapter to the closed list; anything it does not list is `billing_unavailable`. */
export function toBillingErrorCode(code: string): BillingErrorCode {
  return BILLING_ERROR_CODES.find((known) => known === code) ?? "billing_unavailable";
}

/**
 * Thrown by a configured adapter when an operation fails for a reason of the list. The message is fixed text:
 * it never carries the adapter's own wording or a value of the billing side. A code outside the list reaches
 * the caller as `billing_unavailable`, so a caller handles a closed set.
 */
export class BillingError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: string) {
    super("The billing operation failed");
    this.name = "BillingError";
    this.code = toBillingErrorCode(code);
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

export interface BillingPlan {
  readonly code: string;
  readonly minQuantity: number;
  /** Null when the plan has no upper bound. */
  readonly maxQuantity: number | null;
  readonly prices: readonly BillingPlanPrice[];
  /** False while checkouts are paused for this plan. */
  readonly checkoutOpen: boolean;
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

/** The evidence that the member agreed to the legal texts in force and to what the operation does. */
export interface BillingConsent {
  readonly legal: readonly BillingLegalAcceptance[];
  /** An ISO 8601 instant. */
  readonly acceptedAt: string;
}

export interface BillingCheckoutRequest {
  readonly planCode: string;
  readonly quantity?: number;
  readonly consent: BillingConsent;
}

/** A checkout the member is sent to: the address to redirect to and the identifier of the checkout. */
export interface BillingCheckout {
  readonly id: string;
  readonly redirectUrl: string;
}

export interface BillingCheckoutState {
  readonly id: string;
  readonly status: "open" | "completed" | "expired";
}

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
  "already_subscribed" | "plan_not_available" | "quantity_below_minimum" | "mandate_required" | "checkout_paused" | "plan_checkout_paused"
>;

export interface BillingQuote {
  readonly tax: BillingTaxBreakdown;
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
  "subscription_not_changeable" | "renewal_pending" | "plan_not_available" | "quantity_below_minimum" | "quantity_below_members"
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
  /** An ISO 8601 instant. */
  readonly nextChargeDate: string;
  /** Null unless the change starts a new billing period. */
  readonly newPeriod: BillingPeriod | null;
}

/**
 * When a quantity or plan change takes effect. Without options it takes effect at the end of the period; an
 * immediate one carries the consent evidence and the charge of the preview the member saw, and is refused with
 * `charge_changed` when the charge is no longer that one.
 */
export type BillingChangeOptions =
  | { readonly timing: "period_end" }
  | { readonly timing: "immediate"; readonly consent: BillingConsent; readonly expectedCharge: BillingMoney };

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

export interface BillingDetails {
  readonly name: string;
  readonly email: string;
  readonly address: BillingAddress;
  readonly taxId?: string;
}

/** The subscription with what the next charge will be. */
export interface BillingSubscriptionDetails extends BillingSubscription {
  readonly unitAmount: BillingMoney;
  /** An ISO 8601 instant; null while the subscription is ending. */
  readonly nextChargeDate: string | null;
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

export interface BillingWithdrawal {
  readonly contractId: string;
  /** The member's statement of withdrawal, as written. */
  readonly declaration: string;
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
  listDocuments(scope: BillingScope, cursor?: string): Promise<BillingPage<BillingDocument>>;
  documentPdf(scope: BillingScope, id: string): Promise<BillingDocumentPdf>;
  receiveEvent(delivery: BillingEventDelivery): Promise<BillingEventOutcome>;
}
