import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IdentityProviderConfig } from "@slugbase/core";
import { HttpEgress, createOidcIdentity } from "../src/index.ts";
import { respond, startLocalServer, type Handler, type LocalServer } from "./support/local-http.ts";

// T6, T20 against the real egress adapter: the identity adapter reaches an identity provider only through it,
// so a discovery document that points an endpoint at a private address is refused by the port and an oversized
// document is cut off. The provider is a server on loopback, which the port may reach only because the test
// names that one address; the host names are scripted and nothing leaves the machine.

const SECRET = "client-secret-qx84";
const servers: LocalServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(handler: Handler, tls?: Parameters<typeof startLocalServer>[1]): Promise<LocalServer> {
  const server = await startLocalServer(handler, tls);
  servers.push(server);
  return server;
}

const asJson =
  (body: (origin: string) => unknown): Handler =>
  (request, socket) => {
    const origin = `http://idp.example.test:${String(socket.localPort)}`;
    const text = request.target.endsWith("/keys") ? JSON.stringify({ keys: [{ kty: "RSA", kid: "k1" }] }) : JSON.stringify(body(origin));
    respond(socket, 200, { "content-type": "application/json" }, text);
  };

const document = (origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  jwks_uri: `${origin}/keys`,
  ...overrides,
});

function provider(server: LocalServer, slug: string): IdentityProviderConfig {
  return {
    slug,
    name: slug,
    clientId: "client-id-qx85",
    clientSecret: SECRET,
    issuerUrl: `http://idp.example.test:${String(server.port)}`,
    scopes: ["openid"],
    autoCreate: false,
    allowedDomains: [],
  };
}

function setup(...providers: IdentityProviderConfig[]) {
  const resolved: string[] = [];
  const egress = new HttpEgress({
    nodeEnv: "test",
    resolve: (hostname) => {
      resolved.push(hostname);
      return Promise.resolve(hostname === "idp.example.test" ? ["127.0.0.1"] : ["10.0.0.5"]);
    },
    testOnly: { allowAddresses: ["127.0.0.1"] },
  });
  const lines: unknown[] = [];
  const identity = createOidcIdentity({ providers, egress, logger: { warn: (message, fields) => lines.push({ message, fields }) } });
  return { identity, lines, resolved };
}

describe("the OIDC identity adapter over the egress adapter", () => {
  it("lists a provider reached through the port", async () => {
    const server = await serve(asJson((origin) => document(origin)));
    const { identity, lines } = setup(provider(server, "good"));
    expect(await identity.listProviders()).toEqual([{ id: "good", displayName: "good" }]);
    expect(lines).toEqual([]);
    expect(server.requests.map((request) => request.target)).toEqual(["/.well-known/openid-configuration", "/keys"]);
  });

  it("lists every provider of a long list whose host name takes a moment to resolve, instead of refusing those past three lookups", async () => {
    const server = await serve(asJson((origin) => document(origin)));
    const providers = ["a", "b", "c", "d", "e"].map((slug) => provider(server, slug));
    const egress = new HttpEgress({
      nodeEnv: "test",
      resolve: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(["127.0.0.1"]);
          }, 25);
        }),
      testOnly: { allowAddresses: ["127.0.0.1"] },
    });
    const lines: unknown[] = [];
    const identity = createOidcIdentity({ providers, egress, logger: { warn: (message, fields) => lines.push({ message, fields }) } });
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(lines).toEqual([]);
  });

  it("refuses a document whose key endpoint resolves to a private address, and the other provider stays", async () => {
    const good = await serve(asJson((origin) => document(origin)));
    const hostile = await serve(asJson((origin) => document(origin, { jwks_uri: `http://internal.example.test:${String(good.port)}/keys` })));
    const { identity, lines, resolved } = setup(provider(hostile, "hostile"), provider(good, "good"));
    expect(await identity.listProviders()).toEqual([{ id: "good", displayName: "good" }]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "hostile", reason: "keys_failed", code: "egress_blocked" } }]);
    expect(resolved).toContain("internal.example.test");
    expect(hostile.requests.map((request) => request.target)).toEqual(["/.well-known/openid-configuration"]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.stringify(lines)).not.toContain("10.0.0.5");
  });

  it("refuses a document whose key endpoint is a private address literal", async () => {
    const server = await serve(asJson((origin) => document(origin, { jwks_uri: "http://169.254.169.254/latest/meta-data/" })));
    const { identity, lines } = setup(provider(server, "hostile"));
    expect(await identity.listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "hostile", reason: "keys_failed", code: "egress_blocked" } }]);
  });

  it("refuses a document that names another issuer, before it fetches the keys", async () => {
    const server = await serve(asJson(() => document("http://other.example.test")));
    const { identity, lines } = setup(provider(server, "mismatch"));
    expect(await identity.listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "mismatch", reason: "issuer_mismatch" } }]);
    expect(server.requests).toHaveLength(1);
  });

  it("cuts off a discovery document larger than the cap", async () => {
    const server = await serve(asJson((origin) => document(origin, { padding: "x".repeat(70_000) })));
    const { identity, lines } = setup(provider(server, "large"));
    expect(await identity.listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "large", reason: "discovery_failed", code: "egress_too_large" } }]);
  });

  it("leaves out a provider whose issuer host resolves to a private address", async () => {
    const server = await serve(asJson((origin) => document(origin)));
    const unreachable = { ...provider(server, "down"), issuerUrl: "http://internal.example.test:9" };
    const { identity, lines } = setup(unreachable, provider(server, "good"));
    expect((await identity.listProviders()).map((info) => info.id)).toEqual(["good"]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "down", reason: "discovery_failed", code: "egress_blocked" } }]);
  });
});

describe("an https issuer over the egress adapter", () => {
  let directory: string;
  let certificate: { key: string; cert: string };

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "oidc-tls-"));
    const keyFile = join(directory, "idp.key");
    const certFile = join(directory, "idp.crt");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=idp.example.test", "-addext", "subjectAltName=DNS:idp.example.test"],
      { stdio: "ignore" },
    );
    certificate = { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const keys = JSON.stringify({ keys: [{ kty: "RSA", kid: "k1" }] });

  // The https provider answers its own discovery document; `redirected` names the path it sends to the plain-http server.
  async function httpsProvider(redirected: "/.well-known/openid-configuration" | "/keys" | "/token", plain: LocalServer): Promise<{ identity: ReturnType<typeof createOidcIdentity>; lines: unknown[] }> {
    const server = await serve((request, socket) => {
      const origin = `https://idp.example.test:${String(socket.localPort)}`;
      if (request.target === redirected) {
        respond(socket, 302, { location: `http://idp.example.test:${String(plain.port)}${redirected}` });
      } else if (request.target === "/keys") {
        respond(socket, 200, { "content-type": "application/json" }, keys);
      } else {
        respond(socket, 200, { "content-type": "application/json" }, JSON.stringify(document(origin)));
      }
    }, certificate);
    const egress = new HttpEgress({
      nodeEnv: "test",
      resolve: () => Promise.resolve(["127.0.0.1"]),
      testOnly: { allowAddresses: ["127.0.0.1"], ca: certificate.cert },
    });
    const lines: unknown[] = [];
    const config: IdentityProviderConfig = { ...provider(server, "tls"), issuerUrl: `https://idp.example.test:${String(server.port)}` };
    return { identity: createOidcIdentity({ providers: [config], egress, logger: { warn: (message, fields) => lines.push({ message, fields }) } }), lines };
  }

  it.each([
    ["discovery", "/.well-known/openid-configuration", "discovery_failed"],
    ["the key set", "/keys", "keys_failed"],
  ] as const)("leaves the provider out when %s is redirected to http, and never connects to the http server", async (_name, path, reason) => {
    const plain = await serve(asJson((origin) => document(origin)));
    const { identity, lines } = await httpsProvider(path, plain);
    expect(await identity.listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "tls", reason, code: "egress_blocked" } }]);
    expect(plain.connections()).toBe(0);
  });

  it("refuses the code exchange when the token endpoint is redirected to http, and never connects to the http server", async () => {
    const plain = await serve(asJson((origin) => document(origin)));
    const { identity, lines } = await httpsProvider("/token", plain);
    expect(await identity.listProviders()).toEqual([{ id: "tls", displayName: "tls" }]);
    expect(lines).toEqual([]);
    await expect(
      identity.complete({ providerId: "tls", redirectUri: "https://app.example.test/callback", code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" }),
    ).rejects.toMatchObject({ reason: "exchange_failed" });
    expect(lines).toEqual([{ message: "An OIDC code exchange failed", fields: { provider: "tls", code: "egress_blocked" } }]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(plain.connections()).toBe(0);
  });
});

// Q120: the operator names the issuer origin of a provider on a private address. The instance carries that origin and no allowance
// of the test's own, so what the provider reaches on loopback it reaches only through the origin it was named for.
describe("a provider on a named private origin over the egress adapter", () => {
  function named(...origins: LocalServer[]) {
    const resolved: string[] = [];
    const egress = new HttpEgress({
      nodeEnv: "test",
      resolve: (hostname) => {
        resolved.push(hostname);
        return Promise.resolve(hostname === "idp.example.test" ? ["127.0.0.1"] : ["10.0.0.5"]);
      },
      privateOrigin: origins.map((server) => `http://idp.example.test:${String(server.port)}`),
    });
    const lines: unknown[] = [];
    const build = (...providers: IdentityProviderConfig[]) =>
      createOidcIdentity({ providers, egress, logger: { warn: (message, fields) => lines.push({ message, fields }) } });
    return { build, lines, resolved };
  }

  const REDIRECT = "https://app.example.test/callback";

  it("lists the provider and reaches its token endpoint, which are on its own origin", async () => {
    const server = await serve((request, socket) => {
      const origin = `http://idp.example.test:${String(socket.localPort)}`;
      if (request.target === "/token") {
        respond(socket, 400, { "content-type": "application/json" }, JSON.stringify({ error: "invalid_grant" }));
      } else if (request.target === "/keys") {
        respond(socket, 200, { "content-type": "application/json" }, JSON.stringify({ keys: [{ kty: "RSA", kid: "k1" }] }));
      } else {
        respond(socket, 200, { "content-type": "application/json" }, JSON.stringify(document(origin)));
      }
    });
    const { build, lines } = named(server);
    const identity = build(provider(server, "lan"));
    expect(await identity.listProviders()).toEqual([{ id: "lan", displayName: "lan" }]);
    await expect(identity.complete({ providerId: "lan", redirectUri: REDIRECT, code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" })).rejects.toMatchObject({
      reason: "exchange_failed",
    });
    expect(server.requests.map((request) => request.target)).toEqual(["/.well-known/openid-configuration", "/keys", "/token"]);
    expect(lines).toEqual([{ message: "An OIDC code exchange failed", fields: { provider: "lan", status: 400 } }]);
  });

  it("is refused for the same provider when its origin is not named", async () => {
    const server = await serve(asJson((origin) => document(origin)));
    const { build, lines } = named();
    expect(await build(provider(server, "lan")).listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "lan", reason: "discovery_failed", code: "egress_blocked" } }]);
    expect(server.connections()).toBe(0);
  });

  it.each([
    ["another private host", (port: number) => `http://internal.example.test:${String(port)}/keys`],
    ["the metadata address", () => "http://169.254.169.254/latest/meta-data/"],
    ["a private address literal", (port: number) => `http://127.0.0.1:${String(port)}/keys`],
    ["the named host on another port", (port: number) => `http://idp.example.test:${String(port + 1)}/keys`],
  ])("leaves the provider out when its document puts the key set on %s, with no connection", async (_label, jwksUri) => {
    const trap = await serve(asJson((origin) => document(origin)));
    const server = await serve(asJson((origin) => document(origin, { jwks_uri: jwksUri(trap.port) })));
    const { build, lines } = named(server);
    expect(await build(provider(server, "lan")).listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "lan", reason: "keys_failed", code: "egress_blocked" } }]);
    expect(server.requests.map((request) => request.target)).toEqual(["/.well-known/openid-configuration"]);
    expect(trap.connections()).toBe(0);
  });

  it.each([
    ["another private host", (port: number) => `http://internal.example.test:${String(port)}/token`],
    ["the metadata address", () => "http://169.254.169.254/latest/meta-data/"],
    ["a private address literal", (port: number) => `http://127.0.0.1:${String(port)}/token`],
  ])("refuses the code exchange when the token endpoint is on %s, with no connection and without the secret in the log", async (_label, tokenEndpoint) => {
    const trap = await serve(asJson((origin) => document(origin)));
    const server = await serve(asJson((origin) => document(origin, { token_endpoint: tokenEndpoint(trap.port) })));
    const { build, lines } = named(server);
    const identity = build(provider(server, "lan"));
    expect(await identity.listProviders()).toEqual([{ id: "lan", displayName: "lan" }]);
    await expect(identity.complete({ providerId: "lan", redirectUri: REDIRECT, code: "code-1", nonce: "nonce-1", codeVerifier: "verifier-1" })).rejects.toMatchObject({
      reason: "exchange_failed",
    });
    expect(lines).toEqual([{ message: "An OIDC code exchange failed", fields: { provider: "lan", code: "egress_blocked" } }]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(trap.connections()).toBe(0);
  });

  it("refuses the key set a document redirects to another private host, with no connection", async () => {
    const trap = await serve(asJson((origin) => document(origin)));
    const server = await serve((request, socket) => {
      const origin = `http://idp.example.test:${String(socket.localPort)}`;
      if (request.target === "/keys") {
        respond(socket, 302, { location: `http://internal.example.test:${String(trap.port)}/keys` });
      } else {
        respond(socket, 200, { "content-type": "application/json" }, JSON.stringify(document(origin)));
      }
    });
    const { build, lines } = named(server);
    expect(await build(provider(server, "lan")).listProviders()).toEqual([]);
    expect(lines).toEqual([{ message: "An OIDC provider is unavailable", fields: { provider: "lan", reason: "keys_failed", code: "egress_blocked" } }]);
    expect(trap.connections()).toBe(0);
  });
});
