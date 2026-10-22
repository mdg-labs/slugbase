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

export interface BillingCheckoutRequest {
  readonly planCode: string;
  readonly quantity?: number;
}

/** A checkout the member is sent to: the address to redirect to and the identifier of the checkout. */
export interface BillingCheckout {
  readonly id: string;
  readonly redirectUrl: string;
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
 * Checkout, plan state, seat and plan changes, cancellation, billing documents and event intake (doc 01
 * section 6). Every operation but `receiveEvent` takes the scope it acts on first; an inbound event has no
 * principal (doc 01 section 4, `audience: 'machine'`), so the adapter derives the scope from the event it has
 * verified. An unconfigured port answers `planState` with `none` and rejects every other operation with
 * `PortUnavailable` carrying `billing_unavailable`.
 */
export interface BillingPort extends Port {
  planState(scope: BillingScope): Promise<BillingPlanState>;
  startCheckout(scope: BillingScope, request: BillingCheckoutRequest): Promise<BillingCheckout>;
  changeQuantity(scope: BillingScope, quantity: number): Promise<BillingSubscription>;
  changePlan(scope: BillingScope, planCode: string): Promise<BillingSubscription>;
  cancel(scope: BillingScope): Promise<BillingSubscription>;
  listDocuments(scope: BillingScope, cursor?: string): Promise<BillingPage<BillingDocument>>;
  documentPdf(scope: BillingScope, id: string): Promise<BillingDocumentPdf>;
  receiveEvent(delivery: BillingEventDelivery): Promise<BillingEventOutcome>;
}
