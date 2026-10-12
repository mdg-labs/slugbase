import { getHealth, getReady, getVersion } from "@slugbase/contracts";
import { CE_CHAIN } from "@slugbase/db";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildInfo } from "../../src/build-info.ts";
import { createServer } from "../../src/create-server.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// The probes of doc 04 section 9.2 through the whole chain. Nothing here needs
// a database: /ready is asked with a URL that refuses the connection.

const BUILD: BuildInfo = { name: "SlugBase", version: "1.4.2", commit: "0123abc", builtAt: "2026-10-12T08:00:00Z" };

// Nothing listens on port 1.
const UNREACHABLE = "postgres://slugbase_app:Zq8-prod-app-pw@127.0.0.1:1/slugbase";

function start(overrides: Record<string, string | undefined> = {}, buildInfo: BuildInfo = BUILD) {
  const logger = recordingLogger();
  const database = fakeDatabase();
  const touched: string[] = [];
  const tracked = new Proxy(database, {
    get(target, property, receiver) {
      touched.push(String(property));
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const server = createServer({
    config: serverConfig({ DATABASE_URL: UNREACHABLE, ...overrides }),
    adapters: adapters(),
    modules: [],
    migrations: [],
    logger,
    database: tracked,
    buildInfo,
  });
  // createServer binds the tenant helper at composition; only later access counts.
  touched.length = 0;
  return { server, logger, touched };
}

const get = (server: ReturnType<typeof start>["server"], path: string, headers: Record<string, string> = {}) =>
  server.fetch(new Request(`http://localhost${path}`, { headers }));

function shippedMigrations(): number {
  const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}

describe("GET /health", () => {
  it("answers 200 {status: ok} without touching the database, even when it cannot be reached", async () => {
    const { server, touched } = start();
    const response = await get(server, "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(touched).toEqual([]);
  });

  it("is anonymous and unlimited by contract", () => {
    for (const operation of [getHealth, getReady, getVersion]) {
      expect(operation.auth).toBe("anonymous");
      expect(operation.rate).toBe("none");
    }
  });
});

describe("GET /version", () => {
  it("answers exactly name, version, commit and builtAt", async () => {
    const { server } = start();
    const response = await get(server, "/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(BUILD);
  });

  it("adds no key the build info happens to carry (T22)", async () => {
    const wide = { ...BUILD, registryToken: "x", hostname: "build-7" } as BuildInfo;
    // In development and test the response stage throws on an undeclared field, so this proves the
    // handler itself leaves the extra keys out rather than relying on the production strip.
    for (const NODE_ENV of ["test", "production"]) {
      const { server } = start({ NODE_ENV }, wide);
      const response = await get(server, "/version");
      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()) as object).sort()).toEqual(["builtAt", "commit", "name", "version"]);
    }
  });

  it("reports a development run when no build info is given", async () => {
    const logger = recordingLogger();
    const server = createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [],
      migrations: [],
      logger,
      database: fakeDatabase(),
    });
    const body = (await (await get(server, "/version")).json()) as BuildInfo;
    expect(body.commit).toBe("development");
  });
});

describe("GET /ready", () => {
  it("answers 503 with the shape of a ready answer when the database cannot be reached", async () => {
    const { server, logger } = start();
    const response = await get(server, "/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      database: "unreachable",
      migrations: { expected: shippedMigrations(), applied: null },
    });
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain("Zq8-prod-app-pw");
  });

  it("counts the migration sets of the composition in `expected`", async () => {
    const extra = { name: "extra", folder: CE_CHAIN.folder, bookkeepingTable: "migrations_extra" };
    const server = createServer({
      config: serverConfig({ DATABASE_URL: UNREACHABLE }),
      adapters: adapters(),
      modules: [],
      migrations: [extra],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });
    const body = (await (await get(server, "/ready")).json()) as { migrations: { expected: number } };
    expect(body.migrations.expected).toBe(shippedMigrations() * 2);
  });
});

describe("the probes' headers", () => {
  it.each(["/health", "/ready", "/version"])("send no-store and the security headers on %s, without credentials", async (path) => {
    const { server } = start();
    const response = await get(server, path, { Authorization: "Bearer not-a-token", Cookie: "session=not-a-session" });
    expect(response.status).toBe(path === "/ready" ? 503 : 200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).not.toBeNull();
  });
});
