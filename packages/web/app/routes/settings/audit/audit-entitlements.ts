import { isPlanGatingEnabled } from "../../../lib/billing-config.js";
import type { WorkspacePlanSummary } from "./audit.types.js";

/** Audit log is Team-plan only when plan gating is enabled (spec §12.4). */
export function canAccessAuditLog(workspace: WorkspacePlanSummary): boolean {
  if (!isPlanGatingEnabled()) {
    return true;
  }
  return workspace.plan === "team";
}
