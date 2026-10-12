import { createServer as createNetServer, connect, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ModuleContext, type RunningServer, type ServerModule } from "../../src/create-server.ts";
import { adapters, fakeDatabase, operation, recordingLogger, serverConfig, documentOf } from "../support.ts";
import { get, sample } from "./support.ts";

// Metrics over real sockets (doc 01 section 12, doc 04 section 2.1): the
// internal listener serves `/metrics`, the public one answers 404, and no
// label carries anything but a route template.

const SECRET_SLUG = "private-slug-7f3a";
const EMAIL = "alice.example@mail.test";
const ACCOUNT = "018f3c1e-0000-7000-8000-000000000001";

interface Gate {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly wait: () => Promise<void>;
}

function gate(): Gate {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: () => {
      enter();
      return released;
    },
  };
}

function appModule(held: Gate): ServerModule {
  let context: ModuleContext | undefined;
  return {
    name: "app",
    register: (moduleContext) => {
      context = moduleContext;
      return {
        routes: [
          { operation: operation("get", "/api/v1/items/{id}", "getItem"), handler: () => Response.json({ ok: true }) },
          { operation: operation("get", "/api/v1/boom", "boom"), handler: () => Promise.reject(new Error("boom")) },
          {
            operation: operation("get", "/api/v1/held", "held"),
            handler: async () => {
              const tenant = { accountId: ACCOUNT, requestId: "req-held-0001" };
              await context?.withTenant(tenant, () => context?.withTenant(tenant, () => held.wait()) ?? Promise.resolve());
              return Response.json({ ok: true });
            },
          },
        ],
      };
    },
  };
}

const running: RunningServer[] = [];
const blockers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
  await Promise.all(
    blockers.splice(0).map(
      (blocker) =>
        new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function start(env: Record<string, string | undefined> = {}, ports: { port?: number; metricsPort?: number } = { port: 0, metricsPort: 0 }) {
  const database = fakeDatabase();
  const logger = recordingLogger();
  const held = gate();
  const server = createServer({
    config: serverConfig(env),
    adapters: adapters(),
    modules: [appModule(held)],
    openApiDocument: documentOf([appModule(held)]),
    migrations: [],
    logger,
    database,
  });
  const listening = await server.start(ports);
  running.push(listening);
  return { listening, database, logger, held };
}

async function scrape(port: number): Promise<string> {
  const response = await get(port, "/metrics");
  expect(response.status).toBe(200);
  return response.body;
}

function refused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? "error");
    });
  });
}

describe("the internal metrics listener", () => {
  it("serves the Prometheus text format on its own port", async () => {
    const { listening } = await start();
    expect(listening.metricsPort).toBeDefined();
    expect(listening.metricsPort).not.toBe(listening.port);

    const response = await get(listening.metricsPort ?? 0, "/metrics");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("# TYPE slugbase_http_requests_total counter");
    expect(response.body).toContain("# TYPE slugbase_http_request_duration_seconds histogram");
    expect(response.body).toContain("# TYPE slugbase_db_tenant_transactions_in_flight gauge");
    expect(response.body).toContain("# TYPE slugbase_rate_limit_rejections_total counter");
  });

  it("answers 404 for anything but /metrics and 405 for another method", async () => {
    const { listening } = await start();
    const port = listening.metricsPort ?? 0;
    expect((await get(port, "/")).status).toBe(404);
    expect((await get(port, "/api/v1/items/x")).status).toBe(404);
    const post = await get(port, "/metrics", "POST");
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET, HEAD");
    const head = await get(port, "/metrics", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("is not started while METRICS_PORT is unset", async () => {
    const { listening } = await start({}, { port: 0 });
    expect(listening.metricsPort).toBeUndefined();
  });

  it("is never served on the public listener, which answers 404 not_found", async () => {
    const { listening } = await start();
    for (const path of ["/metrics", "/metrics/", "/api/v1/metrics"]) {
      const response = await get(listening.port, path);
      expect(response.status, path).toBe(404);
      expect(response.body, path).toContain('"code":"not_found"');
      expect(response.body, path).not.toContain("slugbase_http_requests_total");
    }
  });

  it("counts requests and latency per route template", async () => {
    const { listening } = await start();
    await get(listening.port, "/api/v1/items/one");
    await get(listening.port, "/api/v1/items/two");
    await get(listening.port, "/api/v1/boom");
    await get(listening.port, "/nowhere");

    const text = await scrape(listening.metricsPort ?? 0);
    expect(sample(text, "slugbase_http_requests_total", { method: "GET", route: "/api/v1/items/{id}", status: "200" })).toBe(2);
    expect(sample(text, "slugbase_http_requests_total", { method: "GET", route: "/api/v1/boom", status: "500" })).toBe(1);
    expect(sample(text, "slugbase_http_requests_total", { method: "GET", route: "unmatched", status: "404" })).toBe(1);
    expect(sample(text, "slugbase_http_request_duration_seconds_count", { route: "/api/v1/items/{id}" })).toBe(2);
    expect(sample(text, "slugbase_http_request_duration_seconds_bucket", { route: "/api/v1/items/{id}", le: "+Inf" })).toBe(2);
  });

  it("puts no raw path, slug, identifier, email or other request value in a label", async () => {
    const { listening } = await start();
    await get(listening.port, `/api/v1/items/${SECRET_SLUG}?email=${EMAIL}&token=${SECRET_SLUG}`);
    await get(listening.port, `/go/${SECRET_SLUG}`);
    await get(listening.port, `/api/v1/items/${ACCOUNT}`);
    await get(listening.port, `/users/${EMAIL}/profile`);
    await get(listening.port, "/api/v1/items/x", "PURGE");

    const text = await scrape(listening.metricsPort ?? 0);
    for (const value of [SECRET_SLUG, EMAIL, ACCOUNT, "profile", "/go/", "PURGE", "token"]) {
      expect(text, value).not.toContain(value);
    }
    const routes = new Set([...text.matchAll(/route="([^"]*)"/g)].map((match) => match[1]));
    expect([...routes].sort()).toEqual(["/api/v1/items/{id}", "unmatched"]);
    const methods = new Set([...text.matchAll(/method="([^"]*)"/g)].map((match) => match[1]));
    expect([...methods].sort()).toEqual(["GET", "_OTHER"]);
  });

  it("counts tenant transactions in flight once, however deeply they nest", async () => {
    const { listening, held } = await start();
    const port = listening.metricsPort ?? 0;
    expect(sample(await scrape(port), "slugbase_db_tenant_transactions_in_flight")).toBe(0);

    const pending = get(listening.port, "/api/v1/held");
    await held.entered;
    expect(sample(await scrape(port), "slugbase_db_tenant_transactions_in_flight")).toBe(1);

    held.release();
    expect((await pending).status).toBe(200);
    expect(sample(await scrape(port), "slugbase_db_tenant_transactions_in_flight")).toBe(0);
  });

  it("reports no pool size for a database it did not open", async () => {
    const { listening } = await start();
    expect(sample(await scrape(listening.metricsPort ?? 0), "slugbase_db_pool_size")).toBeUndefined();
  });

  it("stops listening on shutdown", async () => {
    const { listening } = await start();
    const metricsPort = listening.metricsPort ?? 0;
    expect(await refused(metricsPort)).toBe("connected");
    await listening.shutdown();
    expect(await refused(metricsPort)).toBe("ECONNREFUSED");
    expect(await refused(listening.port)).toBe("ECONNREFUSED");
  });

  it("refuses to start with the metrics port equal to the public one", async () => {
    const database = fakeDatabase();
    const server = createServer({
      config: serverConfig({ PORT: "45871", METRICS_PORT: "45871" }),
      adapters: adapters(),
      modules: [],
      openApiDocument: documentOf([]),
      migrations: [],
      logger: recordingLogger(),
      database,
    });
    await expect(server.start()).rejects.toThrow("METRICS_PORT must differ from PORT");
    expect(await refused(45871)).toBe("ECONNREFUSED");
  });

  it("stops the public listener and closes the pool when the metrics port is taken", async () => {
    const blocker = createNetServer();
    blockers.push(blocker);
    const taken = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    const database = fakeDatabase();
    const server = createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [],
      openApiDocument: documentOf([]),
      migrations: [],
      logger: recordingLogger(),
      database,
    });
    await expect(server.start({ port: 0, metricsPort: taken })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(database.closed.count).toBe(1);
  });
});
