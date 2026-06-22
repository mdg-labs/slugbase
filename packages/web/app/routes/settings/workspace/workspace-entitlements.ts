import type {
  WorkspaceInterfaceConfig,
  WorkspaceMemberRole,
  WorkspaceSectionId,
} from "./workspace.types.js";

export function canManageWorkspaceSettings(role: WorkspaceMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function isOperatorManagedGateSection(
  section: "smtp" | "oidc",
  config: WorkspaceInterfaceConfig,
): boolean {
  if (section === "smtp") return !config.mailAdminUi;
  return !config.oidcAdminUi;
}

/** Self-hosted CE shows gate-only SMTP/OIDC nav; hosted Cloud hides them when operator-managed. */
function showsOperatorManagedNav(
  section: "smtp" | "oidc",
  config: WorkspaceInterfaceConfig,
): boolean {
  return isOperatorManagedGateSection(section, config) && !config.billingEnabled;
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
      return config.mailAdminUi || showsOperatorManagedNav("smtp", config);
    case "oidc":
      return config.oidcAdminUi || showsOperatorManagedNav("oidc", config);
  }
}

export function isOperatorManagedWorkspaceSection(
  section: WorkspaceSectionId,
  config: WorkspaceInterfaceConfig,
): boolean {
  if (section === "smtp" || section === "oidc") {
    return isOperatorManagedGateSection(section, config);
  }
  return false;
}

export function listVisibleWorkspaceSections(
  config: WorkspaceInterfaceConfig,
): WorkspaceSectionId[] {
  const sections: WorkspaceSectionId[] = ["general"];
  if (isWorkspaceSectionVisible("smtp", config)) {
    sections.push("smtp");
  }
  sections.push("ai");
  if (isWorkspaceSectionVisible("oidc", config)) {
    sections.push("oidc");
  }
  return sections;
}
