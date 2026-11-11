import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIND_ANY_PORT, boundPort, PLACEHOLDER_PORTS } from "./ephemeral-ports.ts";

// `slugbase server --with-worker` (Q11, doc 01 section 2.1): the server and the worker in one process, run here as
// a process the way the image runs it, after `migrate` as the entrypoint does. The scenario is the one a smallest
// install depends on: a request queues a job and, with no second process, the job is carried out.

const APP = resolve(import.meta.dirname, "..");

const base = {
  NODE_ENV: "test",
  APP_ORIGIN: "https://bookmarks.example.com",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
  PORT: PLACEHOLDER_PORTS.PORT,
  PUBLIC_REGISTRATION: "true",
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

// What the entrypoint does before the server starts: `migrate` as the migrator, whose URL the process then never sees.
function migrate(database: TestDatabase): void {
  const result = spawnSync(process.execPath, ["src/main.ts", "migrate"], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...base, DATABASE_URL: databaseUrl(database), DATABASE_MIGRATE_URL: databaseUrl(database, "owner") },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function request(port: number, raw: string): Promise<string> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", () => undefined);
    socket.write(raw);
  });
}

function get(port: number, path: string): Promise<string> {
  return request(port, `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
}

// The body of a plain HTTP/1.1 response, whether it is sent with a length or chunked.
function bodyOf(response: string): string {
  const separator = response.indexOf("\r\n\r\n");
  const head = response.slice(0, separator).toLowerCase();
  const raw = response.slice(separator + 4);
  if (!head.includes("transfer-encoding: chunked")) {
    return raw;
  }
  let rest = raw;
  let body = "";
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (lineEnd < 0 || Number.isNaN(size) || size === 0) {
      return body;
    }
    body += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

function register(port: number, email: string): Promise<string> {
  const body = JSON.stringify({ displayName: "Ada", email, password: "a long enough password for ada" });
  return request(
    port,
    `POST /api/v1/auth/register HTTP/1.1\r\nHost: localhost\r\nOrigin: ${base.APP_ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.on("error", () => {
      resolveConnect(false);
    });
  });
}

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  /** The port of the metrics listener, when `METRICS_PORT` was set. */
  readonly metricsPort?: number;
  output(): string;
  /** Resolves with the exit status once the process has ended. */
  exited: Promise<number | null>;
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await check()); ) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

// How long a start that migrates an unmigrated database waits for /ready, which answers 503 until the whole chain is
// applied (D25). Applying it takes about 10 s on an idle host and was seen taking over 30 s on a runner that was also
// running other database tests, so it gets 90 s; an already-migrated database is ready in a second or two and keeps
// the 30 s default. With the 30 s to listen and the 30 s for the worker that follow, a start that is slow at every
// step still fits the test's 180 s timeout together with the job and the shutdown.
const MIGRATING_READY_TIMEOUT_MS = 90_000;

// Starts `server` with `args` and waits until it listens and answers /ready 200, which is after the migration level is
// checked; with the worker, also until it logged `Worker started`.
async function startServer(
  database: TestDatabase,
  args: readonly string[],
  migrateOnStart = false,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Running> {
  const child = spawn(process.execPath, [...BIND_ANY_PORT, "src/main.ts", "server", ...args], {
    cwd: APP,
    env: {
      PATH: process.env["PATH"] ?? "",
      ...base,
      ...extraEnv,
      DATABASE_URL: databaseUrl(database),
      ...(migrateOnStart ? { MIGRATE_ON_START: "true", DATABASE_MIGRATE_URL: databaseUrl(database, "owner") } : { MIGRATE_ON_START: "false" }),
    },
  });
  let output = "";
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code) => {
      resolveExit(code);
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
  }
  const running = { child, output: () => output, exited };
  try {
    await until(() => boundPort(output, "Listening") !== undefined, "the server to listen");
    const port = boundPort(output, "Listening") ?? 0;
    await until(
      async () => (await get(port, "/ready")).startsWith("HTTP/1.1 200 "),
      "/ready to answer 200",
      migrateOnStart ? MIGRATING_READY_TIMEOUT_MS : undefined,
    );
    if (args.includes("--with-worker")) {
      await until(() => output.includes('"Worker started"'), "the worker to start");
    }
    const metricsPort = boundPort(output, "Metrics listening");
    return { ...running, port, ...(metricsPort === undefined ? {} : { metricsPort }) };
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
}

async function stop(running: Running): Promise<number | null> {
  running.child.kill("SIGTERM");
  const timer = setTimeout(() => running.child.kill("SIGKILL"), 30_000);
  try {
    return await running.exited;
  } finally {
    clearTimeout(timer);
  }
}

// The harness only hands out clones of a migrated template, so a database that has never been migrated is made from a
// clone by dropping what `migrate` creates, as the owner that created it: the three schemas, and with `public` the
// extensions and tenant functions in it. `public` is then created again with the access it has in a fresh database.
async function unmigrate(database: TestDatabase): Promise<void> {
  await database.owner.unsafe("DROP SCHEMA drizzle CASCADE; DROP SCHEMA pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC");
}

function logLines(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface JobRow {
  readonly name: string;
  readonly state: string;
}

// The `workspace.created` event job that registering an account queues in its own transaction.
async function eventJobs(database: TestDatabase): Promise<JobRow[]> {
  return [...(await database.app<JobRow[]>`SELECT name, state FROM pgboss.job WHERE name = 'event.workspace.created' ORDER BY created_on`)];
}

// The connections of the worker's pool, which sets this `application_name` (packages/server/src/worker/runtime.ts).
async function workerConnections(database: TestDatabase): Promise<number> {
  const open = await database.owner<{ count: string }[]>`
    SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = 'slugbase-worker'`;
  return Number(open[0]?.count);
}

describe("apps/slugbase main server --with-worker", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    migrate(database);
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  it("becomes ready and carries out a job a request queued, with no separate worker", async () => {
    const running = await startServer(database, ["--with-worker"]);
    try {
      expect(running.output()).toContain("Configuration loaded");
      expect((await register(running.port, "ada@example.test")).split("\r\n")[0]).toBe("HTTP/1.1 202 Accepted");
      // The control for the next test's count of zero: a worker that runs shows up in the same query.
      expect(await workerConnections(database)).toBeGreaterThan(0);
      await until(async () => (await eventJobs(database)).some((job) => job.state === "completed"), "the queued job to complete");
    } finally {
      expect(await stop(running), running.output()).toBe(0);
    }
    expect(await eventJobs(database)).toEqual([{ name: "event.workspace.created", state: "completed" }]);
  }, 90_000);

  it("leaves that job queued when the server runs without the flag, so the job above was the worker's", async () => {
    const other = await createTestDatabase();
    try {
      migrate(other);
      const running = await startServer(other, []);
      try {
        expect((await register(running.port, "grace@example.test")).split("\r\n")[0]).toBe("HTTP/1.1 202 Accepted");
        expect(await workerConnections(other)).toBe(0);
        // Nothing can be polled for here, so this waits longer than the worker's polling interval, within which the
        // job above completed; the count above is the proof that no worker ran.
        await sleep(5_000);
        expect(await eventJobs(other)).toEqual([{ name: "event.workspace.created", state: "created" }]);
      } finally {
        expect(await stop(running), running.output()).toBe(0);
      }
    } finally {
      await other.drop();
    }
  }, 90_000);

  it("serves the worker's samples on the server's one metrics listener, each family declared once", async () => {
    const running = await startServer(database, ["--with-worker"], false, { METRICS_PORT: PLACEHOLDER_PORTS.METRICS_PORT });
    try {
      const metricsPort = running.metricsPort ?? 0;
      expect(metricsPort).toBeGreaterThan(0);
      let text = "";
      await until(async () => {
        const response = await get(metricsPort, "/metrics");
        // A scrape answers 500 while the worker cannot read its queues yet, as it can just after the start: that is
        // a reason to poll again, not a failure; the deadline still fails a scrape that never succeeds.
        if (response.split("\r\n")[0] !== "HTTP/1.1 200 OK") {
          return false;
        }
        text = bodyOf(response);
        return text.includes('slugbase_job_queue_depth{queue="mail.send",state="ready",process="worker"}');
      }, "the worker's job queue samples");

      expect(text).toMatch(/^slugbase_db_pool_size 10$/m);
      expect(text).toMatch(/^slugbase_db_pool_size\{process="worker"\} 5$/m);
      expect(text).toMatch(/^slugbase_db_tenant_transactions_in_flight\{process="worker"\} \d+$/m);
      const declarations = text.split("\n").filter((line) => line.startsWith("# "));
      expect(new Set(declarations).size).toBe(declarations.length);
      const samples = text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
      expect(new Set(samples.map((line) => line.slice(0, line.lastIndexOf(" ")))).size).toBe(samples.length);
      // The worker opens no listener of its own: the process logs the one it has.
      expect(logLines(running.output()).filter((line) => line["msg"] === "Metrics listening")).toHaveLength(1);
    } finally {
      expect(await stop(running), running.output()).toBe(0);
    }
  }, 90_000);

  it("stops on SIGTERM: stops listening, drains the worker, closes both and exits 0", async () => {
    const running = await startServer(database, ["--with-worker"]);
    expect(await canConnect(running.port)).toBe(true);
    const status = await stop(running);
    const output = running.output();
    expect(status, output).toBe(0);
    // The logger writes asynchronously and a line still in flight can land after the one `process.exit` flushed, so the
    // order is read from each line's own timestamp, not from its place in the output.
    const at = (message: string): number => {
      const entry = logLines(output).find((line) => line["msg"] === message);
      expect(entry, `a "${message}" line in\n${output}`).toBeDefined();
      return Number(entry?.["time"]);
    };
    expect(at("Shutting down")).toBeLessThanOrEqual(at("Server stopped"));
    expect(at("Shutting down")).toBeLessThanOrEqual(at("Worker stopped"));
    expect(at("Shutdown complete")).toBeGreaterThanOrEqual(at("Server stopped"));
    expect(at("Shutdown complete")).toBeGreaterThanOrEqual(at("Worker stopped"));
    expect(await canConnect(running.port)).toBe(false);
    expect(await workerConnections(database)).toBe(0);
  }, 90_000);

  it("migrates an unmigrated database before the worker starts and then carries out a job", async () => {
    const fresh = await createTestDatabase();
    try {
      await unmigrate(fresh);
      expect(await fresh.owner`SELECT 1 FROM pg_namespace WHERE nspname IN ('drizzle', 'pgboss')`).toHaveLength(0);
      const running = await startServer(fresh, ["--with-worker"], true);
      try {
        const output = running.output();
        // The order is read from each line's own timestamp (see the shutdown test).
        const at = (message: string): number => {
          const entry = logLines(output).find((line) => line["msg"] === message);
          expect(entry, `a "${message}" line in\n${output}`).toBeDefined();
          return Number(entry?.["time"]);
        };
        expect(at("The database is migrated")).toBeLessThanOrEqual(at("Worker started"));
        expect((await register(running.port, "edsger@example.test")).split("\r\n")[0]).toBe("HTTP/1.1 202 Accepted");
        await until(async () => (await eventJobs(fresh)).some((job) => job.state === "completed"), "the queued job to complete");
      } finally {
        expect(await stop(running), running.output()).toBe(0);
      }
      expect(await eventJobs(fresh)).toEqual([{ name: "event.workspace.created", state: "completed" }]);
    } finally {
      await fresh.drop();
    }
  }, 180_000);

  it("shuts down what started when the signal arrives while it starts", async () => {
    const child = spawn(process.execPath, [...BIND_ANY_PORT, "src/main.ts", "server", "--with-worker"], {
      cwd: APP,
      env: { PATH: process.env["PATH"] ?? "", ...base, DATABASE_URL: databaseUrl(database), MIGRATE_ON_START: "false" },
    });
    let output = "";
    let sent = false;
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("close", (code) => {
        resolveExit(code);
      });
    });
    const watch = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (!sent && output.includes('"Configuration loaded"')) {
        sent = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      expect(await exited, output).toBe(0);
      expect(output).toContain("Server stopped");
      expect(output).toContain("Worker stopped");
      expect(output).toContain("Shutdown complete");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }, 60_000);
});
