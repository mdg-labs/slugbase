import { isPlanGatingEnabled } from "../../../lib/billing-config.js";
import type { WorkspacePlan } from "./members.types.js";

/** Team administration is Team-plan only when plan gating is enabled (spec §12.4). */
export function canAccessMembersSettings(plan: WorkspacePlan): boolean {
  if (!isPlanGatingEnabled()) {
    return true;
  }
  return plan === "team";
}

export function seatUsage(
  memberCount: number,
  pendingCount: number,
  planSeats: number | null,
): { used: number; limit: number | null; atLimit: boolean } {
  const used = memberCount + pendingCount;
  if (planSeats == null) {
    return { used, limit: null, atLimit: false };
  }
  return { used, limit: planSeats, atLimit: used >= planSeats };
}
