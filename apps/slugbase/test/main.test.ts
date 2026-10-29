import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BIND_ANY_PORT, boundPort, PLACEHOLDER_PORTS } from "./ephemeral-ports.ts";

// The entry point validates the configuration of its process type before
// anything else (doc 01 section 3 rule 5). The tests run it as a process, the
// way the image does.

const APP = resolve(import.meta.dirname, "..");

const SESSION_SECRET = randomBytes(48).toString("base64url");
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

const valid = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET,
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_ID: "k1",
};

// A server that starts without a database behind it: outside production it does not check the role of
// DATABASE_URL, and it does not migrate. The tests of the migration and of that check have a database
// of their own in main.integration.test.ts.
const standalone = { ...valid, NODE_ENV: "test", MIGRATE_ON_START: "false" };

function start(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, ["src/main.ts", ...args], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function get(port: number, path: string): Promise<string> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", () => undefined);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

interface RunningProcess {
  status: number | null;
  output: string;
  response: string;
}

// Starts the server command on a port the kernel picks when the child binds it, waits until it listens, asks it
// for a path, sends SIGTERM and waits for the exit.
async function runServer(env: Record<string, string>, ...args: string[]): Promise<RunningProcess> {
  const child = spawn(process.execPath, [...BIND_ANY_PORT, "src/main.ts", ...args], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", PORT: PLACEHOLDER_PORTS.PORT, ...env },
  });
  let output = "";
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code) => {
      resolveExit(code);
    });
  });
  const listening = new Promise<boolean>((resolveListening) => {
    const watch = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (boundPort(output, "Listening") !== undefined) {
        resolveListening(true);
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    void exited.then(() => {
      resolveListening(false);
    });
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const port = (await listening) ? boundPort(output, "Listening") : undefined;
    const response = port === undefined ? "" : await get(port, "/no-such-path");
    child.kill("SIGTERM");
    return { status: await exited, output, response };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

// Every test starts the app as a child process, whose cold start alone can approach vitest's 5 s
// default on a busy runner; the tests get the bound the child processes already have.
describe("apps/slugbase main", { timeout: 60_000 }, () => {
  it("starts the server, answers through the middleware chain and exits 0 on SIGTERM", async () => {
    const { status, output, response } = await runServer(standalone);
    expect(status, output).toBe(0);
    expect(output).toContain("Configuration loaded");
    expect(output).toContain("Shutdown complete");
    expect(response).toMatch(/^HTTP\/1\.1 404 /);
    expect(response).toContain('"code":"not_found"');
  });

  it("answers with an X-Request-Id and writes one pino line per request without the raw path", async () => {
    const { status, output, response } = await runServer(standalone);
    expect(status, output).toBe(0);
    const requestId = /^x-request-id: (\S+)$/im.exec(response)?.[1];
    expect(requestId).toBeDefined();
    const lines = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const requests = lines.filter((line) => line["msg"] === "Request completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ level: "info", requestId, route: "unmatched", status: 404, method: "GET" });
    expect(output).not.toContain("no-such-path");
  });

  it("starts the server for the server command", async () => {
    const { status, output } = await runServer(standalone, "server");
    expect(status, output).toBe(0);
    expect(output).toContain('"Listening"');
  });

  it("serves /metrics on METRICS_PORT only, and the public port answers 404 not_found for it", async () => {
    const child = spawn(process.execPath, [...BIND_ANY_PORT, "src/main.ts", "server"], {
      cwd: APP,
      env: { PATH: process.env["PATH"] ?? "", ...standalone, ...PLACEHOLDER_PORTS },
    });
    let output = "";
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("close", (code) => {
        resolveExit(code);
      });
    });
    const listening = new Promise<boolean>((resolveListening) => {
      const watch = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        if (output.includes('"Metrics listening"')) {
          resolveListening(true);
        }
      };
      child.stdout.on("data", watch);
      child.stderr.on("data", watch);
      void exited.then(() => {
        resolveListening(false);
      });
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      expect(await listening, output).toBe(true);
      const publicPort = boundPort(output, "Listening");
      const metricsPort = boundPort(output, "Metrics listening");
      if (publicPort === undefined || metricsPort === undefined) {
        throw new Error(`a listener did not log its port\n${output}`);
      }
      // The child asked the kernel for both ports, so they are never the configured ones and never one port.
      expect(new Set([publicPort, metricsPort, ...Object.values(PLACEHOLDER_PORTS).map(Number)]).size).toBe(4);
      const scraped = await get(metricsPort, "/metrics");
      const publicAnswer = await get(publicPort, "/metrics");
      child.kill("SIGTERM");
      expect(await exited, output).toBe(0);
      expect(scraped).toMatch(/^HTTP\/1\.1 200 /);
      expect(scraped).toContain("# TYPE slugbase_http_requests_total counter");
      expect(publicAnswer).toMatch(/^HTTP\/1\.1 404 /);
      expect(publicAnswer).toContain('"code":"not_found"');
      expect(publicAnswer).not.toContain("slugbase_http_requests_total");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  });

  it("runs the migrate command, and exits non-zero naming no connection string when the database cannot be reached", () => {
    const { status, output } = start(valid, "migrate");
    expect(status, output).toBe(1);
    expect(output).toContain("Configuration loaded");
    expect(output).not.toContain("Zq8-prod-mig-pw");
    expect(output).not.toContain("postgres://");
  });

  it("exits non-zero when the port is taken", async () => {
    const holder = createServer();
    const port = await new Promise<number>((resolvePort) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolvePort(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    try {
      const result = spawnSync(process.execPath, ["src/main.ts", "server"], {
        cwd: APP,
        env: { PATH: process.env["PATH"] ?? "", ...standalone, PORT: String(port) },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("EADDRINUSE");
    } finally {
      holder.close();
    }
  });

  it("exits non-zero naming the key and never the value when SESSION_SECRET is weak", () => {
    const { status, output } = start({ ...valid, SESSION_SECRET: "weak-secret-qx70" });
    expect(status).toBe(1);
    expect(output).toContain("SESSION_SECRET");
    expect(output).not.toContain("weak-secret-qx70");
    expect(output).not.toContain("Configuration loaded");
  });

  it("refuses an http APP_ORIGIN in production and a development default", () => {
    const { status, output } = start({
      ...valid,
      APP_ORIGIN: "http://insecure-qx71.example.com",
      DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@localhost:54329/slugbase_dev",
    });
    expect(status).toBe(1);
    expect(output).toContain("APP_ORIGIN");
    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain("insecure-qx71");
    expect(output).not.toContain("slugbase_app_dev_only");
  });

  it("refuses to start without any environment", () => {
    const { status, output } = start({});
    expect(status).toBe(1);
    expect(output).toContain("NODE_ENV");
  });

  it("validates the schema of the command it runs", () => {
    const migrateOnly = { NODE_ENV: valid.NODE_ENV, DATABASE_MIGRATE_URL: valid.DATABASE_MIGRATE_URL };
    // The migrate command needs nothing but its own keys: it gets as far as the database.
    expect(start(migrateOnly, "migrate").output).toContain("Configuration loaded");
    const worker = start(migrateOnly, "worker");
    expect(worker.status).toBe(1);
    expect(worker.output).toContain("DATABASE_URL");
  });

  it("warns once about unknown SLUGBASE_* keys, naming keys only", async () => {
    const { status, output } = await runServer({ ...standalone, SLUGBASE_NOT_A_KEY: "value-qx72" });
    expect(status).toBe(0);
    expect(output).toContain("SLUGBASE_NOT_A_KEY");
    expect(output).not.toContain("value-qx72");
    expect(output.match(/Unknown SLUGBASE_/g)).toHaveLength(1);
  });

  it("builds the secret box from the configured keys before it serves, and logs no key", async () => {
    const previous = randomBytes(32).toString("base64");
    const { status, output } = await runServer({ ...standalone, ENCRYPTION_KEY_PREVIOUS: `k0:${previous}` });
    expect(status, output).toBe(0);
    const lines = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ready = lines.findIndex((line) => line["msg"] === "Secret box ready");
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(lines[ready]).toMatchObject({ keyId: "k1", previousKeys: 1 });
    expect(ready).toBeLessThan(lines.findIndex((line) => line["msg"] === "Listening"));
    expect(output).not.toContain(ENCRYPTION_KEY);
    expect(output).not.toContain(previous);
  });

  it("builds the rate limiter before it serves, without connecting to the database to do so", async () => {
    // `standalone` names a database host that does not exist: a limiter that connected at start-up could not.
    const { status, output } = await runServer(standalone);
    expect(status, output).toBe(0);
    const messages = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => (JSON.parse(line) as Record<string, unknown>)["msg"]);
    const ready = messages.indexOf("Rate limiter ready");
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThan(messages.indexOf("Listening"));
  });

  it("refuses to start with a previous key that is not 32 bytes, naming the key and never the value", () => {
    const short = Buffer.alloc(16, 4).toString("base64");
    const { status, output } = start({ ...valid, ENCRYPTION_KEY_PREVIOUS: `k0:${short}` });
    expect(status).toBe(1);
    expect(output).toContain("ENCRYPTION_KEY_PREVIOUS");
    expect(output).not.toContain(short);
    expect(output).not.toContain("Configuration loaded");
  });

  it("exits non-zero for an unknown command", () => {
    const { status, output } = start(valid, "serve");
    expect(status).toBe(2);
    expect(output).toContain("Unknown command");
  });
});
