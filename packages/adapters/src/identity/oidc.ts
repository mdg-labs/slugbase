import {
  EgressError,
  IdentityError,
  type EgressPort,
  type IdentityBeginRequest,
  type IdentityClaims,
  type IdentityCompleteRequest,
  type IdentityPort,
  type IdentityProviderConfig,
  type IdentityProviderInfo,
} from "@slugbase/core";
import { IdTokenError, verifyIdToken } from "./id-token.ts";

// The OIDC providers of the operator (doc 02 section 2.8) behind the identity port. Discovery and the signing
// keys of each provider are fetched only through the egress port (T6): it resolves and validates the address
// of every request, so an endpoint the document points at a private address is refused there, and it
// enforces the time and size caps asked for below. A document is trusted only if its `issuer` is exactly the
// configured string (T20). A provider that cannot be used is left out and logged; the others stay (D22).
// The authorization-code handshake is the same adapter: `begin` builds the authorization URL with the PKCE
// challenge, the state and the nonce, and `complete` exchanges the code at the token endpoint through egress
// and returns the claims of the ID token only after id-token.ts has verified it.

/** Why a provider is unavailable; the fixed words of the log line. */
export type OidcUnavailableReason = "discovery_failed" | "issuer_mismatch" | "invalid_discovery" | "keys_failed" | "invalid_keys";

/** How the client proves itself at the token endpoint: HTTP Basic, or its credentials in the form body. */
export type OidcTokenAuthMethod = "client_secret_basic" | "client_secret_post";

/** What discovery and the key set of an available provider say, for the handshake. */
export interface OidcProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly tokenAuthMethod: OidcTokenAuthMethod;
  /** The JSON Web Keys of the provider, each with at least a `kty`. */
  readonly keys: readonly Readonly<Record<string, unknown>>[];
}

/** Where the adapter writes. The server's logger satisfies it. */
export interface OidcIdentityLogger {
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface CreateOidcIdentityOptions {
  /** The enabled providers of the operator, in the order they are listed. */
  readonly providers: readonly IdentityProviderConfig[];
  readonly egress: EgressPort;
  readonly logger: OidcIdentityLogger;
  /** How long fetched metadata is used before it is fetched again. */
  readonly cacheTtlMs?: number;
  /** How long a provider that failed stays unavailable before it is tried again. */
  readonly failureTtlMs?: number;
  /** The clock, in milliseconds; the expiry of an ID token is checked against it. */
  readonly now?: () => number;
}

export interface OidcIdentity extends IdentityPort {
  /** The metadata of an available provider, or `undefined` when the slug is unknown or the provider is unavailable. Never rejects. */
  metadata(providerId: string): Promise<OidcProviderMetadata | undefined>;
}

export const DEFAULT_CACHE_TTL_MS = 3_600_000;
export const DEFAULT_FAILURE_TTL_MS = 60_000;

const REQUEST_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BYTES = 65_536;
const KEYS_MAX_BYTES = 262_144;
const DISCOVERY_CONTENT_TYPES = ["application/json"] as const;
const KEYS_CONTENT_TYPES = ["application/json", "application/jwk-set+json"] as const;
const TOKEN_MAX_BYTES = 262_144;
const TOKEN_CONTENT_TYPES = ["application/json"] as const;

class Unavailable extends Error {
  readonly reason: OidcUnavailableReason;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(reason: OidcUnavailableReason, detail: Readonly<Record<string, unknown>> = {}) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

// Only fixed words reach the log: the code of an egress error, the name of any other error. Never a message,
// which may carry an address or a URL.
function describeFailure(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof EgressError) {
    return { code: error.code };
  }
  return error instanceof Error ? { error: error.name } : {};
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

// An absolute http or https URL with a host, no credentials and no fragment; http only when the issuer is http,
// so a document of an https issuer cannot downgrade an endpoint.
function endpoint(value: unknown, issuerIsHttps: boolean): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value) || value.includes("#")) {
    return undefined;
  }
  const url = new URL(value);
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && !issuerIsHttps);
  return allowed && url.hostname !== "" && url.username === "" && url.password === "" ? value : undefined;
}

// The method this client uses at the token endpoint: the OpenID default (Basic) unless the document lists
// methods and leaves it out, then the form body. A document that lists neither names methods this client
// cannot use.
function tokenAuthMethodOf(supported: unknown): OidcTokenAuthMethod | undefined {
  if (supported === undefined) {
    return "client_secret_basic";
  }
  if (!Array.isArray(supported)) {
    return undefined;
  }
  const methods: unknown[] = supported;
  if (methods.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  return methods.includes("client_secret_post") ? "client_secret_post" : undefined;
}

function discoveryUrl(issuer: string): string {
  return `${issuer.endsWith("/") ? issuer.slice(0, -1) : issuer}/.well-known/openid-configuration`;
}

interface Settled {
  readonly until: number;
  readonly metadata: OidcProviderMetadata | undefined;
}

interface Entry {
  readonly config: IdentityProviderConfig;
  settled?: Settled;
  inflight?: Promise<OidcProviderMetadata | undefined>;
}

/** A form value as RFC 6749 appendix B writes it, which HTTP Basic credentials are too. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replaceAll("%20", "+");
}

/**
 * The identity port over the providers the operator configured. It is available when there is one.
 */
export function createOidcIdentity(options: CreateOidcIdentityOptions): OidcIdentity {
  const { egress, logger } = options;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = options.providers.map((config): Entry => ({ config }));
  const bySlug = new Map(entries.map((entry) => [entry.config.slug, entry]));

  async function fetchJson(
    url: string,
    maxBytes: number,
    acceptContentTypes: readonly string[],
    failed: OidcUnavailableReason,
    invalid: OidcUnavailableReason,
  ): Promise<unknown> {
    let body: Uint8Array;
    try {
      const response = await egress.request({ url, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes, acceptContentTypes });
      if (response.status !== 200) {
        throw new Unavailable(failed, { status: response.status });
      }
      body = response.body;
    } catch (error) {
      throw error instanceof Unavailable ? error : new Unavailable(failed, describeFailure(error));
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    } catch {
      throw new Unavailable(invalid);
    }
  }

  async function discover(config: IdentityProviderConfig): Promise<OidcProviderMetadata> {
    const document = asObject(
      await fetchJson(discoveryUrl(config.issuerUrl), DISCOVERY_MAX_BYTES, DISCOVERY_CONTENT_TYPES, "discovery_failed", "invalid_discovery"),
    );
    if (document === undefined) {
      throw new Unavailable("invalid_discovery");
    }
    if (document["issuer"] !== config.issuerUrl) {
      throw new Unavailable("issuer_mismatch");
    }
    const issuerIsHttps = config.issuerUrl.startsWith("https:");
    const authorizationEndpoint = endpoint(document["authorization_endpoint"], issuerIsHttps);
    const tokenEndpoint = endpoint(document["token_endpoint"], issuerIsHttps);
    const jwksUri = endpoint(document["jwks_uri"], issuerIsHttps);
    const tokenAuthMethod = tokenAuthMethodOf(document["token_endpoint_auth_methods_supported"]);
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined || jwksUri === undefined || tokenAuthMethod === undefined) {
      throw new Unavailable("invalid_discovery");
    }
    const set = asObject(await fetchJson(jwksUri, KEYS_MAX_BYTES, KEYS_CONTENT_TYPES, "keys_failed", "invalid_keys"));
    const listed = set?.["keys"];
    const keys = Array.isArray(listed) ? (listed as unknown[]).map(asObject) : [];
    if (keys.length === 0 || keys.some((key) => typeof key?.["kty"] !== "string")) {
      throw new Unavailable("invalid_keys");
    }
    return {
      issuer: config.issuerUrl,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      tokenAuthMethod,
      keys: keys.flatMap((key) => (key === undefined ? [] : [key])),
    };
  }

  // Never rejects: a failure is logged and kept as the answer for the failure TTL.
  async function refresh(entry: Entry): Promise<OidcProviderMetadata | undefined> {
    try {
      const metadata = await discover(entry.config);
      entry.settled = { until: now() + cacheTtlMs, metadata };
      return metadata;
    } catch (error) {
      const detail = error instanceof Unavailable ? { reason: error.reason, ...error.detail } : { reason: "discovery_failed", ...describeFailure(error) };
      logger.warn("An OIDC provider is unavailable", { provider: entry.config.slug, ...detail });
      entry.settled = { until: now() + failureTtlMs, metadata: undefined };
      return undefined;
    }
  }

  function load(entry: Entry): Promise<OidcProviderMetadata | undefined> {
    if (entry.settled !== undefined && now() < entry.settled.until) {
      return Promise.resolve(entry.settled.metadata);
    }
    entry.inflight ??= refresh(entry).finally(() => {
      delete entry.inflight;
    });
    return entry.inflight;
  }

  // The code is exchanged at the token endpoint the verified document named, through egress, with the PKCE
  // verifier; what comes back is trusted only as far as the ID token's own verification takes it.
  async function exchangeCode(
    config: IdentityProviderConfig,
    metadata: OidcProviderMetadata,
    request: IdentityCompleteRequest,
  ): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (metadata.tokenAuthMethod === "client_secret_basic") {
      headers["authorization"] = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString("base64")}`;
    } else {
      form.set("client_id", config.clientId);
      form.set("client_secret", config.clientSecret);
    }
    const refuse = (detail: Readonly<Record<string, unknown>>): IdentityError => {
      logger.warn("An OIDC code exchange failed", { provider: config.slug, ...detail });
      return new IdentityError("exchange_failed");
    };
    let response;
    try {
      response = await egress.request({
        url: metadata.tokenEndpoint,
        method: "POST",
        headers,
        body: new TextEncoder().encode(form.toString()),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: TOKEN_MAX_BYTES,
        acceptContentTypes: TOKEN_CONTENT_TYPES,
      });
    } catch (error) {
      throw refuse(describeFailure(error));
    }
    if (response.status !== 200) {
      throw refuse({ status: response.status });
    }
    let idToken: unknown;
    try {
      idToken = asObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown)?.["id_token"];
    } catch {
      throw refuse({ error: "invalid_response" });
    }
    if (typeof idToken !== "string" || idToken === "") {
      throw refuse({ error: "no_id_token" });
    }
    return idToken;
  }

  return {
    available: entries.length > 0,
    async listProviders(): Promise<readonly IdentityProviderInfo[]> {
      const loaded = await Promise.all(entries.map(async (entry) => ({ entry, metadata: await load(entry) })));
      return loaded.flatMap(({ entry, metadata }) =>
        metadata === undefined ? [] : [{ id: entry.config.slug, displayName: entry.config.name }],
      );
    },
    metadata(providerId: string): Promise<OidcProviderMetadata | undefined> {
      const entry = bySlug.get(providerId);
      return entry === undefined ? Promise.resolve(undefined) : load(entry);
    },
    async begin(request: IdentityBeginRequest): Promise<{ readonly authorizationUrl: string }> {
      const entry = bySlug.get(request.providerId);
      const metadata = entry === undefined ? undefined : await load(entry);
      if (entry === undefined || metadata === undefined) {
        throw new IdentityError("provider_unavailable");
      }
      const url = new URL(metadata.authorizationEndpoint);
      const scopes = entry.config.scopes.includes("openid") ? entry.config.scopes : ["openid", ...entry.config.scopes];
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", entry.config.clientId);
      url.searchParams.set("redirect_uri", request.redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: url.href };
    },
    async complete(request: IdentityCompleteRequest): Promise<IdentityClaims> {
      const entry = bySlug.get(request.providerId);
      const metadata = entry === undefined ? undefined : await load(entry);
      if (entry === undefined || metadata === undefined) {
        throw new IdentityError("provider_unavailable");
      }
      const { config } = entry;
      const idToken = await exchangeCode(config, metadata, request);
      try {
        const verified = verifyIdToken(idToken, { issuer: config.issuerUrl, clientId: config.clientId, nonce: request.nonce, keys: metadata.keys, now: now() });
        return {
          providerId: config.slug,
          subject: verified.subject,
          email: verified.email ?? "",
          emailVerified: verified.emailVerified,
          ...(verified.name === undefined ? {} : { displayName: verified.name }),
        };
      } catch (error) {
        logger.warn("An OIDC sign-in was refused", { provider: config.slug, reason: error instanceof IdTokenError ? error.refusal : "malformed" });
        throw new IdentityError("invalid_token");
      }
    },
  };
}
