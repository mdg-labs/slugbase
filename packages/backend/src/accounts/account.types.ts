export type MfaState = "not_enrolled" | "pending" | "enrolled";

export interface AccountRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  language: string;
  theme: string;
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
