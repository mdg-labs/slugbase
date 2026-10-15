import {
  EgressBlocked,
  EgressError,
  EgressTimeout,
  EgressTooLarge,
  type EgressPort,
  type EgressRequest,
  type EgressResponse,
  type IdentityProviderConfig,
} from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { createOidcIdentity, type OidcIdentityLogger } from "../src/index.ts";

// T6, T20: discovery and the signing keys come only through the egress port, within its caps, and a provider
// whose answer is wrong or refused is left out while the others stay. The port here is scripted and answers
// as the real one does for a size cap; the real one is exercised in identity-egress.test.ts.

const SECRET = "client-secret-qx82";
const ISSUER = "https://idp.example.test";

const provider = (overrides: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig => ({
  slug: "idp",
  name: "Example IdP",
  clientId: "client-id-qx83",
  clientSecret: SECRET,
  issuerUrl: ISSUER,
  scopes: ["openid", "email"],
  autoCreate: false,
  allowedDomains: [],
  ...overrides,
});

const discoveryUrl = (issuer: string): string => `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;

const document = (issuer = ISSUER, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/keys`,
  ...overrides,
});

const KEYS = { keys: [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }] };

type Answer = Error | { readonly body: string; readonly status?: number; readonly contentType?: string };

const json = (value: unknown, status = 200): Answer => ({ body: JSON.stringify(value), status, contentType: "application/json; charset=utf-8" });

class ScriptedEgress implements EgressPort {
  readonly available = true;
  readonly requests: EgressRequest[] = [];
  readonly #routes = new Map<string, Answer>();

  constructor(routes: Readonly<Record<string, Answer>> = {}) {
    for (const [url, answer] of Object.entries(routes)) {
      this.#routes.set(url, answer);
    }
  }

  script(url: string, answer: Answer): this {
    this.#routes.set(url, answer);
    return this;
  }

  request(request: EgressRequest): Promise<EgressResponse> {
    this.requests.push(request);
    const answer = this.#routes.get(request.url);
    if (answer === undefined) {
      return Promise.reject(new Error(`no route for ${request.url}`));
    }
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    const body = new TextEncoder().encode(answer.body);
    if (body.length > request.maxBytes) {
      return Promise.reject(new EgressTooLarge());
    }
    const accepted = request.acceptContentTypes?.map((type) => type.toLowerCase());
    const type = answer.contentType?.split(";")[0]?.trim().toLowerCase();
    if (accepted !== undefined && (type === undefined || !accepted.includes(type))) {
      return Promise.reject(new EgressError());
    }
    return Promise.resolve({ url: request.url, status: answer.status ?? 200, contentType: answer.contentType, body });
  }
}

interface Logged {
  readonly level: "warn";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function recordingLogger(): OidcIdentityLogger & { readonly lines: Logged[] } {
  const lines: Logged[] = [];
  return {
    lines,
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
  };
}

function healthy(issuer = ISSUER): ScriptedEgress {
  return new ScriptedEgress({
    [discoveryUrl(issuer)]: json(document(issuer)),
    [`${issuer}/keys`]: json(KEYS),
  });
}

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("the OIDC identity adapter", () => {
  it("lists a provider whose discovery and keys were fetched, by slug and name", async () => {
    const identity = createOidcIdentity({ providers: [provider()], egress: healthy(), logger: recordingLogger() });
    expect(identity.available).toBe(true);
    expect(await identity.listProviders()).toEqual([{ id: "idp", displayName: "Example IdP" }]);
  });

  it("lists the providers in the order they were configured", async () => {
    const egress = healthy();
    const other = "https://other.example.test";
    egress.script(discoveryUrl(other), json(document(other))).script(`${other}/keys`, json(KEYS));
    const identity = createOidcIdentity({
      providers: [provider({ slug: "b", name: "B" }), provider({ slug: "a", name: "A", issuerUrl: other })],
      egress,
      logger: recordingLogger(),
    });
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["b", "a"]);
  });

  it("fetches only the discovery document and the keys, by GET through the port, within its caps", async () => {
    const egress = healthy();
    const identity = createOidcIdentity({ providers: [provider()], egress, logger: recordingLogger() });
    await identity.listProviders();
    expect(egress.requests.map((request) => request.url)).toEqual([discoveryUrl(ISSUER), `${ISSUER}/keys`]);
    for (const request of egress.requests) {
      expect(request.method ?? "GET").toBe("GET");
      expect(request.body).toBeUndefined();
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(10_000);
      expect(request.maxBytes).toBeGreaterThan(0);
      expect(request.maxBytes).toBeLessThanOrEqual(1_048_576);
      expect(request.acceptContentTypes?.length).toBeGreaterThan(0);
      expect(JSON.stringify(request)).not.toContain(SECRET);
    }
  });

  it("builds the discovery URL from an issuer with a path or a trailing slash", async () => {
    const issuer = "https://idp.example.test/realms/main/";
    const egress = new ScriptedEgress({
      "https://idp.example.test/realms/main/.well-known/openid-configuration": json(document(issuer)),
      [`${issuer}/keys`]: json(KEYS),
    });
    const identity = createOidcIdentity({ providers: [provider({ issuerUrl: issuer })], egress, logger: recordingLogger() });
    expect(await identity.listProviders()).toHaveLength(1);
  });

  it("hands the fetched metadata and keys to the handshake", async () => {
    const identity = createOidcIdentity({ providers: [provider()], egress: healthy(), logger: recordingLogger() });
    expect(await identity.metadata("idp")).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/keys`,
      tokenAuthMethod: "client_secret_basic",
      keys: KEYS.keys,
    });
    expect(await identity.metadata("unknown")).toBeUndefined();
  });

  describe("caching", () => {
    it("serves the answer from the cache within the TTL and fetches again after it", async () => {
      const egress = healthy();
      const time = clock();
      const identity = createOidcIdentity({ providers: [provider()], egress, logger: recordingLogger(), cacheTtlMs: 60_000, now: time.now });
      await identity.listProviders();
      time.advance(59_999);
      await identity.listProviders();
      await identity.metadata("idp");
      expect(egress.requests).toHaveLength(2);
      time.advance(2);
      await identity.listProviders();
      expect(egress.requests).toHaveLength(4);
    });

    it("shares one fetch between concurrent callers", async () => {
      const egress = healthy();
      const identity = createOidcIdentity({ providers: [provider()], egress, logger: recordingLogger() });
      await Promise.all([identity.listProviders(), identity.listProviders(), identity.metadata("idp")]);
      expect(egress.requests).toHaveLength(2);
    });

    it("does not ask a failed provider again within the failure TTL, and recovers after it", async () => {
      const egress = new ScriptedEgress({ [discoveryUrl(ISSUER)]: new EgressTimeout() });
      const time = clock();
      const identity = createOidcIdentity({ providers: [provider()], egress, logger: recordingLogger(), failureTtlMs: 30_000, now: time.now });
      expect(await identity.listProviders()).toEqual([]);
      time.advance(29_999);
      expect(await identity.listProviders()).toEqual([]);
      expect(egress.requests).toHaveLength(1);
      egress.script(discoveryUrl(ISSUER), json(document())).script(`${ISSUER}/keys`, json(KEYS));
      time.advance(2);
      expect(await identity.listProviders()).toEqual([{ id: "idp", displayName: "Example IdP" }]);
    });

    it("marks a provider unavailable when a refresh after the TTL fails", async () => {
      const egress = healthy();
      const time = clock();
      const identity = createOidcIdentity({ providers: [provider()], egress, logger: recordingLogger(), cacheTtlMs: 1_000, now: time.now });
      expect(await identity.listProviders()).toHaveLength(1);
      egress.script(discoveryUrl(ISSUER), new EgressTimeout());
      time.advance(1_001);
      expect(await identity.listProviders()).toEqual([]);
      expect(await identity.metadata("idp")).toBeUndefined();
    });
  });

  describe("a provider that cannot be used is left out, logged, and does not affect the others", () => {
    const BAD = "https://broken.example.test";

    async function withBad(answers: Record<string, Answer>) {
      const egress = healthy();
      for (const [url, answer] of Object.entries(answers)) {
        egress.script(url, answer);
      }
      const logger = recordingLogger();
      const identity = createOidcIdentity({
        providers: [provider({ slug: "bad", name: "Bad", issuerUrl: BAD }), provider()],
        egress,
        logger,
      });
      return { egress, logger, listed: await identity.listProviders() };
    }

    const good = [{ id: "idp", displayName: "Example IdP" }];

    it("when discovery cannot be fetched", async () => {
      const { listed, logger } = await withBad({ [discoveryUrl(BAD)]: new EgressError() });
      expect(listed).toEqual(good);
      expect(logger.lines).toEqual([
        { level: "warn", message: "An OIDC provider is unavailable", fields: { provider: "bad", reason: "discovery_failed", code: "egress_failed" } },
      ]);
    });

    it("when discovery does not answer 200", async () => {
      const { listed, logger } = await withBad({ [discoveryUrl(BAD)]: json(document(BAD), 500) });
      expect(listed).toEqual(good);
      expect(logger.lines[0]?.fields).toMatchObject({ provider: "bad", reason: "discovery_failed" });
    });

    it("when discovery is not JSON, or not an object", async () => {
      for (const body of ["<html>login</html>", "[]", "null", '"text"']) {
        const { listed } = await withBad({ [discoveryUrl(BAD)]: { body, contentType: "application/json" } });
        expect(listed, body).toEqual(good);
      }
    });

    it("when discovery is served with another content type", async () => {
      const { listed } = await withBad({ [discoveryUrl(BAD)]: { body: JSON.stringify(document(BAD)), contentType: "text/html" } });
      expect(listed).toEqual(good);
    });

    it("when the document names another issuer", async () => {
      const { listed, logger, egress } = await withBad({ [discoveryUrl(BAD)]: json(document(ISSUER)) });
      expect(listed).toEqual(good);
      expect(logger.lines[0]?.fields).toEqual({ provider: "bad", reason: "issuer_mismatch" });
      expect(egress.requests.map((request) => request.url)).not.toContain(`${BAD}/keys`);
    });

    it.each([`${BAD}/`, BAD.toUpperCase(), `${BAD}:443`, "http://broken.example.test"])("when the document's issuer is %s, which is not the configured string", async (issuer) => {
      const { listed, logger } = await withBad({ [discoveryUrl(BAD)]: json(document(BAD, { issuer })) });
      expect(listed).toEqual(good);
      expect(logger.lines[0]?.fields).toEqual({ provider: "bad", reason: "issuer_mismatch" });
    });

    it("when the document has no issuer", async () => {
      const { listed } = await withBad({ [discoveryUrl(BAD)]: json({ ...document(BAD), issuer: undefined }) });
      expect(listed).toEqual(good);
    });

    it.each(["authorization_endpoint", "token_endpoint", "jwks_uri"])("when %s is missing", async (member) => {
      const { listed, logger } = await withBad({ [discoveryUrl(BAD)]: json(document(BAD, { [member]: undefined })) });
      expect(listed).toEqual(good);
      expect(logger.lines[0]?.fields).toEqual({ provider: "bad", reason: "invalid_discovery" });
    });

    it.each([
      ["a relative URL", "/authorize"],
      ["a URL with credentials", "https://user:pw@broken.example.test/authorize"],
      ["a URL with a fragment", "https://broken.example.test/authorize#x"],
      ["a non-http URL", "javascript:alert(1)"],
      ["a downgrade to http", "http://broken.example.test/authorize"],
      ["a number", 5],
    ])("when an endpoint is %s", async (_name, value) => {
      for (const member of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        const { listed, logger } = await withBad({ [discoveryUrl(BAD)]: json(document(BAD, { [member]: value })) });
        expect(listed, member).toEqual(good);
        expect(logger.lines[0]?.fields, member).toEqual({ provider: "bad", reason: "invalid_discovery" });
      }
    });

    it("when the keys cannot be fetched", async () => {
      const { listed, logger } = await withBad({ [discoveryUrl(BAD)]: json(document(BAD)), [`${BAD}/keys`]: new EgressTimeout() });
      expect(listed).toEqual(good);
      expect(logger.lines[0]?.fields).toEqual({ provider: "bad", reason: "keys_failed", code: "egress_timeout" });
    });

    it("when the keys document is not a non-empty set of keys", async () => {
      for (const body of ["{}", '{"keys":[]}', '{"keys":"x"}', '{"keys":[{"kid":"no-type"}]}', '{"keys":[1]}', "nope"]) {
        const { listed, logger } = await withBad({
          [discoveryUrl(BAD)]: json(document(BAD)),
          [`${BAD}/keys`]: { body, contentType: "application/json" },
        });
        expect(listed, body).toEqual(good);
        expect(logger.lines[0]?.fields, body).toMatchObject({ provider: "bad", reason: expect.stringMatching(/^(invalid_keys|keys_failed)$/) as string });
      }
    });

    it("when the keys document is larger than the cap", async () => {
      const big = JSON.stringify({ keys: [{ kty: "oct", k: "x".repeat(2_000_000) }] });
      const { listed, logger } = await withBad({
        [discoveryUrl(BAD)]: json(document(BAD)),
        [`${BAD}/keys`]: { body: big, contentType: "application/json" },
      });
      expect(listed).toEqual(good);
      expect(logger.lines[0]?.fields).toEqual({ provider: "bad", reason: "keys_failed", code: "egress_too_large" });
    });

    it("logs each failure with the provider's slug and a fixed reason, and never a secret or a URL", async () => {
      const lines: Logged[] = [];
      const logger: OidcIdentityLogger = {
        warn: (message, fields) => lines.push({ level: "warn", message, fields }),
      };
      const egress = healthy();
      egress
        .script(discoveryUrl(BAD), new Error(`connect ECONNREFUSED 10.0.0.5 ${SECRET} ${BAD}`))
        .script(discoveryUrl("https://blocked.example.test"), new EgressBlocked())
        .script(discoveryUrl("https://mismatch.example.test"), json(document(ISSUER)));
      const identity = createOidcIdentity({
        providers: [
          provider({ slug: "bad", issuerUrl: BAD }),
          provider({ slug: "blocked", issuerUrl: "https://blocked.example.test" }),
          provider({ slug: "mismatch", issuerUrl: "https://mismatch.example.test" }),
          provider(),
        ],
        egress,
        logger,
      });
      await identity.listProviders();
      expect(lines).toHaveLength(3);
      const everything = JSON.stringify(lines);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain("client-id-qx83");
      expect(everything).not.toContain("example.test");
      expect(everything).not.toContain("ECONNREFUSED");
      expect(everything).not.toContain("10.0.0.5");
    });
  });

  it("leaves out a provider whose egress refuses an endpoint on a private address", async () => {
    const egress = new ScriptedEgress({
      [discoveryUrl(ISSUER)]: json(document(ISSUER, { jwks_uri: "https://internal.example.test/keys" })),
      "https://internal.example.test/keys": new EgressBlocked(),
    });
    const logger = recordingLogger();
    const identity = createOidcIdentity({ providers: [provider()], egress, logger });
    expect(await identity.listProviders()).toEqual([]);
    expect(logger.lines[0]?.fields).toEqual({ provider: "idp", reason: "keys_failed", code: "egress_blocked" });
  });

  it("never rejects from listProviders, whatever the port throws", async () => {
    const egress: EgressPort = { available: true, request: () => Promise.reject(new TypeError("boom")) };
    const logger = recordingLogger();
    const identity = createOidcIdentity({ providers: [provider()], egress, logger });
    expect(await identity.listProviders()).toEqual([]);
    expect(logger.lines[0]?.fields).toEqual({ provider: "idp", reason: "discovery_failed", error: "TypeError" });
  });

  it("refuses to begin or complete a handshake with a provider it does not know or cannot use", async () => {
    const egress = healthy();
    egress.script(`${ISSUER}/keys`, new EgressError());
    const identity = createOidcIdentity({ providers: [provider()], egress, logger: recordingLogger() });
    const begin = { redirectUri: "https://x.example.test/cb", state: "s", nonce: "n", codeChallenge: "c" };
    const complete = { redirectUri: "https://x.example.test/cb", code: "c", nonce: "n", codeVerifier: "v" };
    for (const providerId of ["idp", "unknown"]) {
      await expect(identity.begin({ providerId, ...begin })).rejects.toMatchObject({ name: "IdentityError", reason: "provider_unavailable" });
      await expect(identity.complete({ providerId, ...complete })).rejects.toMatchObject({ name: "IdentityError", reason: "provider_unavailable" });
    }
    expect(egress.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("is available only with a provider configured", () => {
    expect(createOidcIdentity({ providers: [], egress: healthy(), logger: recordingLogger() }).available).toBe(false);
  });
});
