import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { viteArguments } from "../scripts/dev-web-arguments.ts";
import { afterAll, describe, expect, it } from "vitest";

// `pnpm dev:web --mock` (doc 08 section 7): the Vite dev server in mode "mock"
// loads the mock entry, hands the browser the OpenAPI document the handlers are
// generated from and serves the service worker script. Any other mode does none of it.

const APP = resolve(import.meta.dirname, "..");
const INDEX = readFileSync(resolve(APP, "index.html"), "utf8");
const servers: ViteDevServer[] = [];

async function devServer(mode: string): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: resolve(APP, "vite.config.ts"),
    mode,
    logLevel: "silent",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body?: Buffer;
  passedOn: boolean;
}

type Middleware = (request: object, response: object, next: () => void) => void;

// The middleware the plugin registers, called on its own: the connect stack of a
// server in middleware mode needs a socket that a test has no use for.
async function workerMiddleware(server: ViteDevServer): Promise<Middleware | undefined> {
  const plugin = server.config.plugins.find((candidate) => candidate.name === "slugbase-mock");
  const hook = plugin?.configureServer;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  let registered: Middleware | undefined;
  await handler?.call({} as never, { middlewares: { use: (middleware: Middleware) => (registered = middleware) } } as never);
  return registered;
}

async function request(server: ViteDevServer, url: string): Promise<Captured> {
  const middleware = await workerMiddleware(server);
  return new Promise((done) => {
    const captured: Captured = { headers: {}, passedOn: false };
    const response = {
      setHeader: (name: string, value: string) => (captured.headers[name.toLowerCase()] = value),
      end: (body: Buffer) => {
        captured.body = body;
        done(captured);
      },
    };
    const next = () => {
      captured.passedOn = true;
      done(captured);
    };
    if (middleware === undefined) {
      next();
      return;
    }
    middleware({ url, method: "GET" }, response, next);
  });
}

describe("the dev server in mock mode", () => {
  it("loads the mock entry in place of the app entry", async () => {
    const server = await devServer("mock");
    const html = await server.transformIndexHtml("/", INDEX);
    expect(html).toContain('src="/mock/main.ts"');
    expect(html).not.toContain("/src/web.tsx");
  });

  it("compiles the mock entry, which reaches the handlers, the worker and the document", async () => {
    const server = await devServer("mock");
    const entry = await server.transformRequest("/mock/main.ts");
    expect(entry?.code).toContain("createHandlers");
    expect(entry?.code).toContain("packages/testing/src/msw.ts");
    expect(entry?.code).toContain("setupWorker");
    const document = await server.transformRequest("virtual:slugbase-openapi");
    expect(document?.code).toContain("getApiConfig");
    expect(document?.code).toContain("/api/config");
  });

  it("serves the service worker script from the msw package", async () => {
    const server = await devServer("mock");
    const answer = await request(server, "/mockServiceWorker.js?v=1");
    expect(answer.passedOn).toBe(false);
    expect(answer.headers["content-type"]).toBe("text/javascript");
    expect(answer.body?.toString()).toBe(readFileSync(createRequire(import.meta.url).resolve("msw/mockServiceWorker.js"), "utf8"));
  });

  it("proxies nothing to a server", async () => {
    const server = await devServer("mock");
    expect(server.config.server.proxy).toEqual({});
  });
});

describe("the dev server in any other mode", () => {
  it("keeps the app entry and has neither the document module nor the service worker", async () => {
    const server = await devServer("development");
    const html = await server.transformIndexHtml("/", INDEX);
    expect(html).toContain('src="/src/web.tsx"');
    expect(html).not.toContain("/mock/main.ts");
    await expect(server.transformRequest("virtual:slugbase-openapi")).rejects.toThrow();
    expect((await request(server, "/mockServiceWorker.js")).passedOn).toBe(true);
    expect(Object.keys(server.config.server.proxy ?? {})).toEqual(["/api", "/go", "/health"]);
  });
});

describe("the dev:web script", () => {
  it("turns --mock into the mock mode and leaves other arguments alone", () => {
    expect(viteArguments(["--mock", "--port", "5200"])).toEqual(["--port", "5200", "--mode", "mock"]);
    expect(viteArguments(["--port", "5200"])).toEqual(["--port", "5200"]);
    expect(viteArguments([])).toEqual([]);
  });

  it("starts Vite with the arguments it builds", () => {
    const output = execFileSync(process.execPath, [resolve(APP, "scripts/dev-web.ts"), "--mock", "--version"], {
      encoding: "utf8",
    });
    expect(output).toMatch(/^vite\//);
  });
});
