import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/create-server.ts";
import { adapters, fakeAuthStore, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// The web root over a real socket, where the request target reaches the server
// as the client wrote it (doc 01 section 7.1). The client is a raw socket: the
// repository allows no HTTP client outside the egress adapter.

const SECRET = "outside-the-web-root-5d21b8";
const INDEX = "<!doctype html><title>SlugBase</title>";

let base: string;
let listening: RunningServer | undefined;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "slugbase-static-socket-"));
  mkdirSync(join(base, "web", "assets"), { recursive: true });
  writeFileSync(join(base, "web", "index.html"), INDEX);
  writeFileSync(join(base, "web", "assets", "app-AbCd1234.js"), "app");
  writeFileSync(join(base, "secret.txt"), SECRET);
  symlinkSync(base, join(base, "web", "up"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

afterEach(async () => {
  await listening?.shutdown();
  listening = undefined;
});

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

function request(port: number, target: string, extra = "", method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const separator = raw.indexOf("\r\n\r\n");
      const [statusLine = "", ...lines] = raw.slice(0, separator).split("\r\n");
      const headers = new Headers();
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      resolve({ status: Number(statusLine.split(" ")[1]), headers, body: raw.slice(separator + 4) });
    });
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${extra}\r\n`);
  });
}

async function listen(): Promise<number> {
  const server = createServer({
    config: serverConfig(),
    adapters: adapters(),
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
    authStore: fakeAuthStore(),
    webRoot: join(base, "web"),
  });
  listening = await server.start({ port: 0 });
  return listening.port;
}

const NAVIGATION = "Accept: text/html\r\n";

describe("the web root on the running server", () => {
  it("serves index.html at / and a hashed asset with its policy", async () => {
    const port = await listen();
    const index = await request(port, "/", NAVIGATION);
    expect(index.status).toBe(200);
    expect(index.body).toBe(INDEX);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    const asset = await request(port, "/assets/app-AbCd1234.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await request(port, "/assets/app-AbCd1234.js", "", "HEAD")).body).toBe("");
  });

  it.each([
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/%252e%252e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/up/secret.txt",
    "//secret.txt",
    "/assets//../../secret.txt",
  ])("never answers %s with the file outside the root", async (target) => {
    const port = await listen();
    for (const extra of ["", NAVIGATION]) {
      const answer = await request(port, target, extra);
      expect(answer.body, `${target} ${extra}`).not.toContain(SECRET);
    }
  });

  it("gives an unknown path the app for a navigation and the problem otherwise", async () => {
    const port = await listen();
    expect((await request(port, "/bookmarks/inbox", NAVIGATION)).body).toBe(INDEX);
    const refused = await request(port, "/bookmarks/inbox");
    expect(refused.status).toBe(404);
    expect(refused.headers.get("content-type")).toBe("application/problem+json");
    expect((await request(port, "/api/v1/unknown", NAVIGATION)).status).toBe(404);
    const forwarded = await request(port, "/go/unknown", NAVIGATION);
    expect(forwarded.status).toBe(302);
    expect(forwarded.body).not.toBe(INDEX);
  });
});
