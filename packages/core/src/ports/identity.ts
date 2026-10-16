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
  /** The callback address registered with the provider; the authorization code is exchanged against the same one. */
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  /**
   * The handshake proves the member again (the `reauth` intent): the provider is asked to ask for the credentials
   * even when the browser has a session there. Absent or false for a sign-in and for linking.
   */
  readonly reauthenticate?: boolean;
}

export interface IdentityCompleteRequest {
  readonly providerId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

/**
 * The claims of a verified sign-in, mapped from the provider's. `email` is empty and `emailVerified` false
 * when the provider asserted no address.
 */
export interface IdentityClaims {
  readonly providerId: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}

/** Why a handshake did not complete; the fixed words of the log line. */
export type IdentityFailureReason = "provider_unavailable" | "exchange_failed" | "invalid_token";

/**
 * Thrown by `complete` when the handshake cannot be trusted: the provider is unknown or unavailable, the code
 * was refused, or the ID token failed validation. The message is fixed text: it never carries a token, a
 * claim, a code or an address of the provider. Callers answer every reason alike.
 */
export class IdentityError extends Error {
  readonly reason: IdentityFailureReason;

  constructor(reason: IdentityFailureReason) {
    super("The sign-in with the identity provider failed");
    this.name = "IdentityError";
    this.reason = reason;
  }
}

/**
 * Lists the OIDC providers, runs the handshake and maps the claims (doc 01 section 6). `listProviders` answers
 * the enabled providers that are available right now and never rejects: a provider that cannot be reached is
 * left out and the others are listed (D22). `complete` exchanges the code, validates the ID token (signature,
 * issuer, audience, expiry and the nonce `begin` was given) and returns its claims; it rejects with an
 * `IdentityError` for anything it cannot trust, and a claim is never returned before every check has passed.
 */
export interface IdentityPort extends Port {
  listProviders(): Promise<readonly IdentityProviderInfo[]>;
  begin(request: IdentityBeginRequest): Promise<{ readonly authorizationUrl: string }>;
  complete(request: IdentityCompleteRequest): Promise<IdentityClaims>;
}
