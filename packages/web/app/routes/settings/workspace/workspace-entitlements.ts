import { isPlanGatingEnabled } from "../../../lib/billing-config.js";
import type { WorkspaceListItem } from "../../../components/workspace-switcher/workspace-switcher-api.js";
import type { WorkspaceMemberRole, WorkspaceSectionId, WorkspaceSummary } from "./workspace.types.js";

export function canManageWorkspaceSettings(role: WorkspaceMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function resolveActiveWorkspaceRole(
  workspaceId: string,
  workspaces: WorkspaceListItem[],
): WorkspaceMemberRole {
  const match = workspaces.find((workspace) => workspace.id === workspaceId);
  return match?.role ?? "MEMBER";
}

/** Plan grants AI suggestions on hosted; CE bypasses plan gating (spec §11.2, §12.4). */
export function hasAiSuggestionsEntitlement(plan: WorkspaceSummary["plan"]): boolean {
  if (!isPlanGatingEnabled()) {
    return true;
  }
  return plan === "personal" || plan === "team";
}

export function isWorkspaceSectionVisible(_section: WorkspaceSectionId): boolean {
  return true;
}

export function listVisibleWorkspaceSections(): WorkspaceSectionId[] {
  return ["general", "ai"];
}
