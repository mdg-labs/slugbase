import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composedServer } from "./web-support.ts";

// The real Vite build of the CE web entry, served through the static handler of
// the server (doc 01 section 7.1): what an operator's browser receives.

const APP = resolve(import.meta.dirname, "..");
const NAVIGATION = { accept: "text/html" };

let outDir: string;
let html: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "slugbase-web-build-"));
  await build({ configFile: resolve(APP, "vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
  html = readFileSync(join(outDir, "index.html"), "utf8");
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const assets = () => readdirSync(join(outDir, "assets"));
const get = (path: string, headers: Record<string, string> = {}) =>
  composedServer(outDir).fetch(new Request(`http://localhost${path}`, { headers }));

describe("the built index.html", () => {
  it("has no inline script, inline style or event handler, so a script-src 'self' policy holds", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
    expect(html).not.toMatch(/<script\b[^>]*>\s*[^<\s]/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("links the OpenSearch description, so a browser can offer SlugBase as a search engine", () => {
    expect(html).toMatch(/<link\b[^>]*\brel="search"[^>]*\btype="application\/opensearchdescription\+xml"[^>]*\bhref="\/opensearch\.xml"/);
  });

  it("references the bundle and the stylesheet by content-hashed names", () => {
    expect(html).toMatch(/src="\/assets\/index-[\w-]{8}\.js"/);
    expect(html).toMatch(/href="\/assets\/index-[\w-]{8}\.css"/);
  });
});

describe("the built assets", () => {
  it("are all content-hashed", () => {
    expect(assets().length).toBeGreaterThan(2);
    for (const name of assets()) {
      expect(name, name).toMatch(/-[\w-]{8}\.[a-z0-9]+$/);
    }
  });

  it("carry the bundled IBM Plex fonts as local files, referenced from the stylesheet", () => {
    const fonts = assets().filter((name) => name.endsWith(".woff2"));
    expect(fonts).toHaveLength(12);
    const css = readFileSync(join(outDir, "assets", assets().find((name) => name.endsWith(".css")) ?? ""), "utf8");
    for (const font of fonts) {
      expect(css).toContain(`/assets/${font}`);
    }
    expect(css).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
  });

  it("include the classes that only the web package's own sources use", () => {
    const css = readFileSync(join(outDir, "assets", assets().find((name) => name.endsWith(".css")) ?? ""), "utf8");
    expect(css).toContain(".min-h-svh");
  });
});

describe("served by the server", () => {
  it("answers / and an app path with the built index.html, uncached", async () => {
    for (const path of ["/", "/bookmarks/inbox"]) {
      const response = await get(path, NAVIGATION);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe(html);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("serves the bundle, the stylesheet and a font as immutable files", async () => {
    for (const [extension, type] of [
      [".js", /javascript/],
      [".css", /css/],
      [".woff2", /woff2/],
    ] as const) {
      const name = assets().find((candidate) => candidate.endsWith(extension)) ?? "";
      const response = await get(`/assets/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("content-type")).toMatch(type);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
  });

  it("answers /opensearch.xml with the description the page links, from the configured origin and without a session", async () => {
    const response = await get("/opensearch.xml", { host: "evil.example", "x-forwarded-host": "evil.example" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/opensearchdescription\+xml/);
    const body = await response.text();
    expect(body).toContain('template="https://bookmarks.example.com/go/{searchTerms}"');
    expect(body).not.toContain("evil.example");
  });

  it("answers /api/config next to the app, with the product name the page shows", async () => {
    const response = await get("/api/config");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { product: { name: string } }).product.name).toBe("SlugBase Test Build");
  });
});

// The mock of `pnpm dev:web --mock` (doc 08 section 7) is a development tool: the
// build, in any mode, carries neither its worker script nor its handlers nor its
// fixtures.
const MOCK_MARKERS = [
  "mockServiceWorker",
  "SlugBase Mock",
  "setupWorker",
  "createHandlers",
  "scenarioFromSearch",
  "@mswjs",
  "virtual:slugbase-openapi",
  "/mock/main",
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe.each([["production", undefined], ["mock", "mock"]] as const)("the %s build output", (_name, mode) => {
  let buildDir: string;

  beforeAll(async () => {
    buildDir = mkdtempSync(join(tmpdir(), "slugbase-web-nomock-"));
    await build({
      configFile: resolve(APP, "vite.config.ts"),
      logLevel: "silent",
      ...(mode === undefined ? {} : { mode }),
      build: { outDir: buildDir, emptyOutDir: true },
    });
  }, 120_000);

  afterAll(() => {
    rmSync(buildDir, { recursive: true, force: true });
  });

  it("has no service worker script", () => {
    const files = filesUnder(buildDir);
    expect(files.length).toBeGreaterThan(2);
    expect(files.filter((file) => /mockServiceWorker/i.test(file))).toEqual([]);
  });

  it("holds no text of the mock in any file", () => {
    for (const file of filesUnder(buildDir)) {
      if (/\.(?:js|css|html|map|json|txt)$/.test(file)) {
        const text = readFileSync(file, "utf8");
        for (const marker of MOCK_MARKERS) {
          expect(text.includes(marker), `${marker} in ${file}`).toBe(false);
        }
      }
    }
  });
});
