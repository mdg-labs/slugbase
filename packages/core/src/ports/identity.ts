import type { Port } from "./port.ts";

/** A provider the sign-in page can offer: its slug and the name shown on its button. */
export interface IdentityProviderInfo {
  readonly id: string;
  readonly displayName: string;
}

/**
 * An OIDC provider the operator configured through the `OIDC_<SLUG>_*` keys (doc 02 section 2.8). The slug is
 * the lower-cased `<SLUG>` with its underscores written as hyphens. `clientSecret` is a secret: it is never
 * logged and never leaves the process.
 */
export interface IdentityProviderConfig {
  readonly slug: string;
  /** The name of the provider's button; the slug when the operator gave none. */
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The issuer exactly as configured: the discovery document must name this very string. */
  readonly issuerUrl: string;
  readonly scopes: readonly string[];
  readonly autoCreate: boolean;
  /** Lower-case email domains an auto-created account may have; empty allows any. */
  readonly allowedDomains: readonly string[];
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

/**
 * Lists the OIDC providers, runs the handshake and maps the claims (doc 01 section 6). `listProviders` answers
 * the enabled providers that are available right now and never rejects: a provider that cannot be reached is
 * left out and the others are listed (D22).
 */
export interface IdentityPort extends Port {
  listProviders(): Promise<readonly IdentityProviderInfo[]>;
  begin(request: IdentityBeginRequest): Promise<{ readonly authorizationUrl: string }>;
  complete(request: IdentityCompleteRequest): Promise<IdentityClaims>;
}
