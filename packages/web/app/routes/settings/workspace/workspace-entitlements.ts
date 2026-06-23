import type { WorkspaceMemberRole, WorkspaceSectionId } from "./workspace.types.js";

export function canManageWorkspaceSettings(role: WorkspaceMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function isWorkspaceSectionVisible(_section: WorkspaceSectionId): boolean {
  return true;
}

export function listVisibleWorkspaceSections(): WorkspaceSectionId[] {
  return ["general", "ai"];
}
