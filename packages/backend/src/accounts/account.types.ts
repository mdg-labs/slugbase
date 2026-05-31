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
