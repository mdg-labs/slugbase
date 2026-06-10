/**
 * Billing interface contract (spec §11.4, §12.3).
 *
 * The application depends only on this contract; implementations are selected
 * by configuration at module init. The no-op default grants full entitlements
 * on self-hosted installs — checkout, portal, and payment flows are unavailable.
 * Application logic checks entitlements, never the billing provider directly.
 */

export type BillingPlan = "free" | "personal" | "team";

/** Billing interval for recurring subscriptions (spec §12.1). */
export type BillingInterval = "monthly" | "annual";

export type BillingSubscriptionStatus =
  | "none"
  | "active"
  | "past_due"
  | "cancelled"
  | "trialing";

/** Recurring subscription checkout or one-time supporter purchase. */
export type BillingCheckoutMode = "recurring" | "one_time";

export interface BillingCheckoutRequest {
  workspaceId: string;
  plan: Exclude<BillingPlan, "free">;
  mode: BillingCheckoutMode;
  /** Config-driven Stripe price id (spec §12.1 — not hard-coded in app logic). */
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** Existing Stripe customer id when the workspace is already linked. */
  externalCustomerId?: string | null;
}

export interface BillingCheckoutSession {
  checkoutUrl: string;
  sessionId: string;
}

export interface BillingPortalRequest {
  workspaceId: string;
  returnUrl: string;
  externalCustomerId: string;
}

export interface BillingPortalSession {
  portalUrl: string;
}

export interface BillingSubscriptionLookup {
  workspaceId: string;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
}

export interface BillingSubscriptionState {
  workspaceId: string;
  plan: BillingPlan;
  status: BillingSubscriptionStatus;
  /** Billing interval for the current subscription; null for free/permanent-permanent plans. */
  billingInterval: BillingInterval | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  /** Included seats for Team; null when not applicable. */
  includedSeats: number | null;
  extraSeats: number;
  /** Supporter / lifetime purchase — Personal entitlement permanently (spec §12.1). */
  permanentPersonal: boolean;
  /** False on self-host no-op — entitlements engine bypasses plan limits. */
  planGatingEnabled: boolean;
}

export interface BillingSeatQuantityRequest {
  workspaceId: string;
  externalSubscriptionId: string;
  /** Total seats (included base + purchased extras). */
  totalSeats: number;
  /** Current workspace member count — seat floor enforcement (spec §12.2). */
  currentMemberCount: number;
}

export interface BillingAsyncEvent {
  /** Provider event id for idempotent processing. */
  eventId: string;
  /** Raw provider webhook payload. */
  payload: unknown;
}

export interface BillingEventResult {
  /** True when the event was recognized (including duplicates). */
  processed: boolean;
  /** True when workspace entitlements should be refreshed from subscription state. */
  stateUpdated: boolean;
  subscriptionState?: BillingSubscriptionState;
}

export interface BillingService {
  /**
   * Returns true when an external billing provider is configured (hosted Stripe).
   * Self-host no-op reports false — full entitlements apply via the entitlements engine.
   */
  isAvailable(): boolean;

  /** Alias for plan-gating selection — false on self-host no-op (spec §11.5). */
  isPlanGatingEnabled(): boolean;

  /**
   * Starts a hosted checkout for a plan purchase or change.
   * Throws {@link BillingUnavailableError} when billing is not configured.
   */
  createCheckoutSession(request: BillingCheckoutRequest): Promise<BillingCheckoutSession>;

  /**
   * Opens a self-service billing portal session.
   * Throws {@link BillingUnavailableError} when billing is not configured.
   */
  createPortalSession(request: BillingPortalRequest): Promise<BillingPortalSession>;

  /**
   * Returns the current subscription/plan state for a workspace.
   * No-op returns unrestricted state with plan gating disabled.
   */
  getSubscriptionState(lookup: BillingSubscriptionLookup): Promise<BillingSubscriptionState>;

  /**
   * Adjusts purchased seat quantity on an active Team subscription.
   * Throws {@link BillingSeatFloorError} when totalSeats &lt; currentMemberCount.
   * Throws {@link BillingUnavailableError} when billing is not configured.
   */
  updateSeatQuantity(request: BillingSeatQuantityRequest): Promise<BillingSubscriptionState>;

  /**
   * Processes an asynchronous billing event idempotently.
   * No-op acknowledges events without mutating state.
   */
  handleAsyncEvent(event: BillingAsyncEvent): Promise<BillingEventResult>;
}

export class BillingUnavailableError extends Error {
  constructor(message = "Billing is not available on this deployment") {
    super(message);
    this.name = "BillingUnavailableError";
  }
}

export class BillingSeatFloorError extends Error {
  constructor(
    public readonly requestedSeats: number,
    public readonly currentMemberCount: number,
  ) {
    super(
      `Seat quantity (${String(requestedSeats)}) cannot be below current member count (${String(currentMemberCount)})`,
    );
    this.name = "BillingSeatFloorError";
  }
}

export class BillingProviderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BillingProviderError";
  }
}
