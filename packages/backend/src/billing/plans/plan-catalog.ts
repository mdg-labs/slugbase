import type { PlanDefinition, PlanId } from "@slugbase/shared-types";

import {
  FREE_ENTITLEMENTS,
  PERSONAL_ENTITLEMENTS,
  TEAM_ENTITLEMENTS,
} from "./entitlement-sets.js";

/**
 * Hosted plan catalog - maps plan ids to entitlement sets (spec §12.1, §12.2).
 * Supporter / lifetime is not a separate plan: billing grants Personal permanently.
 */
export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    displayName: "Free",
    entitlements: FREE_ENTITLEMENTS,
  },
  personal: {
    id: "personal",
    displayName: "Personal",
    entitlements: PERSONAL_ENTITLEMENTS,
  },
  team: {
    id: "team",
    displayName: "Team",
    entitlements: TEAM_ENTITLEMENTS,
  },
};

export function getPlanDefinition(planId: PlanId): PlanDefinition {
  return PLAN_CATALOG[planId];
}

export function listPlanDefinitions(): PlanDefinition[] {
  return Object.values(PLAN_CATALOG);
}
