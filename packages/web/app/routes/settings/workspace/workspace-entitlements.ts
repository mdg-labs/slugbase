import type {
  WorkspaceInterfaceConfig,
  WorkspaceMemberRole,
  WorkspaceSectionId,
} from "./workspace.types.js";

export function canManageWorkspaceSettings(role: WorkspaceMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function isWorkspaceSectionVisible(
  section: WorkspaceSectionId,
  config: WorkspaceInterfaceConfig,
): boolean {
  switch (section) {
    case "general":
    case "ai":
      return true;
    case "smtp":
      return config.mailAdminUi;
    case "oidc":
      return config.oidcAdminUi;
  }
}

export function listVisibleWorkspaceSections(
  config: WorkspaceInterfaceConfig,
): WorkspaceSectionId[] {
  const sections: WorkspaceSectionId[] = ["general", "ai"];
  if (config.mailAdminUi) {
    sections.splice(1, 0, "smtp");
  }
  if (config.oidcAdminUi) {
    sections.push("oidc");
  }
  return sections;
}
