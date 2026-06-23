export type WorkspaceMemberRole = "OWNER" | "ADMIN" | "MEMBER";

export type WorkspaceSectionId = "general" | "ai";

export interface WorkspaceSummary {
  id: string;
  name: string;
  plan: "free" | "personal" | "team";
}

export interface WorkspaceInterfaceConfig {
  aiByoCredential: boolean;
  billingEnabled: boolean;
}

export interface AiSettingsData {
  enabled: boolean;
  hasApiKey: boolean;
  model: string;
}

export interface WorkspaceSettingsData {
  workspace: WorkspaceSummary;
  currentUserRole: WorkspaceMemberRole;
  membersForbidden: boolean;
  interfaceConfig: WorkspaceInterfaceConfig;
  ai: AiSettingsData | null;
}
