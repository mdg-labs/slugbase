export interface OidcProviderRecord {
  id: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  scopes: string;
  enabled: boolean;
  createdAt: Date;
}

export interface OidcAccountRecord {
  id: string;
  userId: string;
  providerId: string;
  subject: string;
  createdAt: Date;
}

export interface CreateOidcProviderData {
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  scopes?: string;
  enabled?: boolean;
}

export interface UpdateOidcProviderData {
  name?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecretEncrypted?: string;
  scopes?: string;
  enabled?: boolean;
}

export interface CreateOidcAccountData {
  userId: string;
  providerId: string;
  subject: string;
}

/** Transient OIDC flow state stored in the session — never persisted to DB */
export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  providerId: string;
}
