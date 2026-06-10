import type { BillingInterval, BillingPlan, BillingSubscriptionState, BillingSubscriptionStatus } from "@slugbase/shared-types";

/** Stripe subscription shape used by the billing mapper (subset of Stripe SDK types). */
export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  current_period_end: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: {
    data?: Array<{
      id?: string;
      quantity?: number | null;
      price?: {
        metadata?: Record<string, string>;
        recurring?: { interval?: string; usage_type?: string } | null;
      } | null;
    }>;
  };
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

function readIncludedSeats(metadata: Record<string, string> | undefined): number | null {
  const raw = metadata?.included_seats;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
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
  const includedSeats = plan === "team" ? readIncludedSeats(mergedMetadata) : null;
  const quantity = firstItem?.quantity ?? 1;
  const extraSeats =
    plan === "team" && includedSeats !== null ? Math.max(0, quantity - includedSeats) : 0;
  const billingInterval = readBillingInterval(
    priceMetadata,
    firstItem?.price?.recurring?.interval,
  );

  let status = STRIPE_STATUS_MAP[subscription.status] ?? "none";
  if (subscription.cancel_at_period_end && status === "active") {
    status = "cancelled";
  }

  return {
    workspaceId,
    plan,
    status,
    billingInterval,
    externalCustomerId: resolveCustomerId(subscription.customer),
    externalSubscriptionId: subscription.id,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
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
  if (typeof object.current_period_end !== "number") return null;
  if (object.customer === undefined || object.customer === null) return null;

  return object as unknown as StripeSubscriptionLike;
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
