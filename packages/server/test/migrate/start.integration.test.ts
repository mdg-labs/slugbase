import { connect } from "node:net";
import { MigrationError } from "@slugbase/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/create-server.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";
import { clusterSuperuser, scratchChains, urlFor, urlOf, useMigratableDatabase } from "./support.ts";

// The server's own migration at start (doc 05 section 5.3, D25) and the refusal
// of an application role that is not held by row-level security (Q56).

const database = useMigratableDatabase();
const chains = scratchChains();
const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

afterAll(() => {
  chains.remove();
});

function composition(overrides: Record<string, string | undefined>, migrations: Parameters<typeof createServer>[0]["migrations"] = []) {
  const logger = recordingLogger();
  const server = createServer({
    config: serverConfig({
      NODE_ENV: "test",
      DATABASE_URL: urlOf(database().app),
      DATABASE_MIGRATE_URL: urlOf(database().owner),
      ...overrides,
    }),
    adapters: adapters(),
    modules: [],
    migrations,
    logger,
    database: fakeDatabase(),
  });
  return { server, logger };
}

function ask(server: ReturnType<typeof composition>["server"], path: string) {
  return server.fetch(new Request(`http://localhost${path}`));
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

interface Problem {
  code: string;
  status: number;
}

describe("MIGRATE_ON_START=true", () => {
  it("answers the probes at once, refuses the rest with 503 unavailable until the migration is done, then serves", async () => {
    const slow = chains.chain("slowstart", ["SELECT pg_sleep(2); CREATE TABLE public.slowstart_one (id int);"]);
    const { server } = composition({ MIGRATE_ON_START: "true" }, [slow]);
    let started = false;
    const starting = server.start({ port: 0 }).then((handle) => {
      started = true;
      running.push(handle);
      return handle;
    });

    // The migration is inside pg_sleep, so these requests are answered while it runs.
    await expect.poll(() => ask(server, "/health").then((response) => response.status)).toBe(200);
    expect(started).toBe(false);
    expect((await ask(server, "/version")).status).toBe(200);
    const ready = await ask(server, "/ready");
    expect(ready.status).toBe(503);
    for (const path of ["/api/config", "/no/such/route", "/"]) {
      const response = await ask(server, path);
      expect(response.status, path).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(((await response.json()) as Problem).code).toBe("unavailable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(started).toBe(false);

    await starting;
    expect((await ask(server, "/ready")).status).toBe(200);
    expect((await ask(server, "/api/config")).status).toBe(200);
    const tables = await database().owner<{ present: boolean }[]>`SELECT to_regclass('public.slowstart_one') IS NOT NULL AS present`;
    expect(tables[0]?.present).toBe(true);
  });

  it("applies nothing when the database is at the level of the build, and starts", async () => {
    const { server, logger } = composition({ MIGRATE_ON_START: "true" });
    running.push(await server.start({ port: 0 }));
    expect((await ask(server, "/ready")).status).toBe(200);
    expect(logger.entries.filter((entry) => entry.message === "The database is migrated").map((entry) => entry.fields)).toEqual([
      { applied: 0 },
    ]);
  });

  it("stops before serving when a migration fails, leaves the failed one unrecorded and names no connection string", async () => {
    const broken = chains.chain("brokenstart", ["SELECT * FROM public.table_that_does_not_exist;"]);
    const { server, logger } = composition({ MIGRATE_ON_START: "true" }, [broken]);
    const failure = await server.start({ port: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).message).not.toContain(urlOf(database().owner));
    expect((failure as MigrationError).message).not.toContain(String(database().owner.options.pass));
    const port = logger.entries.find((entry) => entry.message === "Listening")?.fields["port"];
    expect(typeof port).toBe("number");
    expect(await listening(port as number)).toBe(false);
    const recorded = await database().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.migrations_brokenstart`;
    expect(recorded).toEqual([{ n: 0 }]);
    // The server that failed to migrate still refuses everything but the probes.
    expect((await ask(server, "/api/config")).status).toBe(503);
  });
});

describe("MIGRATE_ON_START=false", () => {
  it("never migrates, and /ready stays 503 while the database is behind the build", async () => {
    const pending = chains.chain("pendingstart", ["CREATE TABLE public.pendingstart_one (id int);"]);
    const { server } = composition({ MIGRATE_ON_START: "false", DATABASE_MIGRATE_URL: undefined }, [pending]);
    running.push(await server.start({ port: 0 }));
    const ready = await ask(server, "/ready");
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { migrations: { expected: number; applied: number } };
    expect(body.migrations.applied).toBeLessThan(body.migrations.expected);
    const tables = await database().owner<{ present: boolean }[]>`SELECT to_regclass('drizzle.migrations_pendingstart') IS NOT NULL AS present`;
    expect(tables[0]?.present).toBe(false);
    expect((await ask(server, "/api/config")).status).toBe(200);
  });
});

describe("an application role that is not held by row-level security", () => {
  // The superuser of the test cluster stands for the owner of the tables: row-level security does not apply to it.
  const superuserUrl = (): string => urlFor(database().app, clusterSuperuser());

  function production(overrides: Record<string, string | undefined> = {}) {
    const logger = recordingLogger();
    const server = createServer({
      config: serverConfig({
        NODE_ENV: "production",
        DATABASE_URL: superuserUrl(),
        MIGRATE_ON_START: "false",
        DATABASE_MIGRATE_URL: undefined,
        ...overrides,
      }),
      adapters: adapters(),
      modules: [],
      migrations: [],
      logger,
    });
    return { server, logger };
  }

  it("refuses to start in production, explaining the two-role setup and naming no connection string", async () => {
    const { server, logger } = production();
    const failure = await server.start({ port: 0 }).then(
      (handle) => {
        running.push(handle);
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("slugbase_app");
    expect(message).toContain("slugbase_migrator");
    expect(message).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(message).not.toMatch(/postgre(s|sql):\/\//);
    expect(logger.entries.map((entry) => entry.message)).not.toContain("Listening");
  });

  it("starts with SLUGBASE_ALLOW_OWNER_CONNECTION=true, and warns", async () => {
    const { server, logger } = production({ SLUGBASE_ALLOW_OWNER_CONNECTION: "true" });
    running.push(await server.start({ port: 0 }));
    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(warnings[0]?.fields).toMatchObject({ superuser: true });
    expect(JSON.stringify(warnings)).not.toMatch(/postgre(s|sql):\/\//);
  });

  it("is not checked outside production", async () => {
    const { server, logger } = production({ NODE_ENV: "test" });
    running.push(await server.start({ port: 0 }));
    expect(logger.entries.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("refuses when the role cannot be read at all, never starting on an unchecked connection", async () => {
    const unreachable = new URL(superuserUrl());
    unreachable.port = "1";
    const { server } = production({ DATABASE_URL: unreachable.href });
    const failure = await server.start({ port: 0 }).then(
      (handle) => {
        running.push(handle);
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/postgre(s|sql):\/\//);
  });
});
