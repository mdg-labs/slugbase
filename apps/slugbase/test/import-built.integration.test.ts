import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIND_ANY_PORT, boundPort, PLACEHOLDER_PORTS } from "./ephemeral-ports.ts";

// An import in the server the build leaves (doc 02 section 13.1, doc 01 section 8.1): `dist/main.js server`, run the way the image runs it, reads an import file on the import worker thread, the compiled module of
// `@slugbase/server` that the image carries next to the server it imports. A build whose output lacks the worker, or a server that cannot start it, fails this test; nothing reads the file on the request thread instead.

const APP = resolve(import.meta.dirname, "..");
const BUILD_TIMEOUT_MS = 180_000;
const ORIGIN = "https://bookmarks.example.com";

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

function send(port: number, head: string, body: Buffer): Promise<string> {
  return new Promise((resolveAnswer) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      resolveAnswer(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", () => undefined);
    socket.write(Buffer.concat([Buffer.from(`${head}Content-Length: ${String(body.byteLength)}\r\nConnection: close\r\n\r\n`), body]));
  });
}

function json(port: number, path: string, cookie: string | undefined, value: unknown): Promise<string> {
  const head = `POST ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n${cookie === undefined ? "" : `Cookie: ${cookie}\r\n`}`;
  return send(port, head, Buffer.from(JSON.stringify(value)));
}

function upload(port: number, cookie: string, html: string): Promise<string> {
  const boundary = "----slugbase-import-built";
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bookmarks.html"\r\nContent-Type: text/html\r\n\r\n${html}\r\n--${boundary}--\r\n`);
  return send(port, `POST /api/v1/import/netscape HTTP/1.1\r\nHost: localhost\r\nOrigin: ${ORIGIN}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nCookie: ${cookie}\r\n`, body);
}

describe("the built server and the import worker", () => {
  let outDir: string;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    outDir = mkdtempSync(join(tmpdir(), "slugbase-import-build-"));
    symlinkSync(join(APP, "node_modules"), join(outDir, "node_modules"));
    const built = spawnSync(process.execPath, [join(APP, "scripts/build.ts"), join(outDir, "dist")], {
      cwd: APP,
      env: { PATH: process.env["PATH"] ?? "", BUILD_COMMIT: "0123456789abcdef0123456789abcdef01234567" },
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
    });
    expect(built.status, `${built.stdout}${built.stderr}`).toBe(0);
    writeFileSync(join(outDir, "dist", "package.json"), '{"type":"module"}\n');
  }, BUILD_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await database.drop();
  }, 300_000);

  it("ships the worker module in the server package it imports, and imports a JSON file and an upload through it", async () => {
    // The server bundle imports `@slugbase/server` by name; its compiled import worker is the file the image copies with it.
    const serverEntry = fileURLToPath(import.meta.resolve("@slugbase/server"));
    expect(existsSync(join(dirname(serverEntry), "import-worker", "worker.js"))).toBe(true);

    const child = spawn(process.execPath, [...BIND_ANY_PORT, join(outDir, "dist", "main.js"), "server"], {
      cwd: outDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        NODE_ENV: "test",
        APP_ORIGIN: ORIGIN,
        DATABASE_URL: databaseUrl(database),
        DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
        SESSION_SECRET: randomBytes(48).toString("base64url"),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        ENCRYPTION_KEY_ID: "k1",
        SETUP_ENABLED: "true",
        SETUP_TOKEN_REQUIRED: "false",
        PORT: PLACEHOLDER_PORTS.PORT,
        METRICS_PORT: PLACEHOLDER_PORTS.METRICS_PORT,
      },
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    try {
      expect(await listening, output).toBe(true);
      const port = boundPort(output, "Listening");
      if (port === undefined) {
        throw new Error(`the server did not log its port\n${output}`);
      }
      // The server answers /ready 503 until its migration is done.
      let ready = "";
      for (const deadline = Date.now() + 40_000; Date.now() < deadline && !ready.startsWith("HTTP/1.1 200 "); ) {
        ready = await send(port, "GET /ready HTTP/1.1\r\nHost: localhost\r\n", Buffer.alloc(0));
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
      expect(ready, output).toMatch(/^HTTP\/1\.1 200 /);
      const created = await json(port, "/api/v1/setup", undefined, { displayName: "Ada", email: "ada@example.test", password: "a long enough password for ada", workspaceName: "Home" });
      const cookie = /set-cookie: (__Host-slugbase_session=[A-Za-z0-9_-]+)/i.exec(created)?.[1] ?? "";
      expect(cookie, created).not.toBe("");

      const asJson = await json(port, "/api/v1/import/json", cookie, [{ url: "https://example.com/json-one", title: "One", tags: ["t"] }, { url: "https://example.com/json-two" }]);
      const asUpload = await upload(port, cookie, '<DL><DT><H3>Reading</H3><DL><DT><A HREF="https://example.com/html-one" TAGS="a, b">Html one</A></DL></DL>');

      expect(asJson, output).toMatch(/^HTTP\/1\.1 200 /);
      expect(asJson).toContain('"created":2');
      expect(asUpload, output).toMatch(/^HTTP\/1\.1 200 /);
      expect(asUpload).toContain('"created":1');
      expect(asUpload).toContain('"foldersCreated":1');
      child.kill("SIGTERM");
      expect(await exited, output).toBe(0);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }, 180_000);
});
