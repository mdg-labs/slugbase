import type { EntitlementSet, PlanId } from "@slugbase/shared-types";

import { getPlanDefinition } from "./plan-catalog.js";
import { PERSONAL_ENTITLEMENTS } from "./entitlement-sets.js";

/**
 * Resolves the entitlement set for a workspace plan.
 * Supporter purchases grant plan "personal" with permanentPersonal - same entitlements, no separate path (spec §12.1).
 */
export function resolveEntitlementsForPlan(planId: PlanId): EntitlementSet {
  return getPlanDefinition(planId).entitlements;
}

/**
 * Maps billing subscription state to entitlements.
 * permanentPersonal (supporter) uses the Personal entitlement set - not a distinct plan.
 */
export function resolveEntitlementsFromBillingState(input: {
  plan: PlanId;
  permanentPersonal?: boolean;
}): EntitlementSet {
  if (input.permanentPersonal) {
    return PERSONAL_ENTITLEMENTS;
  }
  return resolveEntitlementsForPlan(input.plan);
}
