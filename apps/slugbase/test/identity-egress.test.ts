import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { EgressError, IdentityError } from "@slugbase/core";
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

async function startProvider(): Promise<Provider> {
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
      if (target === "/.well-known/openid-configuration") {
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
