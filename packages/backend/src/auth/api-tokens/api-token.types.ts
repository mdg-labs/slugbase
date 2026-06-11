export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface CreateApiTokenData {
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt?: Date;
}

/** Public view of a token - never exposes the hash. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
}
