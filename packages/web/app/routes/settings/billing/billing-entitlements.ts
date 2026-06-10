import type { BillingPlanId, BillingWorkspaceSummary } from "./billing.types.js";

export function canAccessBillingSettings(billingEnabled: boolean): boolean {
  return billingEnabled;
}

export function canManageBilling(role: "OWNER" | "ADMIN" | "MEMBER"): boolean {
  return role === "OWNER";
}

export function isSubscriptionCancelled(workspace: BillingWorkspaceSummary): boolean {
  return workspace.billingStatus === "cancelled";
}

export function hasPaidAccess(workspace: BillingWorkspaceSummary): boolean {
  if (workspace.permanentPersonal) {
    return true;
  }
  if (workspace.plan === "free") {
    return false;
  }
  if (workspace.billingStatus === "cancelled") {
    return true;
  }
  return workspace.billingStatus === "active" || workspace.billingStatus === "trialing";
}

export function effectivePlanForDisplay(workspace: BillingWorkspaceSummary): BillingPlanId {
  if (workspace.permanentPersonal) {
    return "personal";
  }
  return workspace.plan;
}

export function seatBreakdown(
  planSeats: number | null,
  memberCount: number,
): {
  total: number;
  inUse: number;
  minTotal: number;
} {
  const total = planSeats ?? memberCount;

  return {
    total,
    inUse: memberCount,
    minTotal: Math.max(total, memberCount),
  };
}

export function bookmarkMeterVariant(
  used: number,
  cap: number,
): "ok" | "warn" | "error" {
  if (used >= cap) return "error";
  if (used >= Math.floor(cap * 0.9)) return "warn";
  return "ok";
}
