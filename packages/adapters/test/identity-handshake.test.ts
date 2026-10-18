import { createHash, generateKeyPairSync, sign, constants, type KeyObject } from "node:crypto";
import {
  EgressError,
  type EgressPort,
  type EgressRequest,
  type EgressResponse,
  type IdentityCompleteRequest,
  type IdentityProviderConfig,
} from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { createOidcIdentity, type OidcIdentity, type OidcIdentityLogger } from "../src/index.ts";

// T20: the authorization-code handshake of the OIDC adapter. `begin` asks for a PKCE challenge (S256), a state
// and a nonce; `complete` exchanges the code at the token endpoint through the egress port and returns a
// claim only for an ID token whose signature, issuer, audience, nonce and expiry all check out against the
// provider's own key set. The tokens here are signed with real keys; the failure scenarios are a tampered
// nonce, another audience, another issuer, an expired token, a forged signature, a downgraded algorithm and
// a code the provider refuses.

const ISSUER = "https://idp.example.test";
const CLIENT_ID = "client-id-qx83";
const CLIENT_SECRET = "client-secret-qx82";
const REDIRECT = "https://app.example.test/api/v1/auth/oidc/idp/callback";
const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;

const config = (overrides: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig => ({
  slug: "idp",
  name: "Example IdP",
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  issuerUrl: ISSUER,
  scopes: ["openid", "email", "profile"],
  autoCreate: false,
  allowedDomains: [],
  ...overrides,
});

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed = generateKeyPairSync("ed25519");
const strangerRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotatedRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

const jwk = (key: KeyObject, kid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...key.export({ format: "jwk" }), kid, ...extra });

const KEYS = {
  keys: [jwk(rsa.publicKey, "rsa-1", { use: "sig" }), jwk(ec.publicKey, "ec-1"), jwk(ed.publicKey, "ed-1")],
};

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

type Algorithm = "RS256" | "PS256" | "ES256" | "EdDSA" | "none" | "HS256";

function signToken(claims: Record<string, unknown>, options: { alg?: Algorithm; kid?: string | null; key?: KeyObject; header?: Record<string, unknown> } = {}): string {
  const alg = options.alg ?? "RS256";
  const header = { alg, typ: "JWT", ...(options.kid === null ? {} : { kid: options.kid ?? { RS256: "rsa-1", PS256: "rsa-1", ES256: "ec-1", EdDSA: "ed-1", none: "rsa-1", HS256: "rsa-1" }[alg] }), ...options.header };
  const input = `${b64(header)}.${b64(claims)}`;
  const key = options.key ?? { RS256: rsa.privateKey, PS256: rsa.privateKey, ES256: ec.privateKey, EdDSA: ed.privateKey, none: rsa.privateKey, HS256: rsa.privateKey }[alg];
  let signature: Buffer;
  switch (alg) {
    case "RS256":
      signature = sign("sha256", Buffer.from(input), key);
      break;
    case "PS256":
      signature = sign("sha256", Buffer.from(input), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
      break;
    case "ES256":
      signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
      break;
    case "EdDSA":
      signature = sign(null, Buffer.from(input), key);
      break;
    default:
      signature = Buffer.alloc(0);
  }
  return `${input}.${signature.toString("base64url")}`;
}

const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  aud: CLIENT_ID,
  sub: "subject-1",
  nonce: "nonce-1",
  iat: NOW_SECONDS - 10,
  exp: NOW_SECONDS + 300,
  email: "person@example.test",
  email_verified: true,
  name: "Person Example",
  ...overrides,
});

const TOKEN_URL = `${ISSUER}/token`;
const discovery = (overrides: Record<string, unknown> = {}) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: TOKEN_URL,
  jwks_uri: `${ISSUER}/keys`,
  ...overrides,
});

interface Answer {
  readonly body: string;
  readonly status?: number;
  readonly contentType?: string;
}
const json = (value: unknown, status = 200): Answer => ({ body: JSON.stringify(value), status, contentType: "application/json" });

class ScriptedEgress implements EgressPort {
  readonly available = true;
  readonly requests: EgressRequest[] = [];
  token: Answer | Error = json({ id_token: signToken(claims()), token_type: "Bearer" });
  discovery: Record<string, unknown> = discovery();
  keys: Answer | Error = json(KEYS);

  request(request: EgressRequest): Promise<EgressResponse> {
    this.requests.push(request);
    let answer: Answer | Error;
    if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
      answer = json(this.discovery);
    } else if (request.url === `${ISSUER}/keys`) {
      answer = this.keys;
    } else if (request.url === TOKEN_URL) {
      answer = this.token;
    } else {
      return Promise.reject(new Error(`no route for ${request.url}`));
    }
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return Promise.resolve({ url: request.url, status: answer.status ?? 200, contentType: answer.contentType, body: new TextEncoder().encode(answer.body) });
  }

  get exchanges(): EgressRequest[] {
    return this.requests.filter((request) => request.url === TOKEN_URL);
  }

  get keyFetches(): EgressRequest[] {
    return this.requests.filter((request) => request.url === `${ISSUER}/keys`);
  }
}

function setup(options: { egress?: ScriptedEgress; provider?: IdentityProviderConfig } = {}): {
  identity: OidcIdentity;
  egress: ScriptedEgress;
  lines: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[];
  advance: (ms: number) => void;
} {
  const egress = options.egress ?? new ScriptedEgress();
  const lines: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
  const logger: OidcIdentityLogger = { warn: (message, fields) => void lines.push({ message, fields }) };
  let clock = NOW;
  return {
    identity: createOidcIdentity({ providers: [options.provider ?? config()], egress, logger, now: () => clock }),
    egress,
    lines,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const request = (overrides: Partial<IdentityCompleteRequest> = {}): IdentityCompleteRequest => ({
  providerId: "idp",
  redirectUri: REDIRECT,
  code: "code-1",
  nonce: "nonce-1",
  codeVerifier: "verifier-1",
  ...overrides,
});

describe("begin", () => {
  it("builds the authorization URL of the discovered endpoint with the PKCE challenge (S256), the state and the nonce", async () => {
    const { identity } = setup();
    const { authorizationUrl } = await identity.begin({ providerId: "idp", redirectUri: REDIRECT, state: "state-1", nonce: "nonce-1", codeChallenge: "challenge-1" });
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: "openid email profile",
      state: "state-1",
      nonce: "nonce-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it("asks the provider for the credentials again, and for no session older than now, only for a re-authentication", async () => {
    const { identity } = setup();
    const request = { providerId: "idp", redirectUri: REDIRECT, state: "s", nonce: "n", codeChallenge: "c" };
    for (const plain of [request, { ...request, reauthenticate: false }]) {
      const { searchParams } = new URL((await identity.begin(plain)).authorizationUrl);
      expect([searchParams.has("prompt"), searchParams.has("max_age")]).toEqual([false, false]);
    }
    const { searchParams } = new URL((await identity.begin({ ...request, reauthenticate: true })).authorizationUrl);
    expect([searchParams.get("prompt"), searchParams.get("max_age")]).toEqual(["login", "0"]);
  });

  it("asks for the openid scope even when the operator's scopes leave it out, and keeps the query of the endpoint", async () => {
    const egress = new ScriptedEgress();
    egress.discovery = discovery({ authorization_endpoint: `${ISSUER}/authorize?tenant=a` });
    const { identity } = setup({ egress, provider: config({ scopes: ["email"] }) });
    const url = new URL((await identity.begin({ providerId: "idp", redirectUri: REDIRECT, state: "s", nonce: "n", codeChallenge: "c" })).authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("tenant")).toBe("a");
  });
});

describe("complete", () => {
  it("exchanges the code at the token endpoint through the port and returns the claims of a valid ID token", async () => {
    const { identity, egress } = setup();
    expect(await identity.complete(request())).toEqual({
      providerId: "idp",
      subject: "subject-1",
      email: "person@example.test",
      emailVerified: true,
      displayName: "Person Example",
    });
    expect(egress.exchanges).toHaveLength(1);
    const [exchange] = egress.exchanges;
    expect(exchange?.method).toBe("POST");
    expect(new URLSearchParams(new TextDecoder().decode(exchange?.body))).toEqual(
      new URLSearchParams({ grant_type: "authorization_code", code: "code-1", redirect_uri: REDIRECT, code_verifier: "verifier-1" }),
    );
    expect(exchange?.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(exchange?.acceptContentTypes).toEqual(["application/json"]);
  });

  it("authenticates the client with HTTP Basic by default, with its credentials form-encoded", async () => {
    const { identity, egress } = setup({ provider: config({ clientId: "id with space", clientSecret: "se:cr+et" }) });
    egress.token = json({ id_token: signToken(claims({ aud: "id with space" })) });
    await identity.complete(request());
    const authorization = egress.exchanges[0]?.headers?.["authorization"] ?? "";
    expect(Buffer.from(authorization.replace("Basic ", ""), "base64").toString()).toBe("id+with+space:se%3Acr%2Bet");
    expect(new TextDecoder().decode(egress.exchanges[0]?.body)).not.toContain("client_secret");
  });

  it("sends the credentials in the form when the provider lists only that method", async () => {
    const egress = new ScriptedEgress();
    egress.discovery = discovery({ token_endpoint_auth_methods_supported: ["client_secret_post"] });
    const { identity } = setup({ egress });
    await identity.complete(request());
    const form = new URLSearchParams(new TextDecoder().decode(egress.exchanges[0]?.body));
    expect([form.get("client_id"), form.get("client_secret")]).toEqual([CLIENT_ID, CLIENT_SECRET]);
    expect(egress.exchanges[0]?.headers?.["authorization"]).toBeUndefined();
  });

  it("leaves a provider unavailable that lists only token endpoint methods the client cannot use", async () => {
    const egress = new ScriptedEgress();
    egress.discovery = discovery({ token_endpoint_auth_methods_supported: ["private_key_jwt"] });
    const { identity } = setup({ egress });
    expect(await identity.listProviders()).toEqual([]);
    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "provider_unavailable" });
  });

  it.each<[string, Algorithm]>([
    ["RS256", "RS256"],
    ["PS256", "PS256"],
    ["ES256", "ES256"],
    ["EdDSA", "EdDSA"],
  ])("accepts an ID token signed with %s by the key the provider published", async (_name, alg) => {
    const { identity, egress } = setup();
    egress.token = json({ id_token: signToken(claims(), { alg }) });
    expect(await identity.complete(request())).toMatchObject({ subject: "subject-1" });
  });

  it("accepts a token that names no key when exactly the key set can verify it, and an audience list that names the client with azp", async () => {
    const { identity, egress } = setup();
    egress.token = json({ id_token: signToken(claims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }), { kid: null }) });
    expect(await identity.complete(request())).toMatchObject({ subject: "subject-1" });
  });

  it("returns no address as verified unless the token says so, and no address when it has none", async () => {
    const { identity, egress } = setup();
    egress.token = json({ id_token: signToken(claims({ email_verified: false })) });
    expect(await identity.complete(request())).toMatchObject({ email: "person@example.test", emailVerified: false });
    egress.token = json({ id_token: signToken(claims({ email_verified: "true" })) });
    expect(await identity.complete(request())).toMatchObject({ emailVerified: true });
    egress.token = json({ id_token: signToken(claims({ email: undefined, email_verified: true, name: undefined })) });
    expect(await identity.complete(request())).toEqual({ providerId: "idp", subject: "subject-1", email: "", emailVerified: false });
  });

  describe("refuses an ID token that cannot be trusted, without a claim, as an invalid token", () => {
    const refused: [string, Record<string, unknown>, Parameters<typeof signToken>[1]?, string?][] = [
      ["a tampered nonce", claims({ nonce: "nonce-of-another-request" }), undefined, "nonce"],
      ["no nonce", claims({ nonce: undefined }), undefined, "nonce"],
      ["another audience", claims({ aud: "another-client" }), undefined, "audience"],
      ["an audience list without the client", claims({ aud: ["a", "b"] }), undefined, "audience"],
      ["several audiences and no azp", claims({ aud: [CLIENT_ID, "other"] }), undefined, "audience"],
      ["an azp that is another party", claims({ azp: "other" }), undefined, "audience"],
      ["another issuer", claims({ iss: "https://evil.example.test" }), undefined, "issuer"],
      ["the issuer with a trailing slash", claims({ iss: `${ISSUER}/` }), undefined, "issuer"],
      ["an expired token", claims({ exp: NOW_SECONDS - 3600 }), undefined, "expired"],
      ["no expiry", claims({ exp: undefined }), undefined, "expired"],
      ["a token issued in the future", claims({ iat: NOW_SECONDS + 3600 }), undefined, "not_yet_valid"],
      ["a token not yet valid", claims({ nbf: NOW_SECONDS + 3600 }), undefined, "not_yet_valid"],
      ["no subject", claims({ sub: undefined }), undefined, "subject"],
      ["an empty subject", claims({ sub: "" }), undefined, "subject"],
      ["a signature of another key", claims(), { key: strangerRsa.privateKey }, "signature"],
      ["a key id the provider does not publish", claims(), { kid: "unknown" }, "key"],
      ["a critical header extension nobody understands", claims(), { header: { crit: ["exp"] } }, "malformed"],
      ["the algorithm none", claims(), { alg: "none" as const }, "algorithm"],
      ["a symmetric algorithm", claims(), { alg: "HS256" as const }, "algorithm"],
      ["an algorithm the named key does not fit (ES256 claimed for the RSA key)", claims(), { alg: "ES256" as const, kid: "rsa-1", key: ec.privateKey }, "key"],
    ];

    it.each(refused)("%s", async (_name, tokenClaims, options, refusal) => {
      const { identity, egress, lines } = setup();
      egress.token = json({ id_token: signToken(tokenClaims, options) });
      await expect(identity.complete(request())).rejects.toMatchObject({ name: "IdentityError", reason: "invalid_token" });
      expect(lines.at(-1)).toEqual({ message: "An OIDC sign-in was refused", fields: { provider: "idp", reason: refusal } });
    });

    it("a token whose payload was changed after it was signed", async () => {
      const { identity, egress } = setup();
      const [header = "", , signature = ""] = signToken(claims()).split(".");
      egress.token = json({ id_token: `${header}.${b64(claims({ sub: "someone-else" }))}.${signature}` });
      await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
    });

    it("a token that is not a compact JWS", async () => {
      const { identity, egress } = setup();
      for (const idToken of ["", "a.b", "a.b.c.d", "!!!.!!!.!!!", `${b64("[]")}.${b64("{}")}.AA`]) {
        egress.token = json({ id_token: idToken });
        await expect(identity.complete(request())).rejects.toMatchObject({ reason: idToken === "" ? "exchange_failed" : "invalid_token" });
      }
    });

    it("a token that tampers with the algorithm after the signature was made", async () => {
      const { identity, egress } = setup();
      const [, payload = "", signature = ""] = signToken(claims()).split(".");
      egress.token = json({ id_token: `${b64({ alg: "PS256", kid: "rsa-1" })}.${payload}.${signature}` });
      await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
    });
  });

  it("tolerates a minute of clock difference and no more", async () => {
    const { identity, egress } = setup();
    egress.token = json({ id_token: signToken(claims({ exp: NOW_SECONDS - 30, iat: NOW_SECONDS + 30 })) });
    expect(await identity.complete(request())).toMatchObject({ subject: "subject-1" });
    egress.token = json({ id_token: signToken(claims({ exp: NOW_SECONDS - 61 })) });
    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
  });

  describe("refuses a code exchange that fails, as a failed exchange", () => {
    it.each<[string, Answer | Error]>([
      ["a refusal by the provider", json({ error: "invalid_grant" }, 400)],
      ["a server error", json({ error: "server_error" }, 500)],
      ["a response that is not JSON", { body: "<html>", contentType: "application/json" }],
      ["a response without an ID token", json({ access_token: "a" })],
      ["a response whose ID token is not text", json({ id_token: 7 })],
      ["a failure of the port", new EgressError("egress_timeout", "The request timed out")],
    ])("%s", async (_name, answer) => {
      const { identity, egress, lines } = setup();
      egress.token = answer;
      await expect(identity.complete(request())).rejects.toMatchObject({ name: "IdentityError", reason: "exchange_failed" });
      expect(lines.at(-1)?.message).toBe("An OIDC code exchange failed");
    });

    it("and writes neither the secret, the code nor the verifier to the log", async () => {
      const { identity, egress, lines } = setup();
      egress.token = json({ error: "invalid_grant", error_description: "code-1 verifier-1" }, 400);
      await expect(identity.complete(request())).rejects.toBeInstanceOf(Error);
      const logged = JSON.stringify(lines);
      for (const secret of [CLIENT_SECRET, "code-1", "verifier-1", "invalid_grant"]) {
        expect(logged).not.toContain(secret);
      }
    });
  });

  it("sends the exchange to the token endpoint the verified discovery document named, and to no other address", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    expect(egress.exchanges.map((exchange) => exchange.url)).toEqual([TOKEN_URL]);
  });

  it("does not use a code twice on its own: every call exchanges the code it is given", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    await identity.complete(request({ code: "code-2" }));
    expect(egress.exchanges.map((exchange) => new URLSearchParams(new TextDecoder().decode(exchange.body)).get("code"))).toEqual(["code-1", "code-2"]);
  });
});

describe("the verifier challenge", () => {
  it("is what the caller sends to the provider and the caller's verifier is what the token endpoint receives", async () => {
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { identity, egress } = setup();
    const url = new URL((await identity.begin({ providerId: "idp", redirectUri: REDIRECT, state: "s", nonce: "n", codeChallenge: challenge })).authorizationUrl);
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    await identity.complete(request({ codeVerifier: verifier }));
    expect(new URLSearchParams(new TextDecoder().decode(egress.exchanges[0]?.body)).get("code_verifier")).toBe(verifier);
  });
});

describe("an email that is not asserted as verified", () => {
  it("is returned as unverified when the token has no email_verified claim, or one that is not true", async () => {
    const { identity, egress } = setup();
    for (const overrides of [{ email_verified: undefined }, { email_verified: "false" }, { email_verified: 1 }, { email_verified: null }]) {
      egress.token = json({ id_token: signToken(claims(overrides)) });
      expect(await identity.complete(request())).toMatchObject({ email: "person@example.test", emailVerified: false });
    }
  });
});

describe("a re-authentication", () => {
  const since = (offsetMs = 0): Partial<IdentityCompleteRequest> & { authenticatedSince: number } => ({ authenticatedSince: NOW + offsetMs });

  it("accepts an ID token whose auth_time is at or after the second the handshake began, or within the clock skew before it", async () => {
    const { identity, egress } = setup();
    for (const authTime of [NOW_SECONDS - 5, NOW_SECONDS - 60, NOW_SECONDS, NOW_SECONDS + 20]) {
      egress.token = json({ id_token: signToken(claims({ auth_time: authTime })) });
      expect(await identity.complete({ ...request(), ...since(400) })).toMatchObject({ subject: "subject-1" });
    }
  });

  it("refuses an ID token whose auth_time is older than the handshake's start by more than the clock skew, with the auth_time reason", async () => {
    const { identity, egress, lines } = setup();
    egress.token = json({ id_token: signToken(claims({ auth_time: NOW_SECONDS - 61 })) });
    await expect(identity.complete({ ...request(), ...since(400) })).rejects.toMatchObject({ name: "IdentityError", reason: "invalid_token" });
    expect(lines.at(-1)).toEqual({ message: "An OIDC sign-in was refused", fields: { provider: "idp", reason: "auth_time" } });
  });

  it("refuses an auth_time that is not a number", async () => {
    const { identity, egress, lines } = setup();
    for (const authTime of ["1700000000", null, {}]) {
      egress.token = json({ id_token: signToken(claims({ auth_time: authTime })) });
      await expect(identity.complete({ ...request(), ...since() })).rejects.toMatchObject({ reason: "invalid_token" });
      expect(lines.at(-1)?.fields).toEqual({ provider: "idp", reason: "malformed" });
    }
  });

  it("accepts a provider that omits auth_time: prompt=login alone vouches for it", async () => {
    const { identity, egress } = setup();
    egress.token = json({ id_token: signToken(claims()) });
    expect(await identity.complete({ ...request(), ...since() })).toMatchObject({ subject: "subject-1" });
  });

  it("looks at auth_time only when the caller names the handshake's start: a plain sign-in keeps its token however old the authentication", async () => {
    const { identity, egress } = setup();
    egress.token = json({ id_token: signToken(claims({ auth_time: NOW_SECONDS - 86_400 })) });
    expect(await identity.complete(request())).toMatchObject({ subject: "subject-1" });
  });
});

describe("a provider that rotates its signing keys", () => {
  const rotated = (extra: readonly Record<string, unknown>[] = KEYS.keys): Answer => json({ keys: [...extra, jwk(rotatedRsa.publicKey, "rsa-2", { use: "sig" })] });
  const newToken = (options: Parameters<typeof signToken>[1] = {}): Answer => json({ id_token: signToken(claims(), { kid: "rsa-2", key: rotatedRsa.privateKey, ...options }) });

  it("fetches the key set once more for a token signed with an unknown key id, and accepts it when the key is there", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    expect(egress.keyFetches).toHaveLength(1);
    egress.keys = rotated();
    egress.token = newToken();

    expect(await identity.complete(request())).toMatchObject({ subject: "subject-1" });
    expect(egress.keyFetches).toHaveLength(2);
    expect(egress.keyFetches[1]).toMatchObject({ timeoutMs: 5_000, maxBytes: 262_144, acceptContentTypes: ["application/json", "application/jwk-set+json"] });

    await identity.complete(request());
    expect(egress.keyFetches).toHaveLength(2);
  });

  it("keeps the refetched keys as the provider's keys, so a key the provider dropped no longer verifies", async () => {
    const { identity, egress, advance } = setup();
    await identity.complete(request());
    egress.keys = json({ keys: [jwk(rotatedRsa.publicKey, "rsa-2", { use: "sig" })] });
    egress.token = newToken();
    await identity.complete(request());

    advance(61_000);
    egress.token = json({ id_token: signToken(claims()) });
    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
  });

  it("refuses a key id the refetched set does not hold, and refuses a second unknown one within the bound without another fetch", async () => {
    const { identity, egress, advance, lines } = setup();
    await identity.complete(request());
    egress.token = json({ id_token: signToken(claims(), { kid: "unknown-1" }) });

    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
    expect(egress.keyFetches).toHaveLength(2);
    expect(lines.at(-1)?.fields).toEqual({ provider: "idp", reason: "key" });

    egress.token = json({ id_token: signToken(claims(), { kid: "unknown-2" }) });
    advance(59_000);
    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
    expect(egress.keyFetches).toHaveLength(2);

    advance(1_000);
    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
    expect(egress.keyFetches).toHaveLength(3);
  });

  it("does not fetch the keys for a token whose key id the set holds but whose signature, algorithm or key fails, or for one with no key id", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    const attempts: Parameters<typeof signToken>[1][] = [
      { key: strangerRsa.privateKey },
      { alg: "ES256", kid: "rsa-1", key: ec.privateKey },
      { kid: null, key: strangerRsa.privateKey },
    ];
    for (const options of attempts) {
      egress.token = json({ id_token: signToken(claims(), options) });
      await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
    }
    expect(egress.keyFetches).toHaveLength(1);
  });

  it.each<[string, Answer | Error]>([
    ["cannot be fetched", new EgressError("egress_timeout", "The request timed out")],
    ["does not answer 200", json({}, 503)],
    ["is not a set of keys", json({ keys: [] })],
  ])("refuses the token, keeps the keys it had and logs a fixed reason when the refetch %s", async (_name, answer) => {
    const { identity, egress, lines, advance } = setup();
    await identity.complete(request());
    egress.keys = answer;
    egress.token = newToken();

    await expect(identity.complete(request())).rejects.toMatchObject({ name: "IdentityError", reason: "invalid_token" });
    expect(egress.keyFetches).toHaveLength(2);
    const refetchLines = lines.filter((line) => line.message === "An OIDC provider's keys could not be fetched again");
    expect(refetchLines).toHaveLength(1);
    expect(refetchLines[0]?.fields?.["provider"]).toBe("idp");
    expect(["keys_failed", "invalid_keys"]).toContain(refetchLines[0]?.fields?.["reason"]);

    advance(1_000);
    egress.token = json({ id_token: signToken(claims()) });
    expect(await identity.complete(request())).toMatchObject({ subject: "subject-1" });
    expect(egress.keyFetches).toHaveLength(2);
  });

  it("shares one refetch between sign-ins that meet the new key id together", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    egress.keys = rotated();
    egress.token = newToken();

    const results = await Promise.all([identity.complete(request({ code: "c1" })), identity.complete(request({ code: "c2" })), identity.complete(request({ code: "c3" }))]);

    expect(results.map((claimed) => claimed.subject)).toEqual(["subject-1", "subject-1", "subject-1"]);
    expect(egress.keyFetches).toHaveLength(2);
  });

  it("serves a sign-in that arrives after another one refetched from the keys it fetched, inside the bound", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    egress.keys = rotated();
    egress.token = newToken();
    await identity.complete(request());

    expect(await identity.complete(request({ code: "late" }))).toMatchObject({ subject: "subject-1" });
    expect(egress.keyFetches).toHaveLength(2);
  });

  it("still refuses a token with the right new key id and a signature of another key", async () => {
    const { identity, egress } = setup();
    await identity.complete(request());
    egress.keys = rotated();
    egress.token = newToken({ key: strangerRsa.privateKey });
    await expect(identity.complete(request())).rejects.toMatchObject({ reason: "invalid_token" });
  });
});
