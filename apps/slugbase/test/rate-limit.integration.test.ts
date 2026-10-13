import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Stage 6 of the chain in the composed server (doc 01 section 4 step 6): the
// entry point is run as a process, the way the image does, with the Postgres
// token buckets behind the rate-limit port and the limits of the `RATE_LIMIT_*`
// keys. GET /api/config is the `public` bucket.

const APP = resolve(import.meta.dirname, "..");

const valid = {
  NODE_ENV: "test",
  APP_ORIGIN: "https://bookmarks.example.com",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
  MIGRATE_ON_START: "false",
  DATABASE_MIGRATE_URL: "",
};

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

interface Answer {
  readonly status: number;
  readonly headers: Map<string, string>;
  readonly body: string;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolveAnswer, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head = "", body = ""] = Buffer.concat(chunks).toString("utf8").split("\r\n\r\n");
      const [statusLine = "", ...lines] = head.split("\r\n");
      resolveAnswer({
        status: Number(statusLine.split(" ")[1]),
        headers: new Map(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()] as const)),
        body,
      });
    });
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${extra.join("")}\r\n`);
  });
}

// Starts the server command, waits until it listens, runs `during` against it,
// sends SIGTERM and waits for the exit.
async function withServer<T>(env: Record<string, string>, during: (port: number) => Promise<T>): Promise<T> {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/main.ts", "server"], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...valid, PORT: String(port), ...env },
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
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  try {
    expect(await listening, output).toBe(true);
    const result = await during(port);
    child.kill("SIGTERM");
    expect(await exited, output).toBe(0);
    return result;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

describe("apps/slugbase server rate limiting", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  it("answers GET /api/config with 429 after the configured burst, with the policy headers", async () => {
    await withServer({ DATABASE_URL: databaseUrl(database), RATE_LIMIT_PUBLIC_IP: "3/min" }, async (port) => {
      const answers: Answer[] = [];
      for (let request = 0; request < 4; request += 1) {
        answers.push(await get(port, "/api/config"));
      }
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 429]);
      expect(answers[0]?.headers.get("ratelimit-policy")).toBe('"public";q=3;w=60');
      expect(answers[0]?.headers.get("ratelimit")).toMatch(/^"public";r=2;t=\d+$/);
      expect(answers[3]?.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      expect(JSON.parse(answers[3]?.body ?? "{}")).toMatchObject({ code: "rate_limited", status: 429 });
    });
  }, 60_000);

  it("holds the limit against a client that rotates X-Forwarded-For entries beyond the trusted hop", async () => {
    await withServer({ DATABASE_URL: databaseUrl(database), RATE_LIMIT_PUBLIC_IP: "3/min", TRUSTED_PROXY_HOPS: "1" }, async (port) => {
      const statuses: number[] = [];
      for (let spoof = 1; spoof <= 6; spoof += 1) {
        statuses.push((await get(port, "/api/config", { "X-Forwarded-For": `192.0.2.${String(spoof)}, 198.51.100.7` })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
      expect((await get(port, "/api/config", { "X-Forwarded-For": "192.0.2.1, 198.51.100.8" })).status).toBe(200);
    });
  }, 60_000);

  it("does not limit the probes", async () => {
    await withServer({ DATABASE_URL: databaseUrl(database), RATE_LIMIT_PUBLIC_IP: "1/min" }, async (port) => {
      for (let request = 0; request < 4; request += 1) {
        expect((await get(port, "/health")).status).toBe(200);
      }
    });
  }, 60_000);

  it("answers 503 rather than leaving the route unthrottled when the bucket store cannot be reached", async () => {
    const unreachable = new URL(databaseUrl(database));
    unreachable.port = String(await freePort());
    await withServer({ DATABASE_URL: unreachable.href }, async (port) => {
      const answer = await get(port, "/api/config");
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.body)).toMatchObject({ code: "unavailable", status: 503 });
      expect(answer.body).not.toContain(unreachable.password);
    });
  }, 60_000);
});
