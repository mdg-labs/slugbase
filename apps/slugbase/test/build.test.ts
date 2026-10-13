import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBuildInfo } from "@slugbase/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderBuildInfo, sourceCommit } from "../scripts/build-info.ts";

// `pnpm --filter slugbase build` leaves one directory holding the server bundle, the web
// assets and the build-info file; the tests build into a directory of their own and run the
// server command from it, the way the image does.

const APP = resolve(import.meta.dirname, "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_TIMEOUT_MS = 180_000;

describe("renderBuildInfo", () => {
  it("holds the four members of the version contract and an RFC 3339 UTC time", () => {
    expect(renderBuildInfo({ version: "1.2.3", commit: COMMIT, now: new Date("2026-03-04T05:06:07.891Z") })).toEqual({
      name: "SlugBase",
      version: "1.2.3",
      commit: COMMIT,
      builtAt: "2026-03-04T05:06:07Z",
    });
  });

  it("refuses an empty version or commit", () => {
    expect(() => renderBuildInfo({ version: "", commit: COMMIT, now: new Date() })).toThrow();
    expect(() => renderBuildInfo({ version: "1.2.3", commit: "", now: new Date() })).toThrow();
  });
});

describe("sourceCommit", () => {
  it("takes BUILD_COMMIT when it is set, wherever the build runs", () => {
    expect(sourceCommit({ BUILD_COMMIT: COMMIT }, tmpdir())).toBe(COMMIT);
  });

  it("reads HEAD of the checkout otherwise", () => {
    expect(sourceCommit({}, APP)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("stops outside a checkout instead of inventing a revision", () => {
    const outside = mkdtempSync(join(tmpdir(), "slugbase-no-git-"));
    try {
      expect(() => sourceCommit({ BUILD_COMMIT: "" }, outside)).toThrow(/BUILD_COMMIT/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

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

// A raw HTTP/1.1 exchange: the bundle under test is the only peer, and nothing here leaves the machine.
function fetchText(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      resolveBody({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), body: text.slice(split + 4) });
    });
    socket.on("error", () => undefined);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept: text/html\r\nConnection: close\r\n\r\n`);
  });
}

describe("the build output", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "slugbase-app-build-"));
    // The bundle imports the workspace packages by name; a directory outside the app finds them through this link.
    symlinkSync(join(APP, "node_modules"), join(outDir, "node_modules"));
    const built = spawnSync(process.execPath, [join(APP, "scripts/build.ts"), join(outDir, "dist")], {
      cwd: APP,
      env: { PATH: process.env["PATH"] ?? "", BUILD_COMMIT: COMMIT },
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
    });
    expect(built.status, `${built.stdout}${built.stderr}`).toBe(0);
    writeFileSync(join(outDir, "dist", "package.json"), '{"type":"module"}\n');
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("is one directory with the server bundle, the web assets and the build-info file", () => {
    const dist = join(outDir, "dist");
    expect(existsSync(join(dist, "main.js"))).toBe(true);
    expect(existsSync(join(dist, "web", "index.html"))).toBe(true);
    expect(readdirSync(join(dist, "web", "assets")).some((name) => name.endsWith(".js"))).toBe(true);
    expect(existsSync(join(dist, "build-info.json"))).toBe(true);
  });

  it("writes the version of the app's package.json, the commit and a build time", () => {
    const manifest = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { version: string };
    const info = loadBuildInfo(join(outDir, "dist", "build-info.json"));
    expect(info).toMatchObject({ name: "SlugBase", version: manifest.version, commit: COMMIT });
    expect(info.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("holds an index.html with one external script and no inline script", () => {
    const html = readFileSync(join(outDir, "dist", "web", "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*>[^<]*/gi)].map((match) => match[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^<script\b[^>]*\bsrc="\/assets\/[^"]+\.js"[^>]*>$/);
  });

  it("is served by `main.js server`: /version reads the build-info file and / is the built index.html", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [join(outDir, "dist", "main.js"), "server"], {
      cwd: outDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        PORT: String(port),
        NODE_ENV: "test",
        APP_ORIGIN: "https://bookmarks.example.com",
        DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
        DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
        SESSION_SECRET: randomBytes(48).toString("base64url"),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        ENCRYPTION_KEY_ID: "k1",
        MIGRATE_ON_START: "false",
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
      expect(await listening, output).toBe(true);
      expect(output).not.toContain("There is no web build");
      const version = await fetchText(port, "/version");
      const page = await fetchText(port, "/");
      child.kill("SIGTERM");
      expect(await exited, output).toBe(0);
      expect(version.status).toBe(200);
      expect(JSON.parse(version.body)).toEqual(loadBuildInfo(join(outDir, "dist", "build-info.json")));
      expect(page.status).toBe(200);
      expect(page.body).toBe(readFileSync(join(outDir, "dist", "web", "index.html"), "utf8"));
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }, 60_000);
});
