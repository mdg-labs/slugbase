import type { EntitlementCapability, WorkspacePlan } from "./sharing.types.js";

const PLAN_CAPABILITIES: Record<WorkspacePlan, Set<EntitlementCapability>> = {
  free: new Set(),
  personal: new Set(),
  team: new Set(["team-sharing"]),
};

export function canUseEntitlement(
  plan: WorkspacePlan,
  capability: EntitlementCapability,
): boolean {
  return PLAN_CAPABILITIES[plan].has(capability);
}

export function canUseTeamSharing(plan: WorkspacePlan): boolean {
  return canUseEntitlement(plan, "team-sharing");
}
