import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { AiSuggestError, EgressBlocked, EgressError, IdentityError } from "@slugbase/core";
import { loadConfig, type Logger } from "@slugbase/server";
import { afterEach, describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// OIDC sign-in and the fetches a member can start run on egress instances of their own (doc 01 section 6), so a
// member who holds every host-name lookup slot of the shared instance cannot make a sign-in fail with it. The
// resolver is scripted: names of a stalled provider never answer, the identity provider's name resolves to the
// loopback server of this test, which the egress adapter may reach only because the test names that address.

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const environment = {
  NODE_ENV: "test",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-test-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-test-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
  MIGRATE_ON_START: "false",
};

const REDIRECT = "https://bookmarks.example.com/api/v1/auth/oidc/idp/callback";

interface Provider {
  readonly port: number;
  readonly requests: { readonly method: string; readonly target: string; readonly body: string }[];
  close(): Promise<void>;
}

type Respond = (target: string, origin: string) => { readonly status: number; readonly text: string } | undefined;

async function startProvider(respond?: Respond): Promise<Provider> {
  const requests: { method: string; target: string; body: string }[] = [];
  const sockets = new Set<Socket>();
  let origin = "";
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const headEnd = pending.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        return;
      }
      const head = pending.subarray(0, headEnd).toString("latin1");
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? "0");
      if (pending.length < headEnd + 4 + length) {
        return;
      }
      const [method = "", target = ""] = head.split("\r\n")[0]?.split(" ") ?? [];
      requests.push({ method, target, body: pending.subarray(headEnd + 4, headEnd + 4 + length).toString("utf8") });
      pending = Buffer.alloc(0);
      let status = 400;
      let text = JSON.stringify({ error: "invalid_grant" });
      const scripted = respond?.(target, origin);
      if (scripted !== undefined) {
        ({ status, text } = scripted);
      } else if (target === "/.well-known/openid-configuration") {
        status = 200;
        text = JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/keys`,
        });
      } else if (target === "/keys") {
        status = 200;
        text = JSON.stringify({ keys: [{ kty: "RSA", kid: "k1" }] });
      }
      socket.write(`HTTP/1.1 ${String(status)} X\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(text))}\r\nconnection: close\r\n\r\n${text}`);
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://idp.example.test:${String(port)}`;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}

const providers: Provider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

// A lookup that never settles for a name of the stalled provider; the identity provider's name is the loopback server.
const egressOptions = {
  resolve: (hostname: string): Promise<readonly string[]> =>
    hostname === "idp.example.test" ? Promise.resolve(["127.0.0.1"]) : new Promise<readonly string[]>(() => undefined),
  testOnly: { allowAddresses: ["127.0.0.1"] },
};

describe("OIDC sign-in beside the lookups a member can start", () => {
  it("still discovers the provider and reaches its token endpoint while every lookup slot of the shared egress is held", async () => {
    const provider = await startProvider();
    providers.push(provider);
    const config = loadConfig("server", {
      ...environment,
      OIDC_IDP_CLIENT_ID: "client-id-qx90",
      OIDC_IDP_CLIENT_SECRET: "client-secret-qx91",
      OIDC_IDP_ISSUER_URL: `http://idp.example.test:${String(provider.port)}`,
    }).config;
    const { egress, identity } = composeAdapters(config, logger, egressOptions);

    // Three requests for names that never resolve take the three slots; each ends at its deadline, the slot stays held.
    const stalled = [1, 2, 3].map((n) => egress.request({ url: `http://stalled-${String(n)}.example.test/`, timeoutMs: 200, maxBytes: 10 }));
    expect((await Promise.allSettled(stalled)).map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
    await expect(egress.request({ url: "http://stalled-4.example.test/", timeoutMs: 200, maxBytes: 10 })).rejects.toBeInstanceOf(EgressError);
    await expect(egress.request({ url: `http://idp.example.test:${String(provider.port)}/`, timeoutMs: 1_000, maxBytes: 10 })).rejects.toBeInstanceOf(EgressError);

    const begun = await identity.begin({ providerId: "idp", redirectUri: REDIRECT, state: "state-1", nonce: "nonce-1", codeChallenge: "challenge-1" });
    expect(new URL(begun.authorizationUrl).pathname).toBe("/authorize");
    const failure = await identity
      .complete({ providerId: "idp", redirectUri: REDIRECT, code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(IdentityError);
    expect((failure as IdentityError).reason).toBe("exchange_failed");
    const exchanges = provider.requests.filter((request) => request.method === "POST" && request.target === "/token");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.body).toContain("code=code-1");
  });
});

// Q120: a provider whose issuer is on a private address works when the operator names its host, on the identity instance alone. The
// resolver answers loopback for every name here and the options carry no allowance of their own, so a server is reached only through
// the origin the composition names for the identity instance.
describe("a provider on a private address", () => {
  const onLoopback = {
    resolve: (hostname: string): Promise<readonly string[]> =>
      hostname.endsWith(".example.test") ? Promise.resolve(["127.0.0.1"]) : new Promise<readonly string[]>(() => undefined),
  };

  async function twoProviders(named: boolean) {
    const lan = await startProvider();
    const plain = await startProvider();
    providers.push(lan, plain);
    const lanOrigin = `http://idp.example.test:${String(lan.port)}`;
    const config = loadConfig("server", {
      ...environment,
      OIDC_LAN_CLIENT_ID: "client-id-qx92",
      OIDC_LAN_CLIENT_SECRET: "client-secret-qx93",
      OIDC_LAN_ISSUER_URL: lanOrigin,
      ...(named ? { OIDC_LAN_ALLOWED_PRIVATE_HOST: "idp.example.test" } : {}),
      OIDC_PLAIN_CLIENT_ID: "client-id-qx94",
      OIDC_PLAIN_CLIENT_SECRET: "client-secret-qx95",
      OIDC_PLAIN_ISSUER_URL: `http://other.example.test:${String(plain.port)}`,
    }).config;
    return { lan, plain, lanOrigin, config };
  }

  it("lists the provider that names its host and leaves out the one that does not, which sees no connection", async () => {
    const { lan, plain, config } = await twoProviders(true);
    const { identity } = composeAdapters(config, logger, onLoopback);
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["lan"]);
    expect(lan.requests.map((request) => request.target)).toEqual(["/.well-known/openid-configuration", "/keys"]);
    expect(plain.requests).toEqual([]);

    const begun = await identity.begin({ providerId: "lan", redirectUri: REDIRECT, state: "state-1", nonce: "nonce-1", codeChallenge: "challenge-1" });
    expect(new URL(begun.authorizationUrl).pathname).toBe("/authorize");
    await expect(
      identity.complete({ providerId: "lan", redirectUri: REDIRECT, code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" }),
    ).rejects.toMatchObject({ reason: "exchange_failed" });
    expect(lan.requests.filter((request) => request.target === "/token")).toHaveLength(1);
  });

  it("leaves the provider out when the operator names no host", async () => {
    const { lan, config } = await twoProviders(false);
    expect(config.OIDC_PRIVATE_ORIGINS).toEqual([]);
    const { identity } = composeAdapters(config, logger, onLoopback);
    expect(await identity.listProviders()).toEqual([]);
    expect(lan.requests).toEqual([]);
  });

  it("gives the shared egress instance no exemption for that origin", async () => {
    const { lan, lanOrigin, config } = await twoProviders(true);
    expect(config.OIDC_PRIVATE_ORIGINS).toEqual([lanOrigin]);
    const { egress, identity } = composeAdapters(config, logger, onLoopback);
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["lan"]);
    const before = lan.requests.length;
    const shared = await egress.request({ url: `${lanOrigin}/`, timeoutMs: 1_000, maxBytes: 100 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(shared).toBeInstanceOf(EgressBlocked);
    expect(lan.requests).toHaveLength(before);
  });

  // An https AI endpoint on the very origin a provider names: the AI instance takes its allowance from AI_ALLOWED_PRIVATE_HOST alone,
  // so it refuses the address before any connection is made.
  it("gives the AI instance no exemption for that origin", async () => {
    const lan = await startProvider();
    providers.push(lan);
    const origin = `https://idp.example.test:${String(lan.port)}`;
    const { ai } = composeAdapters(
      loadConfig("server", {
        ...environment,
        OIDC_LAN_CLIENT_ID: "client-id-qx92",
        OIDC_LAN_CLIENT_SECRET: "client-secret-qx93",
        OIDC_LAN_ISSUER_URL: origin,
        OIDC_LAN_ALLOWED_PRIVATE_HOST: "idp.example.test",
        AI_BASE_URL: `${origin}/v1`,
        AI_MODEL: "small-model",
        AI_PROVIDER_NAME: "Example AI",
      }).config,
      logger,
      onLoopback,
    );
    const suggestion = await ai.suggest({ url: "https://example.com/", language: "en", tags: [] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(suggestion).toBeInstanceOf(AiSuggestError);
    expect((suggestion as AiSuggestError).cause).toBeInstanceOf(EgressBlocked);
    expect(lan.requests).toEqual([]);
  });

  it("exempts no other origin of the same host", async () => {
    const { lan, config } = await twoProviders(true);
    const { identity } = composeAdapters(
      { ...config, OIDC_PROVIDERS: config.OIDC_PROVIDERS.map((p) => (p.slug === "plain" ? { ...p, issuerUrl: `http://idp.example.test:${String(lan.port + 1)}` } : p)) },
      logger,
      onLoopback,
    );
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["lan"]);
  });
});

// Q121: Microsoft Entra ID's multi-tenant endpoint. The provider's discovery document names the issuer with `{tenantid}` in it and
// the token names the issuer of its own tenant and no `email_verified`. The keys go through `loadConfig` and the composition, so a
// provider that configures neither opt-in is the same provider left out of the list.
describe("a Microsoft Entra ID provider", () => {
  const TENANT = "8aa3c2b1-4d5e-4f60-9a7b-0c1d2e3f4a5b";
  const CLIENT_ID = "client-id-qx98";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const onLoopback = {
    resolve: (hostname: string): Promise<readonly string[]> =>
      hostname.endsWith(".example.test") ? Promise.resolve(["127.0.0.1"]) : new Promise<readonly string[]>(() => undefined),
    testOnly: { allowAddresses: ["127.0.0.1"] },
  };

  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  function idToken(origin: string, overrides: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const input = `${segment({ alg: "RS256", typ: "JWT", kid: "entra-1" })}.${segment({
      iss: `${origin}/${TENANT}/v2.0`,
      aud: CLIENT_ID,
      sub: "subject-entra",
      tid: TENANT,
      nonce: "nonce-1",
      iat: now,
      exp: now + 300,
      email: "person@example.test",
      xms_edov: true,
      name: "Person Example",
      ...overrides,
    })}`;
    return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
  }

  function entraProvider(claims: Record<string, unknown> = {}): Promise<Provider> {
    return startProvider((target, origin) => {
      const json = (value: unknown) => ({ status: 200, text: JSON.stringify(value) });
      if (target === "/common/v2.0/.well-known/openid-configuration") {
        return json({
          issuer: `${origin}/{tenantid}/v2.0`,
          authorization_endpoint: `${origin}/common/oauth2/v2.0/authorize`,
          token_endpoint: `${origin}/common/oauth2/v2.0/token`,
          jwks_uri: `${origin}/common/discovery/v2.0/keys`,
        });
      }
      if (target === "/common/discovery/v2.0/keys") {
        return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "entra-1", use: "sig" }] });
      }
      if (target === "/common/oauth2/v2.0/token") {
        return json({ id_token: idToken(origin, claims), token_type: "Bearer" });
      }
      return undefined;
    });
  }

  function configure(provider: Provider, entra: Record<string, string>) {
    return loadConfig("server", {
      ...environment,
      OIDC_ENTRA_CLIENT_ID: CLIENT_ID,
      OIDC_ENTRA_CLIENT_SECRET: "client-secret-qx99",
      OIDC_ENTRA_ISSUER_URL: `http://idp.example.test:${String(provider.port)}/common/v2.0`,
      ...entra,
    }).config;
  }

  const complete = { providerId: "entra", redirectUri: REDIRECT.replace("/idp/", "/entra/"), code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" };

  it("is listed and signs in with verified claims once the operator turns both opt-ins on", async () => {
    const provider = await entraProvider();
    providers.push(provider);
    const config = configure(provider, { OIDC_ENTRA_ENTRA_MULTI_TENANT: "true", OIDC_ENTRA_ENTRA_TENANTS: TENANT, OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "true" });
    const { identity } = composeAdapters(config, logger, onLoopback);
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["entra"]);
    expect(await identity.complete(complete)).toEqual({
      providerId: "entra",
      subject: "subject-entra",
      email: "person@example.test",
      emailVerified: true,
      displayName: "Person Example",
    });
  });

  it("refuses a token of a tenant the operator did not list", async () => {
    const provider = await entraProvider();
    providers.push(provider);
    const config = configure(provider, {
      OIDC_ENTRA_ENTRA_MULTI_TENANT: "true",
      OIDC_ENTRA_ENTRA_TENANTS: "11111111-2222-4333-8444-555555555555",
      OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "true",
    });
    const { identity } = composeAdapters(config, logger, onLoopback);
    await expect(identity.complete(complete)).rejects.toMatchObject({ reason: "invalid_token" });
  });

  it("gives an unverified address when only the multi-tenant rule is on", async () => {
    const provider = await entraProvider();
    providers.push(provider);
    const { identity } = composeAdapters(configure(provider, { OIDC_ENTRA_ENTRA_MULTI_TENANT: "true" }), logger, onLoopback);
    expect(await identity.complete(complete)).toMatchObject({ subject: "subject-entra", emailVerified: false });
  });

  it("is left out of the list, without the keys, because its document names a templated issuer", async () => {
    const provider = await entraProvider();
    providers.push(provider);
    const { identity } = composeAdapters(configure(provider, {}), logger, onLoopback);
    expect(await identity.listProviders()).toEqual([]);
    await expect(identity.complete(complete)).rejects.toMatchObject({ reason: "provider_unavailable" });
  });
});
