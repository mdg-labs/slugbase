import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { EgressError, type AiSuggestRequest } from "@slugbase/core";
import { loadConfig, type Logger } from "@slugbase/server";
import { afterEach, describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The egress instances of one process (shared, AI and OIDC) draw on one budget of three host-name lookups, one fewer than the
// four threads libuv starts (doc 01 section 6). These tests build the instances through the composition root, the way the
// server does, with a scripted resolver. They fail when an instance is built without its share of the budget, and when the
// OIDC adapter runs more requests at once than its share can hold.

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

const ai = {
  AI_BASE_URL: "https://ai.example.test/v1",
  AI_MODEL: "small-model",
  AI_PROVIDER_NAME: "Example AI",
};

const suggestion: AiSuggestRequest = { url: "https://example.com/", language: "en", tags: [] };

function providerKeys(slug: string, port: number): Record<string, string> {
  const name = slug.toUpperCase();
  return {
    [`OIDC_${name}_CLIENT_ID`]: `client-id-${slug}`,
    [`OIDC_${name}_CLIENT_SECRET`]: `client-secret-${slug}-qx90`,
    [`OIDC_${name}_ISSUER_URL`]: `http://${slug}.example.test:${String(port)}`,
  };
}

// One loopback server answers for every provider host name: the issuer of a discovery document is the host the request named.
function startProviders(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      if (!pending.includes("\r\n\r\n")) {
        return;
      }
      const target = pending.split(" ")[1] ?? "";
      const origin = `http://${/^host: (.*)$/im.exec(pending)?.[1]?.trim() ?? ""}`;
      pending = "";
      let body: unknown = { error: "not_found" };
      if (target === "/.well-known/openid-configuration") {
        body = {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/keys`,
        };
      } else if (target === "/keys") {
        body = { keys: [{ kty: "RSA", kid: "k1" }] };
      }
      const text = JSON.stringify(body);
      socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(text))}\r\nconnection: close\r\n\r\n${text}`);
      socket.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

const open: { release(): void }[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const held of open.splice(0)) {
    held.release();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

// A resolver whose lookups never settle until the test ends, and a record of the lookups it was asked for.
function stallingResolver() {
  const asked: string[] = [];
  return {
    asked,
    resolve: (hostname: string): Promise<readonly string[]> => {
      asked.push(hostname);
      return new Promise<readonly string[]>((resolve) => {
        open.push({
          release: () => {
            resolve([]);
          },
        });
      });
    },
  };
}

describe("the process's host-name lookup budget, through the composition root", () => {
  it("holds at most three lookups across the shared, AI and OIDC instances, and refuses a further one without calling the resolver", async () => {
    const providers = await startProviders();
    servers.push(providers);
    const resolver = stallingResolver();
    const config = loadConfig("server", { ...environment, ...ai, ...providerKeys("alpha", providers.port) }).config;
    const adapters = composeAdapters(config, logger, { resolve: resolver.resolve, testOnly: { allowAddresses: ["127.0.0.1"] } });

    // The shared instance alone: every request ends at its deadline and its lookup stays held.
    const members = [1, 2, 3, 4].map((n) => adapters.egress.request({ url: `http://member-${String(n)}.example.test/`, timeoutMs: 100, maxBytes: 10 }));
    expect((await Promise.allSettled(members)).map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(resolver.asked).toHaveLength(1);

    // The AI instance and the OIDC instance each still get a lookup, the one reserved for it.
    const suggesting = adapters.ai.suggest(suggestion).catch((error: unknown) => error);
    const listing = adapters.identity.listProviders().catch((error: unknown) => error);
    await expect.poll(() => resolver.asked.length).toBe(3);
    expect(resolver.asked).toContain("ai.example.test");
    expect(resolver.asked).toContain("alpha.example.test");

    // The process holds three; a further lookup on the shared and the AI instance is refused without asking the resolver.
    await expect(adapters.egress.request({ url: "http://member-5.example.test/", timeoutMs: 100, maxBytes: 10 })).rejects.toBeInstanceOf(EgressError);
    await expect(adapters.ai.suggest(suggestion)).rejects.toMatchObject({ code: "ai_failed" });
    expect(resolver.asked).toHaveLength(3);

    for (const held of open.splice(0)) {
      held.release();
    }
    await Promise.all([suggesting, listing]);
  });

  it("lists every provider when the AI instance is built and there are more providers than the OIDC instance has lookups", async () => {
    const providers = await startProviders();
    servers.push(providers);
    const lookups: string[] = [];
    // Every lookup takes a moment, so the requests of two providers overlap.
    const resolve = (hostname: string): Promise<readonly string[]> => {
      lookups.push(hostname);
      return new Promise((done) => {
        setTimeout(() => {
          done(["127.0.0.1"]);
        }, 30);
      });
    };
    const config = loadConfig("server", { ...environment, ...ai, ...providerKeys("alpha", providers.port), ...providerKeys("beta", providers.port) }).config;
    const adapters = composeAdapters(config, logger, { resolve, testOnly: { allowAddresses: ["127.0.0.1"] } });
    expect((await adapters.identity.listProviders()).map((provider) => provider.id)).toEqual(["alpha", "beta"]);
  });

  it("lists every provider when the AI instance is not built and there are more providers than the OIDC instance has lookups", async () => {
    const providers = await startProviders();
    servers.push(providers);
    const resolve = (): Promise<readonly string[]> =>
      new Promise((done) => {
        setTimeout(() => {
          done(["127.0.0.1"]);
        }, 30);
      });
    const config = loadConfig("server", {
      ...environment,
      ...providerKeys("alpha", providers.port),
      ...providerKeys("beta", providers.port),
      ...providerKeys("gamma", providers.port),
    }).config;
    const adapters = composeAdapters(config, logger, { resolve, testOnly: { allowAddresses: ["127.0.0.1"] } });
    expect((await adapters.identity.listProviders()).map((provider) => provider.id)).toEqual(["alpha", "beta", "gamma"]);
  });
});
