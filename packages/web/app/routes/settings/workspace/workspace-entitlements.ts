import type { WorkspaceMemberRole, WorkspaceSectionId } from "./workspace.types.js";

export function canManageWorkspaceSettings(role: WorkspaceMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function isWorkspaceSectionVisible(section: WorkspaceSectionId): boolean {
  return section === "general" || section === "ai";
}

export function listVisibleWorkspaceSections(): WorkspaceSectionId[] {
  return ["general", "ai"];
}
