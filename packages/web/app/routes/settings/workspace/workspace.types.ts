export type WorkspaceMemberRole = "OWNER" | "ADMIN" | "MEMBER";

export type WorkspaceSectionId = "general" | "smtp" | "ai" | "oidc";

export interface WorkspaceSummary {
  id: string;
  name: string;
  plan: "free" | "personal" | "team";
}

export interface WorkspaceInterfaceConfig {
  mailAdminUi: boolean;
  oidcAdminUi: boolean;
  aiByoCredential: boolean;
  billingEnabled: boolean;
}

export interface MailSettingsData {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
}

export interface AiSettingsData {
  enabled: boolean;
  hasApiKey: boolean;
  model: string;
}

export interface OidcProviderSummary {
  id: string;
  name: string;
  clientId: string;
  issuerUrl: string;
  scopes: string;
  enabled: boolean;
}

export interface WorkspaceSettingsData {
  workspace: WorkspaceSummary;
  currentUserRole: WorkspaceMemberRole;
  membersForbidden: boolean;
  interfaceConfig: WorkspaceInterfaceConfig;
  appBaseUrl: string;
  mail: MailSettingsData | null;
  ai: AiSettingsData | null;
  oidcProviders: OidcProviderSummary[];
}
