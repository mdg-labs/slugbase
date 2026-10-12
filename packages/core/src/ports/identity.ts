import type { Port } from "./port.js";

export interface IdentityProviderInfo {
  readonly id: string;
  readonly displayName: string;
}

export interface IdentityBeginRequest {
  readonly providerId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface IdentityCompleteRequest {
  readonly providerId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/** The claims of a verified sign-in, mapped from the provider's. */
export interface IdentityClaims {
  readonly providerId: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}

/** Lists the OIDC providers, runs the handshake and maps the claims (doc 01 section 6). */
export interface IdentityPort extends Port {
  listProviders(): Promise<readonly IdentityProviderInfo[]>;
  begin(request: IdentityBeginRequest): Promise<{ readonly authorizationUrl: string }>;
  complete(request: IdentityCompleteRequest): Promise<IdentityClaims>;
}
