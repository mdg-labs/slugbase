import { readFileSync } from "node:fs";
import { getApiConfig, getOpenApiDocument } from "@slugbase/contracts";
import { unconfigured, type Adapters } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import type { BuildInfo } from "../../src/build-info.ts";
import { createServer } from "../../src/create-server.ts";
import { adapters, documentFor, fakeDatabase, operation, recordingLogger, serverConfig } from "../support.ts";
import { directivesOf, expectSecurityHeaders } from "../http/headers-support.ts";

// /api/config, the OpenAPI document and the reference UI through the whole chain.

const BUILD: BuildInfo = { name: "SlugBase", version: "1.4.2", commit: "0123abc", builtAt: "2026-10-12T08:00:00Z" };
const COMMITTED = new URL("../../../contracts/generated/openapi.json", import.meta.url);

function start(env: Record<string, string | undefined> = {}, overrides: { adapters?: Adapters; openApiDocument?: ReturnType<typeof documentFor> } = {}) {
  return createServer({
    config: serverConfig(env),
    adapters: overrides.adapters ?? adapters(),
    modules: [],
    ...(overrides.openApiDocument === undefined ? {} : { openApiDocument: overrides.openApiDocument }),
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
    buildInfo: BUILD,
  });
}

type Started = ReturnType<typeof start>;

const get = (server: Started, path: string, init: RequestInit = {}) => server.fetch(new Request(`http://localhost${path}`, init));

describe("GET /api/config", () => {
  it("answers from the configuration, the build info and the ports", async () => {
    const server = start({ APP_ORIGIN: "https://links.example.org", DOCS_BASE_URL: "https://docs.example.org/help" });
    const response = await get(server, "/api/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apiVersion: "v1",
      origin: "https://links.example.org",
      product: { name: "SlugBase", version: "1.4.2" },
      locales: ["en", "de"],
      defaultLocale: "en",
      docsBaseUrl: "https://docs.example.org/help",
      features: { mail: false, ai: false },
    });
  });

  it("reports whether a port is configured, per port", async () => {
    const ports = unconfigured();
    const mail = { ...ports, mail: { ...ports.mail, available: true } };
    const ai = { ...ports, ai: { ...ports.ai, available: true } };
    const features = async (given: Adapters) =>
      ((await (await get(start({}, { adapters: given }), "/api/config")).json()) as { features: object }).features;
    expect(await features(mail)).toEqual({ mail: true, ai: false });
    expect(await features(ai)).toEqual({ mail: false, ai: true });
  });

  it("is cacheable for 60 seconds, while the rest of the API is not", async () => {
    const server = start();
    const config = await get(server, "/api/config");
    expect(config.headers.get("cache-control")).toBe("public, max-age=60");
    expectSecurityHeaders(config.headers, { https: true });
    expect(getApiConfig.auth).toBe("anonymous");
    const other = await get(server, "/api/v1/nothing");
    expect(other.headers.get("cache-control")).toBe("no-store");
  });

  it("is unaffected by API_DOCS_ENABLED=false", async () => {
    const response = await get(start({ API_DOCS_ENABLED: "false" }), "/api/config");
    expect(response.status).toBe(200);
  });
});

describe("GET /api/v1/openapi.json", () => {
  it.each(["production", "test"])("is the committed document byte for byte with NODE_ENV=%s", async (NODE_ENV) => {
    const server = start({ NODE_ENV });
    const response = await get(server, "/api/v1/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(COMMITTED))).toBe(true);
  });

  it("is the document of the composition when it passes its own", async () => {
    const own = documentFor([operation("get", "/api/v1/ping", "ping")]);
    const response = await get(start({}, { openApiDocument: own }), "/api/v1/openapi.json");
    expect(await response.json()).toEqual(own);
  });

  it("answers 404 not_found when API_DOCS_ENABLED=false", async () => {
    const response = await get(start({ API_DOCS_ENABLED: "false" }), "/api/v1/openapi.json");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
    expect(getOpenApiDocument.responses[404]).toBeDefined();
  });
});

describe("GET /api/docs", () => {
  const SCRIPT = readFileSync(new URL("./browser/standalone.js", import.meta.resolve("@scalar/api-reference")), "utf8");
  const STYLE = readFileSync(new URL("./style.css", import.meta.resolve("@scalar/api-reference")), "utf8");

  it("serves the reference page under the standard headers and no weaker script policy", async () => {
    const response = await get(start(), "/api/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(response.headers, { https: true });
    expect(directivesOf(response.headers.get("content-security-policy") ?? "").get("script-src")).toEqual(["'self'"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("holds no inline script or style and names no other origin", async () => {
    const html = await (await get(start(), "/api/docs")).text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([^<]*)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes = "", body = ""] of scripts) {
      // A script is a file of this origin, or a data block the browser never runs.
      const isFile = /\ssrc="\/api\/docs\/[^"]+"/.test(attributes) && body === "";
      const isData = /\stype="application\/json"/.test(attributes);
      expect(isFile || isData, attributes).toBe(true);
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(html).toContain('href="/api/docs/scalar.css"');
  });

  it("serves the bundled script and stylesheet of the installed package, and nothing fetched at run time", async () => {
    const server = start();
    const script = await get(server, "/api/docs/scalar.js");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe(SCRIPT);
    const style = await get(server, "/api/docs/scalar.css");
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await style.text()).toBe(STYLE);
    expectSecurityHeaders(script.headers, { https: true });
  });

  it("answers HEAD without a body, and no other method", async () => {
    const server = start();
    const head = await get(server, "/api/docs", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const refused = await get(server, "/api/docs", {
        method,
        headers: { "content-type": "application/json", origin: "https://bookmarks.example.com" },
        body: "{}",
      });
      expect(refused.status).toBe(404);
    }
  });

  it("refuses paths below it that are not its files", async () => {
    const server = start();
    for (const path of ["/api/docs/other", "/api/docs/scalar.js.map", "/api/docs/..%2fconfig", "/api/docsx"]) {
      const response = await get(server, path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
    }
  });

  it("answers 404 not_found for the page and its files when API_DOCS_ENABLED=false", async () => {
    const server = start({ API_DOCS_ENABLED: "false" });
    for (const path of ["/api/docs", "/api/docs/", "/api/docs/scalar.js", "/api/docs/scalar.css"]) {
      const response = await get(server, path);
      expect(response.status, path).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("not_found");
    }
  });
});
