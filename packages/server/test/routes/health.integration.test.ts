import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MigrationChain } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/create-server.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// GET /ready against a migrated database, read as slugbase_app (doc 05 section
// 5.3): ready, behind the build, ahead of the build, and without the database.

const database = useTestDatabase();

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

// A migration set the test database never applied: the build ships it, the database lacks it.
const unapplied = mkdtempSync(join(tmpdir(), "slugbase-unapplied-"));
mkdirSync(join(unapplied, "meta"));
writeFileSync(join(unapplied, "meta", "_journal.json"), JSON.stringify({ entries: [{ tag: "0000_next", when: 1_900_000_000_000 }] }));
writeFileSync(join(unapplied, "0000_next.sql"), "SELECT 1;");
const nextRelease: MigrationChain = { name: "next", folder: unapplied, bookkeepingTable: "migrations_next" };

afterAll(() => {
  rmSync(unapplied, { recursive: true, force: true });
});

afterEach(async () => {
  await database().owner.unsafe("DELETE FROM drizzle.migrations_core WHERE hash = 'later-release'");
});

function ready(options: { migrations?: MigrationChain[]; url?: string } = {}) {
  const logger = recordingLogger();
  const server = createServer({
    config: serverConfig({ NODE_ENV: "test", DATABASE_URL: options.url ?? appUrl() }),
    adapters: adapters(),
    modules: [],
    migrations: options.migrations ?? [],
    logger,
    database: fakeDatabase(),
  });
  return { logger, ask: () => server.fetch(new Request("http://localhost/ready")) };
}

interface Ready {
  database: string;
  migrations: { expected: number; applied: number | null };
}

describe("GET /ready", () => {
  it("answers 200 when the database is reachable and at the level of the build", async () => {
    const { ask, logger } = ready();
    const response = await ask();
    const body = (await response.json()) as Ready;
    expect(response.status).toBe(200);
    expect(body.database).toBe("ok");
    expect(body.migrations.expected).toBeGreaterThan(0);
    expect(body.migrations.applied).toBe(body.migrations.expected);
    expect(logger.entries.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("answers 503 with the same shape while the database is behind the build", async () => {
    const level = (await (await ready().ask()).json()) as Ready;
    const response = await ready({ migrations: [nextRelease] }).ask();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      database: "ok",
      migrations: { expected: level.migrations.expected + 1, applied: level.migrations.expected },
    });
  });

  it("logs a warning and stays ready when the database is ahead of the build", async () => {
    await database().owner.unsafe("INSERT INTO drizzle.migrations_core (hash, created_at) VALUES ('later-release', 4102444800000)");
    const { ask, logger } = ready();
    const response = await ask();
    const body = (await response.json()) as Ready;
    expect(response.status).toBe(200);
    expect(body.migrations.applied).toBe(body.migrations.expected);
    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ unknownApplied: 1 });
  });

  it("answers 503 when the bookkeeping tables cannot be read, never ready", async () => {
    await database().owner.unsafe("REVOKE SELECT ON drizzle.migrations_core FROM slugbase_app");
    try {
      const response = await ready().ask();
      expect(response.status).toBe(503);
      expect(((await response.json()) as Ready).migrations.applied).toBeNull();
    } finally {
      await database().owner.unsafe("GRANT SELECT ON drizzle.migrations_core TO slugbase_app");
    }
  });
});
