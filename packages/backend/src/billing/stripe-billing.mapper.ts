import type {
  BillingInterval,
  BillingInvoice,
  BillingInvoiceStatus,
  BillingPlan,
  BillingSubscriptionState,
  BillingSubscriptionStatus,
} from "@slugbase/shared-types";

/** Stripe subscription shape used by the billing mapper (subset of Stripe SDK types). */
export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  /** Present on pre-Basil API responses; removed from Subscription in Basil/Clover webhooks. */
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: {
    data?: Array<{
      id?: string;
      quantity?: number | null;
      /** Basil/Clover: period end lives on SubscriptionItem when absent at subscription level. */
      current_period_end?: number;
      price?: {
        metadata?: Record<string, string>;
        recurring?: { interval?: string; usage_type?: string } | null;
      } | null;
    }>;
  };
}

/**
 * Resolves subscription period end from top-level field or item-level fields (Basil/Clover).
 * Uses the maximum item period end when multiple items differ (multi-interval future).
 */
export function resolveSubscriptionCurrentPeriodEnd(
  subscription: Pick<StripeSubscriptionLike, "current_period_end" | "items">,
): number | null {
  if (typeof subscription.current_period_end === "number") {
    return subscription.current_period_end;
  }

  const itemPeriodEnds = (subscription.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((periodEnd): periodEnd is number => typeof periodEnd === "number");

  if (itemPeriodEnds.length === 0) {
    return null;
  }

  return Math.max(...itemPeriodEnds);
}

export interface StripeCheckoutSessionLike {
  id: string;
  url: string | null;
}

export interface StripePortalSessionLike {
  url: string;
}

export interface StripePriceLike {
  id: string;
  unit_amount: number | null;
  currency: string;
  type: "recurring" | "one_time";
  recurring: { interval: string } | null;
}

export interface StripeEventLike {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

const STRIPE_STATUS_MAP: Record<string, BillingSubscriptionStatus> =
  {
    active: "active",
    past_due: "past_due",
    canceled: "cancelled",
    cancelled: "cancelled",
    trialing: "trialing",
    incomplete: "none",
    incomplete_expired: "cancelled",
    unpaid: "past_due",
    paused: "cancelled",
  };

function resolveCustomerId(customer: string | { id: string }): string {
  return typeof customer === "string" ? customer : customer.id;
}

function readPlanMetadata(metadata: Record<string, string> | undefined): BillingPlan {
  const raw = metadata?.plan?.toLowerCase();
  if (raw === "personal" || raw === "team") {
    return raw;
  }
  return "free";
}

function isPermanentPersonal(metadata: Record<string, string> | undefined): boolean {
  return metadata?.permanent_personal === "true" || metadata?.supporter === "true";
}

function readBillingInterval(
  priceMetadata: Record<string, string> | undefined,
  priceRecurringInterval: string | undefined,
): BillingInterval | null {
  const meta = priceMetadata?.billing_interval;
  if (meta === "monthly" || meta === "annual") return meta;
  if (priceRecurringInterval === "month") return "monthly";
  if (priceRecurringInterval === "year") return "annual";
  return null;
}

/**
 * Maps a Stripe subscription object to the product billing state contract.
 */
export function mapStripeSubscriptionToState(
  workspaceId: string,
  subscription: StripeSubscriptionLike,
): BillingSubscriptionState {
  const metadata = subscription.metadata ?? {};
  const firstItem = subscription.items?.data?.[0];
  const priceMetadata = firstItem?.price?.metadata ?? {};
  const mergedMetadata = { ...priceMetadata, ...metadata };

  const plan = readPlanMetadata(mergedMetadata);
  const quantity = firstItem?.quantity ?? 1;
  // Pure per-seat model: subscription quantity IS the total seat count.
  // extraSeats carries the full quantity for team plans (includedSeats removed).
  const includedSeats = null;
  const extraSeats = plan === "team" ? quantity : 0;
  const billingInterval = readBillingInterval(
    priceMetadata,
    firstItem?.price?.recurring?.interval,
  );

  let status = STRIPE_STATUS_MAP[subscription.status] ?? "none";
  if (subscription.cancel_at_period_end && status === "active") {
    status = "cancelled";
  }

  const currentPeriodEndUnix = resolveSubscriptionCurrentPeriodEnd(subscription);

  return {
    workspaceId,
    plan,
    status,
    billingInterval,
    externalCustomerId: resolveCustomerId(subscription.customer),
    externalSubscriptionId: subscription.id,
    currentPeriodEnd:
      currentPeriodEndUnix !== null ? new Date(currentPeriodEndUnix * 1000) : null,
    includedSeats,
    extraSeats,
    permanentPersonal: isPermanentPersonal(mergedMetadata),
    planGatingEnabled: true,
  };
}

/**
 * Maps a one-time checkout completion to Personal-permanent supporter state (spec §12.1).
 */
export function mapSupporterCheckoutToState(
  workspaceId: string,
  customerId: string,
): BillingSubscriptionState {
  return {
    workspaceId,
    plan: "personal",
    status: "active",
    billingInterval: null,
    externalCustomerId: customerId,
    externalSubscriptionId: null,
    currentPeriodEnd: null,
    includedSeats: null,
    extraSeats: 0,
    permanentPersonal: true,
    planGatingEnabled: true,
  };
}

export function parseStripeEvent(payload: unknown): StripeEventLike | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string") return null;
  if (typeof record.data !== "object" || record.data === null) return null;
  const data = record.data as Record<string, unknown>;
  if (typeof data.object !== "object" || data.object === null) return null;
  return {
    id: record.id,
    type: record.type,
    data: { object: data.object as Record<string, unknown> },
  };
}

export const EXPECTED_PRODUCT_MARKER = "slugbase";

/**
 * Reads the product marker from a parsed Stripe event payload.
 * Checks both session-level and object-level metadata for the marker.
 * Returns the marker string if found, or null if absent.
 */
export function readProductMarker(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.data !== "object" || record.data === null) return null;
  const data = record.data as Record<string, unknown>;
  if (typeof data.object !== "object" || data.object === null) return null;
  const obj = data.object as Record<string, unknown>;
  const metadata =
    typeof obj.metadata === "object" && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>)
      : undefined;
  const product = metadata?.product;
  return typeof product === "string" && product.length > 0 ? product : null;
}

export function readWorkspaceIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const workspaceId = metadata?.workspace_id ?? metadata?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
}

export function subscriptionFromStripeObject(
  object: Record<string, unknown>,
): StripeSubscriptionLike | null {
  if (typeof object.id !== "string") return null;
  if (object.object !== "subscription") return null;
  if (typeof object.status !== "string") return null;
  if (object.customer === undefined || object.customer === null) return null;

  const subscription = object as unknown as StripeSubscriptionLike;
  if (resolveSubscriptionCurrentPeriodEnd(subscription) === null) return null;

  return subscription;
}

export function checkoutSessionFromStripeObject(
  object: Record<string, unknown>,
): { customerId: string; workspaceId: string | null; mode: string } | null {
  if (object.object !== "checkout.session") return null;
  const customer = object.customer;
  if (typeof customer !== "string" || customer.length === 0) return null;
  const metadata =
    typeof object.metadata === "object" && object.metadata !== null
      ? (object.metadata as Record<string, unknown>)
      : undefined;
  const mode = typeof object.mode === "string" ? object.mode : "";
  return {
    customerId: customer,
    workspaceId: readWorkspaceIdFromMetadata(metadata),
    mode,
  };
}

/** Stripe invoice shape used by the billing mapper (subset of Stripe SDK types). */
export interface StripeInvoiceLike {
  id: string;
  created: number;
  description: string | null;
  total: number;
  currency: string;
  status: string | null;
  invoice_pdf: string | null;
  lines?: {
    data?: Array<{
      description?: string | null;
    }>;
  };
}

export interface StripeInvoiceListLike {
  data: StripeInvoiceLike[];
  has_more: boolean;
}

function mapStripeInvoiceStatus(status: string | null): BillingInvoiceStatus {
  switch (status) {
    case "draft":
    case "open":
    case "paid":
    case "uncollectible":
    case "void":
      return status;
    default:
      return "open";
  }
}

function resolveInvoiceDescription(invoice: StripeInvoiceLike): string {
  if (invoice.description && invoice.description.trim().length > 0) {
    return invoice.description.trim();
  }
  const lineDescription = invoice.lines?.data?.find(
    (line) => typeof line.description === "string" && line.description.trim().length > 0,
  )?.description;
  return lineDescription?.trim() ?? "";
}

export function mapStripeInvoiceToBillingInvoice(invoice: StripeInvoiceLike): BillingInvoice {
  return {
    id: invoice.id,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    description: resolveInvoiceDescription(invoice),
    amount: invoice.total,
    currency: invoice.currency.toLowerCase(),
    status: mapStripeInvoiceStatus(invoice.status),
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  };
}
