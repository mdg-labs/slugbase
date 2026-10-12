import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompositionError, createServer } from "../../src/create-server.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";
import { expectSecurityHeaders } from "../http/headers-support.ts";

// The SPA assets of doc 01 section 7.1 and doc 04 section 2.1, through the whole
// chain. The fixture holds a file outside the web root and a symlink to it:
// the tests that follow must never see its content.

const SECRET = "outside-the-web-root-7f3a9c";
const INDEX = "<!doctype html><title>SlugBase</title><div id=root></div>";
const HASHED_JS = "console.log('app')";
const HASHED_CSS = "body{margin:0}";

let base: string;
let webRoot: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "slugbase-static-"));
  webRoot = join(base, "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  mkdirSync(join(webRoot, "empty-dir"));
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside", "secret.txt"), SECRET);
  writeFileSync(join(base, "secret.txt"), SECRET);
  writeFileSync(join(webRoot, "index.html"), INDEX);
  writeFileSync(join(webRoot, "assets", "index-AbCd1234.js"), HASHED_JS);
  writeFileSync(join(webRoot, "assets", "style-Zx98_wVu.css"), HASHED_CSS);
  writeFileSync(join(webRoot, "assets", "logo-Qw12Er34.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(webRoot, "assets", "plain.js"), "unhashed");
  writeFileSync(join(webRoot, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(webRoot, "data.bin"), "x");
  symlinkSync(join(base, "outside"), join(webRoot, "link-out"));
  symlinkSync(join(base, "secret.txt"), join(webRoot, "secret-link.txt"));
  symlinkSync(join(webRoot, "favicon.svg"), join(webRoot, "alias.svg"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function start(options: { webRoot?: string; env?: Record<string, string | undefined> } = {}) {
  return createServer({
    config: serverConfig(options.env),
    adapters: adapters(),
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  });
}

type Started = ReturnType<typeof start>;

const HTML = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

const get = (server: Started, path: string, headers: Record<string, string> = {}, method = "GET") =>
  server.fetch(new Request(`http://localhost${path}`, { method, headers }));

async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(((await response.json()) as { code: string }).code).toBe("not_found");
}

async function expectNoSecret(response: Response): Promise<void> {
  expect(await response.text()).not.toContain(SECRET);
}

describe("path traversal and files outside the web root", () => {
  const server = () => start({ webRoot });

  // The URL parser removes literal and %2e-encoded dot segments before the handler sees the path,
  // so these reach the lookup as a path inside the root that does not exist.
  it.each([
    "/../secret.txt",
    "/../outside/secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2E%2E/outside/secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/.%2e/secret.txt",
  ])("never serves a file outside the root for %s", async (path) => {
    for (const headers of [{}, HTML] as Record<string, string>[]) {
      const response = await get(server(), path, headers);
      await expectNoSecret(response);
    }
  });

  // These keep a dot segment in the path the handler sees once it is decoded.
  it.each([
    "/..%2fsecret.txt",
    "/..%2Foutside%2Fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "/%2e%2e%2foutside%2fsecret.txt",
    "/assets%2f..%2f..%2fsecret.txt",
    "/..%5csecret.txt",
    "/%2e%2e%5coutside%5csecret.txt",
    "/assets/..%2f..%2fsecret.txt",
  ])("refuses %s with 404 not_found, even for a browser navigation", async (path) => {
    const response = await get(server(), path, HTML);
    await expectNotFound(response);
  });

  it.each([
    "/%252e%252e/secret.txt",
    "/%252e%252e%252fsecret.txt",
    "/%252e%252e/%252e%252e/outside/secret.txt",
    "/..%252fsecret.txt",
    "/%252e%252e%255csecret.txt",
    "/assets/%252e%252e/%252e%252e/secret.txt",
  ])("refuses the double-encoded %s with 404 not_found, even for a browser navigation", async (path) => {
    const response = await get(server(), path, HTML);
    await expectNotFound(response);
  });

  it.each(["/%00", "/index.html%00.png", "/assets/%00/x", "/%", "/%zz", "/%c0%ae%c0%ae/secret.txt", "/\\..\\secret.txt"])(
    "refuses %s",
    async (path) => {
      const response = await get(server(), path, HTML);
      await expectNoSecret(response.clone());
      expect(response.status === 404 || (await response.text()) === INDEX).toBe(true);
    },
  );

  it("does not follow a symlink out of the web root, to a directory or to a file", async () => {
    for (const path of ["/link-out/secret.txt", "/secret-link.txt", "/link-out", "/link-out/"]) {
      for (const headers of [{}, HTML] as Record<string, string>[]) {
        const response = await get(server(), path, headers);
        await expectNoSecret(response.clone());
        if (headers === HTML) {
          // Not found, so a navigation gets the app, never the target of the link.
          expect(await response.text()).toBe(INDEX);
        } else {
          await expectNotFound(response);
        }
      }
    }
  });

  it("follows a symlink that stays inside the web root", async () => {
    const response = await get(server(), "/alias.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("lists no directory", async () => {
    for (const path of ["/assets", "/assets/", "/empty-dir", "/empty-dir/"]) {
      const withoutHtml = await get(server(), path);
      await expectNotFound(withoutHtml);
      const navigation = await get(server(), path, HTML);
      expect(await navigation.text()).toBe(INDEX);
    }
  });
});

describe("serving the web root", () => {
  it("serves a hashed asset with the immutable cache policy and its media type", async () => {
    const server = start({ webRoot });
    const script = await get(server, "/assets/index-AbCd1234.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe(HASHED_JS);
    const style = await get(server, "/assets/style-Zx98_wVu.css");
    expect(style.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await get(server, "/assets/logo-Qw12Er34.svg")).headers.get("content-type")).toBe("image/svg+xml");
  });

  it("serves index.html with no-cache, at / and at its own path", async () => {
    const server = start({ webRoot });
    for (const path of ["/", "/index.html"]) {
      const response = await get(server, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toBe(INDEX);
    }
  });

  it("revalidates every file that is not a hashed asset", async () => {
    const server = start({ webRoot });
    for (const path of ["/favicon.svg", "/assets/plain.js", "/data.bin"]) {
      expect((await get(server, path)).headers.get("cache-control"), path).toBe("no-cache");
    }
    expect((await get(server, "/data.bin")).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("carries the security headers of every response, nosniff included", async () => {
    const server = start({ webRoot });
    for (const path of ["/", "/assets/index-AbCd1234.js", "/some/spa/route"]) {
      const response = await get(server, path, HTML);
      expect(response.status).toBe(200);
      expectSecurityHeaders(response.headers, { https: true });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const missing = await get(server, "/assets/missing-AbCd1234.js");
    expectSecurityHeaders(missing.headers, { https: true });
  });

  it("answers HEAD with the headers of the GET and no body", async () => {
    const server = start({ webRoot });
    const head = await get(server, "/assets/index-AbCd1234.js", {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await head.text()).toBe("");
    const index = await get(server, "/some/route", HTML, "HEAD");
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("");
  });

  it("serves no method but GET and HEAD", async () => {
    const server = start({ webRoot });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of ["/", "/assets/index-AbCd1234.js", "/some/route"]) {
        const response = await get(server, path, { ...HTML, origin: "https://bookmarks.example.com" }, method);
        expect(response.status, `${method} ${path}`).not.toBe(200);
        expect(await response.text()).not.toContain(INDEX);
      }
    }
  });
});

describe("history fallback", () => {
  it("answers an unknown GET that accepts HTML with index.html", async () => {
    const server = start({ webRoot });
    for (const path of ["/bookmarks", "/settings/profile", "/a/b/c/d", "/missing.js", "/bookmarks/"]) {
      const response = await get(server, path, HTML);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe(INDEX);
    }
    expect((await get(server, "/x", { accept: "text/html" })).status).toBe(200);
    expect((await get(server, "/x", { accept: "application/json, text/html;q=0.5" })).status).toBe(200);
  });

  it("answers an unknown path without an HTML Accept with the 404 problem", async () => {
    const server = start({ webRoot });
    const unaccepted: Record<string, string>[] = [{}, { accept: "*/*" }, { accept: "application/json" }, { accept: "text/html;q=0" }, { accept: "image/png" }];
    for (const headers of unaccepted) {
      await expectNotFound(await get(server, "/bookmarks", headers));
    }
    await expectNotFound(await get(server, "/assets/missing-AbCd1234.js", { accept: "*/*" }));
  });

  it("never answers a path under /api/ or /go/ with the app", async () => {
    const server = start({ webRoot });
    for (const path of ["/api", "/api/", "/api/v1/nothing", "/api/anything/else", "/go", "/go/", "/go/some-slug", "/%61pi/v1/x", "/%67o/slug", "/api%2fv1"]) {
      await expectNotFound(await get(server, path, HTML));
    }
  });

  it("does not shadow a route, a probe or the reference", async () => {
    const server = start({ webRoot });
    expect(await (await get(server, "/health", HTML)).json()).toEqual({ status: "ok" });
    expect((await get(server, "/api/docs", HTML)).headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await get(server, "/api/config", HTML)).headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("leaves /api/docs a 404 when the reference is disabled, never the app", async () => {
    await expectNotFound(await get(start({ webRoot, env: { API_DOCS_ENABLED: "false" } }), "/api/docs", HTML));
  });
});

describe("a server without a web root", () => {
  it("serves no app: every unknown path is the 404 problem", async () => {
    const server = start();
    await expectNotFound(await get(server, "/", HTML));
    await expectNotFound(await get(server, "/bookmarks", HTML));
  });
});

describe("the web root option", () => {
  it("refuses a directory that does not exist, is a file, or has no index.html", () => {
    const refused = (path: string) => {
      try {
        start({ webRoot: path });
      } catch (error) {
        return error instanceof CompositionError ? error.code : "other";
      }
      return "accepted";
    };
    expect(refused(join(base, "no-such-directory"))).toBe("invalid_web_root");
    expect(refused(join(base, "secret.txt"))).toBe("invalid_web_root");
    expect(refused(join(base, "outside"))).toBe("invalid_web_root");
  });

  it("closes the pool it opened when the web root is refused", () => {
    const database = fakeDatabase();
    expect(() =>
      createServer({
        config: serverConfig(),
        adapters: adapters(),
        modules: [],
        migrations: [],
        logger: recordingLogger(),
        database,
        webRoot: join(base, "no-such-directory"),
      }),
    ).toThrow(CompositionError);
    expect(database.closed.count).toBe(1);
  });
});
