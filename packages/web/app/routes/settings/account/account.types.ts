export const ALLOWED_ACCENT_COLORS = [
  "#7782f7",
  "#6366f1",
  "#45c98a",
  "#e6b24e",
  "#f0686b",
] as const;

export type AllowedAccentColor = (typeof ALLOWED_ACCENT_COLORS)[number];

export type AccountMfaState = "not_enrolled" | "pending" | "enrolled";

export interface DashboardChecklistManualState {
  import: boolean;
  browser_shortcut: boolean;
  folder: boolean;
  tag: boolean;
}

export interface AccountSettingsData {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  pendingEmail: string | null;
  pendingEmailMasked: string | null;
  mfaState: AccountMfaState;
  remainingBackupCodes: number | null;
  hasPassword: boolean;
  language: "en" | "de";
  theme: "light" | "dark" | "auto";
  accentColor: AllowedAccentColor | null;
  aiOptOut: boolean;
  defaultBookmarkView: "grid" | "table";
  onboardingCompletedAt: number | null;
  dashboardChecklistDismissed: boolean;
  dashboardChecklistManual: DashboardChecklistManualState;
}

export type AccountSectionId =
  | "profile"
  | "password"
  | "mfa"
  | "tokens"
  | "preferences";

export interface ApiTokenSummary {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface UpdateAccountProfileBody {
  name: string;
}

export interface UpdateAccountPasswordBody {
  currentPassword?: string;
  newPassword: string;
}

export interface UpdateAccountPreferencesBody {
  language?: "en" | "de";
  theme?: "light" | "dark" | "auto";
  accentColor?: AllowedAccentColor | null;
  aiOptOut?: boolean;
  defaultBookmarkView?: "grid" | "table";
  onboardingCompleted?: true;
  dashboardChecklistDismissed?: boolean;
  dashboardChecklistManual?: Partial<DashboardChecklistManualState>;
}

export interface UpdateAccountEmailBody {
  email: string;
}
