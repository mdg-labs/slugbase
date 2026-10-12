import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

function start(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, ["src/main.ts", ...args], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        resolvePort(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
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

// Starts the server command, waits until it listens, asks it for a path, sends
// SIGTERM and waits for the exit.
async function runServer(env: Record<string, string>, ...args: string[]): Promise<RunningProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/main.ts", ...args], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", PORT: String(port), ...env },
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
      if (output.includes('"Listening"')) {
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
    const response = (await listening) ? await get(port, "/no-such-path") : "";
    child.kill("SIGTERM");
    return { status: await exited, output, response };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

describe("apps/slugbase main", () => {
  it("starts the server, answers through the middleware chain and exits 0 on SIGTERM", async () => {
    const { status, output, response } = await runServer(valid);
    expect(status, output).toBe(0);
    expect(output).toContain("Configuration loaded");
    expect(output).toContain("Shutdown complete");
    expect(response).toMatch(/^HTTP\/1\.1 404 /);
    expect(response).toContain('"code":"not_found"');
  });

  it("answers with an X-Request-Id and writes one pino line per request without the raw path", async () => {
    const { status, output, response } = await runServer(valid);
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
    const { status, output } = await runServer(valid, "server");
    expect(status, output).toBe(0);
    expect(output).toContain('"Listening"');
  });

  it.each(["worker", "migrate"])("accepts the %s command", (command) => {
    expect(start(valid, command).status).toBe(0);
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
        env: { PATH: process.env["PATH"] ?? "", ...valid, PORT: String(port) },
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
    expect(start(migrateOnly, "migrate").status).toBe(0);
    expect(start(migrateOnly, "worker").status).toBe(1);
  });

  it("warns once about unknown SLUGBASE_* keys, naming keys only", async () => {
    const { status, output } = await runServer({ ...valid, SLUGBASE_NOT_A_KEY: "value-qx72" });
    expect(status).toBe(0);
    expect(output).toContain("SLUGBASE_NOT_A_KEY");
    expect(output).not.toContain("value-qx72");
    expect(output.match(/Unknown SLUGBASE_/g)).toHaveLength(1);
  });

  it("exits non-zero for an unknown command", () => {
    const { status, output } = start(valid, "serve");
    expect(status).toBe(2);
    expect(output).toContain("Unknown command");
  });
});
