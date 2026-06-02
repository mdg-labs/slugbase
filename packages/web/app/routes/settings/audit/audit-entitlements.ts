import type { WorkspacePlanSummary } from "./audit.types.js";

/** Audit log is available on the Team plan only (spec §12.4). */
export function canAccessAuditLog(workspace: WorkspacePlanSummary): boolean {
  return workspace.plan === "team";
}
