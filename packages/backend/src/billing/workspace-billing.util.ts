import type { BillingSubscriptionState, BillingSubscriptionStatus } from "@slugbase/shared-types";

import type { WorkspacePlan, WorkspaceRecord } from "../workspaces/workspace.types.js";

const ACTIVE_BILLING_STATUSES = new Set<BillingSubscriptionStatus>([
  "active",
  "trialing",
  "past_due",
]);

/**
 * Returns true when the workspace has an unresolved paid billing relationship
 * (spec §12.3 — deletion blocked until billing is resolved).
 */
export function workspaceHasActivePaidBilling(
  workspace: Pick<
    WorkspaceRecord,
    "plan" | "billingStatus" | "permanentPersonal" | "billingSubscriptionId"
  >,
): boolean {
  if (workspace.permanentPersonal) {
    return true;
  }

  if (workspace.billingStatus && ACTIVE_BILLING_STATUSES.has(workspace.billingStatus as BillingSubscriptionStatus)) {
    return workspace.plan !== "free";
  }

  return workspace.billingSubscriptionId !== null && workspace.plan !== "free";
}

export function subscriptionStateToWorkspacePatch(
  state: BillingSubscriptionState,
): {
  plan: WorkspacePlan;
  planSeats: number | null;
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
  billingStatus: string | null;
  billingPeriodEnd: Date | null;
  permanentPersonal: boolean;
} {
  if (state.permanentPersonal) {
    return {
      plan: "personal",
      planSeats: null,
      billingCustomerId: state.externalCustomerId,
      billingSubscriptionId: null,
      billingStatus: "active",
      billingPeriodEnd: null,
      permanentPersonal: true,
    };
  }

  const isPaidActive = ACTIVE_BILLING_STATUSES.has(state.status);

  if (!isPaidActive) {
    return {
      plan: "free",
      planSeats: null,
      billingCustomerId: state.externalCustomerId,
      billingSubscriptionId: null,
      billingStatus: state.status === "none" ? null : state.status,
      billingPeriodEnd: state.currentPeriodEnd,
      permanentPersonal: false,
    };
  }

  const plan = state.plan === "free" ? "free" : state.plan;
  // Pure per-seat model: extraSeats is the subscription quantity (= total seats for team)
  const planSeats = plan === "team" ? state.extraSeats : null;

  return {
    plan,
    planSeats,
    billingCustomerId: state.externalCustomerId,
    billingSubscriptionId: state.externalSubscriptionId,
    billingStatus: state.status,
    billingPeriodEnd: state.currentPeriodEnd,
    permanentPersonal: false,
  };
}
