import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIND_ANY_PORT, PLACEHOLDER_PORTS } from "./ephemeral-ports.ts";

// A signal that arrives while a command is still starting must lead to an
// orderly shutdown, not to the default action of the signal. The tests send
// SIGTERM as soon as `Configuration loaded` appears, which is written before
// start-up begins, so the signal reliably arrives during it.

const APP = resolve(import.meta.dirname, "..");

const valid = {
  NODE_ENV: "test",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
};

function databaseUrl(database: TestDatabase, pool: "app" | "owner" = "app"): string {
  const { options } = database[pool];
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

function runMigrate(database: TestDatabase) {
  const result = spawnSync(process.execPath, ["src/main.ts", "migrate"], {
    cwd: APP,
    env: {
      PATH: process.env["PATH"] ?? "",
      ...valid,
      DATABASE_URL: databaseUrl(database),
      DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

// Starts the command, sends `signal` as soon as it has loaded its configuration, and waits for the exit. `nodeArgs`
// are Node options for the child: BIND_ANY_PORT lets a server bind a port the kernel picks.
async function runSignalled(
  command: "server" | "worker",
  env: Record<string, string>,
  signal: NodeJS.Signals = "SIGTERM",
  nodeArgs: readonly string[] = [],
): Promise<Run> {
  const child = spawn(process.execPath, [...nodeArgs, "src/main.ts", command], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...valid, ...env },
  });
  let output = "";
  let sent = false;
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on("close", (status, killedBy) => {
      resolveExit({ status, signal: killedBy });
    });
  });
  const watch = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (!sent && output.includes('"Configuration loaded"')) {
      sent = true;
      child.kill(signal);
    }
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    return { ...(await exited), output };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

describe("apps/slugbase main worker, signalled while it starts", () => {
  let migrated: TestDatabase;
  let bare: TestDatabase;

  beforeAll(async () => {
    migrated = await createTestDatabase();
    const result = runMigrate(migrated);
    expect(result.status, result.output).toBe(0);
    bare = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await migrated.drop();
    await bare.drop();
  }, 300_000);

  it("shuts down what started and exits 0 on SIGTERM", async () => {
    const { status, signal, output } = await runSignalled("worker", { DATABASE_URL: databaseUrl(migrated) });
    expect(signal, output).toBeNull();
    expect(status, output).toBe(0);
    expect(output).toContain("Shutting down");
    expect(output).toContain("Shutdown complete");
  }, 60_000);

  it("shuts down what started and exits 0 on SIGINT", async () => {
    const { status, signal, output } = await runSignalled("worker", { DATABASE_URL: databaseUrl(migrated) }, "SIGINT");
    expect(signal, output).toBeNull();
    expect(status, output).toBe(0);
    expect(output).toContain("Shutdown complete");
  }, 60_000);

  it("still exits non-zero when start-up fails", async () => {
    const { status, signal, output } = await runSignalled("worker", { DATABASE_URL: databaseUrl(bare) });
    expect(signal, output).toBeNull();
    expect(status, output).toBe(1);
    expect(output).toContain("pg-boss is not installed");
    expect(output).not.toContain("Shutdown complete");
  }, 60_000);
});

describe("apps/slugbase main server, signalled while it starts", () => {
  it("shuts down what started and exits 0 on SIGTERM", async () => {
    const { status, signal, output } = await runSignalled(
      "server",
      { MIGRATE_ON_START: "false", PORT: PLACEHOLDER_PORTS.PORT },
      "SIGTERM",
      BIND_ANY_PORT,
    );
    expect(signal, output).toBeNull();
    expect(status, output).toBe(0);
    expect(output).toContain("Shutting down");
    expect(output).toContain("Shutdown complete");
  }, 60_000);

  it("shuts down what started and exits 0 on SIGINT", async () => {
    const { status, signal, output } = await runSignalled(
      "server",
      { MIGRATE_ON_START: "false", PORT: PLACEHOLDER_PORTS.PORT },
      "SIGINT",
      BIND_ANY_PORT,
    );
    expect(signal, output).toBeNull();
    expect(status, output).toBe(0);
    expect(output).toContain("Shutdown complete");
  }, 60_000);

  it("still exits non-zero when start-up fails", async () => {
    const holder = createServer();
    const port = await new Promise<number>((resolvePort) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolvePort(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    try {
      const { status, signal, output } = await runSignalled("server", { MIGRATE_ON_START: "false", PORT: String(port) });
      expect(signal, output).toBeNull();
      expect(status, output).toBe(1);
      expect(output).not.toContain("Shutdown complete");
    } finally {
      holder.close();
    }
  }, 60_000);
});
