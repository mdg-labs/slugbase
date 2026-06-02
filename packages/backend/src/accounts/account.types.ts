export type MfaState = "not_enrolled" | "pending" | "enrolled";

export type DefaultBookmarkView = "grid" | "table";

/** Sentinel stored for OIDC-only accounts — direct password auth must never succeed. */
export const OIDC_SENTINEL_PASSWORD_HASH = "oidc:no-password";

export interface AccountRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  language: string;
  theme: string;
  accentColor: string | null;
  defaultBookmarkView: DefaultBookmarkView;
  pendingEmail: string | null;
  isInstanceAdmin: boolean;
  mfaState: MfaState;
  mfaTotpSecretEncrypted: string | null;
  aiOptOut: boolean;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAccountData {
  email: string;
  name: string;
  passwordHash: string;
  language?: string;
  theme?: string;
  isInstanceAdmin?: boolean;
  aiOptOut?: boolean;
}

export interface CreateOidcAccountRepoData {
  email: string;
  name: string;
  emailVerified: boolean;
  language?: string;
  theme?: string;
}
