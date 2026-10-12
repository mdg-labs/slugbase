import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The worker command needs a database: it starts pg-boss against it. The
// tests run the entry point as a process, the way the image does.

const APP = resolve(import.meta.dirname, "..");

const valid = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
};

interface PgBossModule {
  getConstructionPlans(schema: string, options: { createSchema: boolean }): string;
}

// The app does not depend on pg-boss; the server package does. Until `migrate`
// installs the pg-boss schema, the test installs it the way `migrate` will.
async function loadPgBoss(): Promise<PgBossModule> {
  const fromServer = createRequire(resolve(APP, "../../packages/server/package.json"));
  return (await import(pathToFileURL(fromServer.resolve("pg-boss")).href)) as PgBossModule;
}

function databaseUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

interface WorkerRun {
  status: number | null;
  output: string;
  instances: number;
}

// Starts the worker command, waits until it reports that it started, counts the
// pg-boss instances registered in the database, sends SIGTERM and waits for the exit.
async function runWorker(database: TestDatabase): Promise<WorkerRun> {
  const child = spawn(process.execPath, ["src/main.ts", "worker"], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...valid, NODE_ENV: "test", DATABASE_URL: databaseUrl(database) },
  });
  let output = "";
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code) => {
      resolveExit(code);
    });
  });
  const started = new Promise<boolean>((resolveStarted) => {
    const watch = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes('"Worker started"')) {
        resolveStarted(true);
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    void exited.then(() => {
      resolveStarted(false);
    });
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    let instances = 0;
    if (await started) {
      const rows = await database.app<{ count: string }[]>`SELECT count(*) FROM pgboss.instance`;
      instances = Number(rows[0]?.count);
    }
    child.kill("SIGTERM");
    return { status: await exited, output, instances };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

describe("apps/slugbase main worker", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  it("fails to start, naming no secret, and without a worker while the pg-boss schema is not installed", async () => {
    const { status, output, instances } = await runWorker(database);
    expect(status).toBe(1);
    expect(instances).toBe(0);
    expect(output).not.toContain('"Worker started"');
    expect(output).toContain("pg-boss is not installed");
    expect(output).not.toContain("slugbase_app_dev_only");
  }, 60_000);

  it("starts pg-boss as slugbase_app, registers itself and exits 0 on SIGTERM", async () => {
    const pgBoss = await loadPgBoss();
    // The plans carry their own BEGIN and COMMIT, which need one session.
    const session = await database.owner.reserve();
    try {
      await session.unsafe(pgBoss.getConstructionPlans("pgboss", { createSchema: false }));
    } finally {
      session.release();
    }

    const { status, output, instances } = await runWorker(database);
    expect(status, output).toBe(0);
    expect(output).toContain("Worker started");
    expect(output).toContain("Shutdown complete");
    expect(instances).toBeGreaterThan(0);
  }, 60_000);
});
