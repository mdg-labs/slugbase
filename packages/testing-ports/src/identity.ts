// The package builds with neither DOM nor Node typings, which is where these are declared; the runtime has them.
interface ParsedUrl {
  readonly href: string;
  readonly searchParams: {
    get(name: string): string | null;
    set(name: string, value: string): void;
  };
}
declare const URL: new (input: string) => ParsedUrl;
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const crypto: {
  getRandomValues(bytes: Uint8Array): Uint8Array;
  subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
};

// A fake OIDC provider behind the identity port (doc 08 section 3.1, doc 10 T20). `begin` records the
// authorization request, `approve` plays the person approving it at the provider and returns the address
// the provider sends the browser back to, and `complete` checks what a relying party must check before it
// trusts a claim: the code is single-use and was issued for this redirect address, the PKCE verifier fits
// the challenge, and the ID token the provider would have signed has the issuer, audience, nonce and
// expiry it must. A grant can break any of those on purpose, so a test sees what the caller does with a
// token that fails, not only with one that passes. Like the other fakes it imports no workspace package, so
// its shapes copy those of `IdentityPort` in `@slugbase/core`, and a refusal carries the same `reason`.

export interface FakeIdentityProvider {
  readonly id: string;
  readonly displayName: string;
  readonly issuer: string;
  readonly clientId: string;
}

export interface FakeIdentityBeginRequest {
  readonly providerId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface FakeIdentityCompleteRequest {
  readonly providerId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface FakeIdentityClaims {
  readonly providerId: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}

/** What the person approving at the provider is, and the faults the provider's ID token is given. */
export interface FakeIdentityGrant {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly displayName?: string;
  /** Replaces the nonce of the authorization request in the ID token: a token from another request. */
  readonly nonce?: string;
  /** Replaces the client id in the audience of the ID token: a token issued to another client. */
  readonly audience?: string;
  /** Replaces the issuer of the ID token: a token issued by another provider. */
  readonly issuer?: string;
  /** Seconds from now until the ID token expires; negative for one that already has. Five minutes by default. */
  readonly expiresInSeconds?: number;
}

export type FakeIdentityFailureReason = "provider_unavailable" | "exchange_failed" | "invalid_token";

/** What `complete` rejects with; the same `reason` words as `IdentityError` in `@slugbase/core`. */
export class FakeIdentityError extends Error {
  readonly reason: FakeIdentityFailureReason;

  constructor(reason: FakeIdentityFailureReason) {
    super("The sign-in with the identity provider failed");
    this.name = "IdentityError";
    this.reason = reason;
  }
}

export interface FakeIdentityOptions {
  readonly providers: readonly FakeIdentityProvider[];
  /** The clock, in milliseconds; defaults to the system clock. */
  readonly now?: () => number;
}

interface Authorization extends FakeIdentityBeginRequest {
  readonly grant?: FakeIdentityGrant;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64URL.charAt((chunk >> 18) & 63) + BASE64URL.charAt((chunk >> 12) & 63);
    if (i + 1 < bytes.length) out += BASE64URL.charAt((chunk >> 6) & 63);
    if (i + 2 < bytes.length) out += BASE64URL.charAt(chunk & 63);
  }
  return out;
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export class FakeIdentity {
  readonly available = true;
  readonly #providers: ReadonlyMap<string, FakeIdentityProvider>;
  readonly #now: () => number;
  readonly #authorizations = new Map<string, Authorization>();
  readonly #codes = new Map<string, Authorization & { readonly grant: FakeIdentityGrant }>();

  constructor({ providers, now = Date.now }: FakeIdentityOptions) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.#now = now;
  }

  listProviders(): Promise<readonly { readonly id: string; readonly displayName: string }[]> {
    return Promise.resolve([...this.#providers.values()].map(({ id, displayName }) => ({ id, displayName })));
  }

  begin(request: FakeIdentityBeginRequest): Promise<{ readonly authorizationUrl: string }> {
    const provider = this.#providers.get(request.providerId);
    if (provider === undefined) {
      return Promise.reject(new FakeIdentityError("provider_unavailable"));
    }
    this.#authorizations.set(request.state, request);
    const url = new URL(`${provider.issuer.replace(/\/$/, "")}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", request.state);
    url.searchParams.set("nonce", request.nonce);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return Promise.resolve({ authorizationUrl: url.href });
  }

  /**
   * The person approves the authorization request at `authorizationUrl`: returns the address the provider
   * sends the browser back to, carrying a code and the state of the request.
   */
  approve(authorizationUrl: string, grant: FakeIdentityGrant): string {
    const state = new URL(authorizationUrl).searchParams.get("state");
    const authorization = state === null ? undefined : this.#authorizations.get(state);
    if (state === null || authorization === undefined) {
      throw new Error("the authorization URL was not made by this FakeIdentity");
    }
    const code = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    this.#codes.set(code, { ...authorization, grant });
    const callback = new URL(authorization.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return callback.href;
  }

  async complete(request: FakeIdentityCompleteRequest): Promise<FakeIdentityClaims> {
    const provider = this.#providers.get(request.providerId);
    if (provider === undefined) {
      throw new FakeIdentityError("provider_unavailable");
    }
    // A code works once, whether or not the exchange succeeds.
    const issued = this.#codes.get(request.code);
    this.#codes.delete(request.code);
    if (
      issued === undefined ||
      issued.providerId !== request.providerId ||
      issued.redirectUri !== request.redirectUri ||
      (await sha256Base64Url(request.codeVerifier)) !== issued.codeChallenge
    ) {
      throw new FakeIdentityError("exchange_failed");
    }

    const { grant } = issued;
    const token = {
      iss: grant.issuer ?? provider.issuer,
      aud: grant.audience ?? provider.clientId,
      nonce: grant.nonce ?? issued.nonce,
      exp: this.#now() + (grant.expiresInSeconds ?? 300) * 1000,
    };
    if (token.iss !== provider.issuer || token.aud !== provider.clientId || token.nonce !== request.nonce || token.exp <= this.#now()) {
      throw new FakeIdentityError("invalid_token");
    }
    return {
      providerId: provider.id,
      subject: grant.subject,
      email: grant.email ?? "",
      emailVerified: grant.email !== undefined && grant.emailVerified === true,
      ...(grant.displayName === undefined ? {} : { displayName: grant.displayName }),
    };
  }
}
