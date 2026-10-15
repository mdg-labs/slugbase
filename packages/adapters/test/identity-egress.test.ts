import { afterEach, describe, expect, it } from "vitest";
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

async function serve(handler: Handler): Promise<LocalServer> {
  const server = await startLocalServer(handler);
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
