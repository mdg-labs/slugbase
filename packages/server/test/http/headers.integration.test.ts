import { connect } from "node:net";
import type { Adapters } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer, type ServerModule } from "../../src/create-server.ts";
import { adapters, fakeDatabase, operation, recordingLogger, serverConfig, documentOf } from "../support.ts";
import { expectSecurityHeaders } from "./headers-support.ts";

// The security headers over a real socket (doc 01 section 4 step 2, doc 08
// section 3.5): the header set of every route class, on the answer a handler
// gives and on the answers the chain replaces it with. The client is a raw
// socket: the repository allows no HTTP client outside the egress adapter.

const database = useTestDatabase();

// The URL the server reads the migration level through: the app role of the test database.
function appUrl(): string {
  const { options } = database().app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

const routes: ServerModule = {
  name: "headers-fixture",
  register: () => ({
    routes: [
      { operation: operation("get", "/api/v1/ping", "ping"), handler: () => Response.json({}) },
      {
        operation: operation("get", "/api/v1/cors", "cors"),
        handler: () =>
          Response.json(
            {},
            {
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Expose-Headers": "X-Request-Id",
              },
            },
          ),
      },
      {
        operation: operation("get", "/api/v1/caches", "caches"),
        handler: () => Response.json({}, { headers: { "Cache-Control": "public, max-age=86400" } }),
      },
      {
        operation: operation("get", "/api/v1/boom", "boom"),
        handler: () => {
          throw new Error("secret-detail-qx90");
        },
      },
      {
        operation: operation("get", "/api/v1/mismatch", "mismatch"),
        handler: () => Response.json({}, { status: 201 }),
      },
    ],
  }),
};

interface Answer {
  readonly status: number;
  readonly headers: Headers;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const head = Buffer.concat(chunks).toString("utf8").split("\r\n\r\n")[0] ?? "";
      const [statusLine = "", ...lines] = head.split("\r\n");
      const parsed = new Headers();
      for (const line of lines) {
        const separator = line.indexOf(":");
        parsed.append(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      resolve({ status: Number(statusLine.split(" ")[1]), headers: parsed });
    });
    const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${lines.join("")}\r\n`);
  });
}

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

async function listen(env: Record<string, string | undefined> = {}, ports: Adapters = adapters()): Promise<number> {
  const server = createServer({
    config: serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(), ...env }),
    adapters: ports,
    modules: [routes],
    openApiDocument: documentOf([routes]),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
  const started = await server.start({ port: 0 });
  running.push(started);
  return started.port;
}

const NO_STORE = "no-store";

describe("the security headers of an API response", () => {
  it("carries the full set and no-store", async () => {
    const port = await listen();
    const answer = await get(port, "/api/v1/ping");
    expect(answer.status).toBe(200);
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
    expect(answer.headers.get("x-request-id")).not.toBeNull();
  });

  it("replaces a cache policy the contract does not declare with no-store", async () => {
    const port = await listen();
    const answer = await get(port, "/api/v1/caches");
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("carries no CORS header, whatever the handler sets", async () => {
    const port = await listen();
    const answer = await get(port, "/api/v1/cors", { Origin: "https://elsewhere.example" });
    expect(answer.status).toBe(200);
    expectSecurityHeaders(answer.headers, { https: true });
    expect([...answer.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
  });
});

describe("the cache policy an operation declares", () => {
  it("is what GET /api/config answers with, and nothing else on the API is cacheable", async () => {
    const port = await listen();
    const config = await get(port, "/api/config");
    expect(config.status).toBe(200);
    expectSecurityHeaders(config.headers, { https: true });
    expect(config.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("does not make an error answer of that operation cacheable", async () => {
    // The port reports itself available when the server is composed and fails when the config is built.
    const reads = { count: 0 };
    const failing = Object.create(adapters().mail, {
      available: {
        get: (): boolean => {
          reads.count += 1;
          if (reads.count > 1) {
            throw new Error("config failed");
          }
          return false;
        },
      },
    }) as Adapters["mail"];
    const port = await listen({}, { ...adapters(), mail: failing });
    const failed = await get(port, "/api/config");
    expect(failed.status).toBe(500);
    expectSecurityHeaders(failed.headers, { https: true });
    expect(failed.headers.get("cache-control")).toBe(NO_STORE);
  });
});

describe("the security headers of a probe response", () => {
  it.each(["/health", "/ready"])("carries the full set and no-store on %s", async (path) => {
    const port = await listen();
    const answer = await get(port, path);
    expect(answer.status).toBe(200);
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
  });
});

describe("the security headers of an error response", () => {
  it("reach the 404 of an unknown API route", async () => {
    const port = await listen();
    const answer = await get(port, "/api/v1/nothing");
    expect(answer.status).toBe(404);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("reach the 404 of an unknown path outside the API", async () => {
    const port = await listen();
    const answer = await get(port, "/nothing-here");
    expect(answer.status).toBe(404);
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("reach the 500 that replaces a failing handler", async () => {
    const port = await listen();
    const answer = await get(port, "/api/v1/boom");
    expect(answer.status).toBe(500);
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
    expect(answer.headers.get("x-request-id")).not.toBeNull();
  });

  it("reach the 500 that replaces a response its operation does not declare", async () => {
    const port = await listen();
    const answer = await get(port, "/api/v1/mismatch");
    expect(answer.status).toBe(500);
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
  });
});

describe("the security headers of a /go response", () => {
  it("send no referrer and no-store", async () => {
    const port = await listen();
    const answer = await get(port, "/go/docs");
    expectSecurityHeaders(answer.headers, { https: true });
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer.headers.get("cache-control")).toBe(NO_STORE);
  });
});

describe("Strict-Transport-Security", () => {
  it("is sent when APP_ORIGIN is https", async () => {
    const port = await listen({ APP_ORIGIN: "https://bookmarks.example.com" });
    const answer = await get(port, "/api/v1/ping");
    expect(answer.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("is left out when APP_ORIGIN is http", async () => {
    const port = await listen({ NODE_ENV: "development", APP_ORIGIN: "http://localhost:5173" });
    const answer = await get(port, "/api/v1/ping");
    expect(answer.status).toBe(200);
    expectSecurityHeaders(answer.headers, { https: false });
  });
});
