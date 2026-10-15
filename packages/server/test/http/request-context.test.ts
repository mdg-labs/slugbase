import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { unconfigured } from "@slugbase/core";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Logger, type ServerModule } from "../../src/create-server.ts";
import {
  RouteTable,
  installChain,
  type ChainEnv,
  type RouteBinding,
  type StageImplementations,
} from "../../src/http/chain.ts";
import { createLogger } from "../../src/http/logger.ts";
import { requestIdFrom } from "../../src/http/request-context.ts";
import { acceptAnyBearer, adapters, fakeDatabase, hookDispatcher, operation, serverConfig, documentOf, tenantDependencies, rateLimitDependencies } from "../support.ts";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});

afterAll(() => {
  trace.disable();
});

beforeEach(() => {
  exporter.reset();
});

function sink() {
  const lines: string[] = [];
  return {
    lines,
    write: (chunk: string): void => {
      lines.push(chunk);
    },
    entries: (): Record<string, unknown>[] =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    requests: (): Record<string, unknown>[] =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry["msg"] === "Request completed"),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const whoami: ServerModule = {
  name: "whoami",
  register: () => ({
    routes: [
      {
        operation: operation("get", "/api/v1/whoami", "whoami"),
        handler: (context) => Response.json({ ip: context.get("clientIp") ?? null }),
      },
      {
        operation: operation("get", "/api/v1/things/{id}", "thing"),
        handler: () => Response.json({}),
      },
      {
        operation: operation("get", "/api/v1/boom", "boom"),
        handler: () => {
          throw new Error("database password hunter2-qx90 rejected");
        },
      },
      {
        operation: operation("post", "/api/v1/login", "signIn"),
        handler: async (context) => {
          context.get("logger")?.info("Handler ran", {
            headers: {
              authorization: "Bearer handler-token-qx91",
              cookie: "session=handler-cookie-qx92",
              "set-cookie": "session=handler-set-cookie-qx93",
            },
            body: { password: "handler-password-qx94", mfaCode: "424242" },
            token: "handler-token-qx95",
          });
          await context.req.text();
          return Response.json({});
        },
      },
    ],
  }),
};

function compose(overrides: { hops?: number; logger?: Logger; modules?: readonly ServerModule[] } = {}) {
  const output = sink();
  // The authentication stage is not under test: it accepts every Authorization header, so what is logged and traced is.
  const bearer = acceptAnyBearer();
  const server = createServer({
    config: serverConfig({ TRUSTED_PROXY_HOPS: String(overrides.hops ?? 0) }),
    adapters: { ...adapters(), tenantResolver: bearer.tenantResolver },
    modules: [...(overrides.modules ?? [whoami]), bearer.module],
    openApiDocument: documentOf(overrides.modules ?? [whoami]),
    migrations: [],
    logger: overrides.logger ?? createLogger({ level: "info", destination: output }),
    database: fakeDatabase(),
  });
  return { server, output };
}

describe("the request ID", () => {
  it("accepts a safe X-Request-Id and returns it", async () => {
    const { server } = compose();
    const response = await server.fetch(new Request("http://localhost/api/v1/whoami", { headers: { "x-request-id": "edge-7f3a9c1e.01" } }));
    expect(response.headers.get("x-request-id")).toBe("edge-7f3a9c1e.01");
  });

  it("returns the header on every answer, a problem document included", async () => {
    const { server } = compose();
    const missing = await server.fetch(new Request("http://localhost/api/v1/nothing", { headers: { "x-request-id": "edge-7f3a9c1e.02" } }));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-request-id")).toBe("edge-7f3a9c1e.02");
    expect(((await missing.json()) as { requestId: string }).requestId).toBe("edge-7f3a9c1e.02");
    const failed = await server.fetch(new Request("http://localhost/api/v1/boom"));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { requestId: string }).requestId).toBe(failed.headers.get("x-request-id"));
  });

  it("generates one when the request has none", async () => {
    const { server } = compose();
    const response = await server.fetch(new Request("http://localhost/api/v1/whoami"));
    expect(response.headers.get("x-request-id")).toMatch(UUID_PATTERN);
  });

  it.each([
    ["too short", "abc123"],
    ["too long", "a".repeat(65)],
    ["with a space", "request id 12345"],
    ["with markup", "<script>alert(1)</script>"],
    ["with a separator", "abcdefgh,ijklmnop"],
    ["with a path character", "../../etc/passwd"],
    ["with non-ASCII", "requête-1234567"],
  ])("replaces a request ID %s", async (_name, value) => {
    const { server, output } = compose();
    const response = await server.fetch(new Request("http://localhost/api/v1/whoami", { headers: { "x-request-id": value } }));
    const sent = response.headers.get("x-request-id");
    expect(sent).toMatch(UUID_PATTERN);
    expect(output.lines.join("")).not.toContain(value);
  });

  it("accepts the bounds of the safe pattern", () => {
    expect(requestIdFrom("a".repeat(8))).toBe("a".repeat(8));
    expect(requestIdFrom("A_b-c.9".padEnd(64, "x"))).toHaveLength(64);
    expect(requestIdFrom("a".repeat(7))).not.toBe("a".repeat(7));
    expect(requestIdFrom(undefined)).toMatch(UUID_PATTERN);
  });
});

describe("the client IP across the trusted hops", () => {
  const withSocket = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

  function app(hops: number) {
    const hono = new Hono<ChainEnv>();
    const binding: RouteBinding = {
      operation: operation("get", "/api/v1/whoami", "whoami"),
      handler: (context) => Response.json({ ip: context.get("clientIp") ?? null }),
    };
    installChain(hono, {
      logger: createLogger({ level: "silent", destination: sink() }),
      routes: new RouteTable([binding]),
      trustedProxyHops: hops,
      appOrigin: "https://bookmarks.example.com",
      challenge: unconfigured().challenge,
      errors: unconfigured().errors,
      ...tenantDependencies(), ...rateLimitDependencies(),
      hooks: hookDispatcher(),
      responseValidation: "throw",
    });
    return hono;
  }

  async function ipOf(hops: number, headers: Record<string, string>, socket = "10.0.0.1"): Promise<unknown> {
    const response = await app(hops).request("/api/v1/whoami", { headers }, withSocket(socket));
    return ((await response.json()) as { ip: unknown }).ip;
  }

  // doc 10 T9: an X-Forwarded-For beyond the trusted hops does not change the derived IP.
  it.each([
    [0, { "x-forwarded-for": "6.6.6.6" }, "10.0.0.1"],
    [1, { "x-forwarded-for": "198.51.100.7" }, "198.51.100.7"],
    [1, { "x-forwarded-for": "6.6.6.6, 198.51.100.7" }, "198.51.100.7"],
    [1, { "x-forwarded-for": "9.9.9.9, 6.6.6.6, 198.51.100.7" }, "198.51.100.7"],
    [2, { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 192.0.2.1" }, "198.51.100.7"],
    [3, { "x-forwarded-for": "198.51.100.7, 192.0.2.1" }, "10.0.0.1"],
    [1, { "x-forwarded-for": "garbage" }, "10.0.0.1"],
    [1, { "x-real-ip": "6.6.6.6" }, "10.0.0.1"],
    [1, { "x-real-ip": "6.6.6.6", "x-forwarded-for": "198.51.100.7" }, "198.51.100.7"],
    [1, { forwarded: "for=6.6.6.6" }, "10.0.0.1"],
    [0, { forwarded: "for=6.6.6.6", "x-real-ip": "7.7.7.7" }, "10.0.0.1"],
  ] as const)("with %i hop(s) and %j the IP is %s", async (hops, headers, expected) => {
    expect(await ipOf(hops, headers)).toBe(expected);
  });

  it("is undefined without a socket and without a trusted entry", async () => {
    const response = await app(0).request("/api/v1/whoami", { headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(((await response.json()) as { ip: unknown }).ip).toBeNull();
  });
});

describe("the request log line", () => {
  it("is one JSON line per request with the route template, status, latency and principal", async () => {
    const { server, output } = compose();
    const response = await server.fetch(new Request("http://localhost/api/v1/things/secret-slug-qx80?token=query-secret-qx81&email=a@example.com"));
    expect(output.lines).toHaveLength(1);
    const [entry] = output.requests();
    expect(entry).toMatchObject({
      level: "info",
      msg: "Request completed",
      requestId: response.headers.get("x-request-id"),
      method: "GET",
      route: "/api/v1/things/{id}",
      status: 200,
      principalType: "anonymous",
    });
    expect(entry?.["latencyMs"]).toEqual(expect.any(Number));
    expect(entry).not.toHaveProperty("workspaceId");
    const line = output.lines.join("");
    for (const leaked of ["secret-slug-qx80", "query-secret-qx81", "a@example.com", "/api/v1/things/"]) {
      expect(line.replace("/api/v1/things/{id}", "")).not.toContain(leaked);
    }
  });

  it("names an unmatched request by a constant, never by its path", async () => {
    const { server, output } = compose();
    await server.fetch(new Request("http://localhost/api/v1/private-name-qx82"));
    expect(output.requests()[0]).toMatchObject({ route: "unmatched", status: 404 });
    expect(output.lines.join("")).not.toContain("private-name-qx82");
  });

  it("carries the final status when a handler fails, and nothing of the error", async () => {
    const { server, output } = compose();
    const response = await server.fetch(new Request("http://localhost/api/v1/boom"));
    expect(response.status).toBe(500);
    expect(output.requests()).toHaveLength(1);
    expect(output.requests()[0]).toMatchObject({ route: "/api/v1/boom", status: 500 });
    expect(output.lines.join("")).not.toContain("hunter2-qx90");
  });

  // doc 10 T7
  it("holds none of the credentials, cookies or body of the request", async () => {
    const { server, output } = compose();
    const response = await server.fetch(
      new Request("http://localhost/api/v1/login", {
        method: "POST",
        headers: {
          authorization: "Bearer slb_request-token-qx83",
          cookie: "slugbase_session=request-cookie-qx84",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "person@example.com", password: "request-password-qx85", code: "135790" }),
      }),
    );
    expect(response.status).toBe(200);
    const line = output.lines.join("");
    for (const secret of [
      "request-token-qx83",
      "request-cookie-qx84",
      "request-password-qx85",
      "135790",
      "person@example.com",
      "Bearer",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(output.requests()).toHaveLength(1);
  });

  it("is written by the request logger, and a handler's own line is redacted by field name", async () => {
    const { server, output } = compose();
    const response = await server.fetch(
      new Request("http://localhost/api/v1/login", { method: "POST", body: "{}", headers: { "x-request-id": "edge-7f3a9c1e.03", origin: "https://bookmarks.example.com", "content-type": "application/json" } }),
    );
    expect(response.status).toBe(200);
    const handlerLine = output.entries().find((entry) => entry["msg"] === "Handler ran");
    expect(handlerLine?.["requestId"]).toBe("edge-7f3a9c1e.03");
    const line = output.lines.join("");
    for (const secret of ["handler-token-qx91", "handler-cookie-qx92", "handler-set-cookie-qx93", "handler-password-qx94", "424242", "handler-token-qx95"]) {
      expect(line).not.toContain(secret);
    }
    expect(handlerLine).toMatchObject({
      headers: { authorization: "[Redacted]", cookie: "[Redacted]", "set-cookie": "[Redacted]" },
      body: "[Redacted]",
      token: "[Redacted]",
    });
  });

  it("reads the principal type and a UUID workspace from the stages that set them, and drops anything else", async () => {
    const workspaceId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    async function logged(stages: StageImplementations) {
      const output = sink();
      const hono = new Hono<ChainEnv>();
      installChain(
        hono,
        {
          logger: createLogger({ level: "info", destination: output }),
          routes: new RouteTable([
            { operation: operation("get", "/api/v1/whoami", "whoami"), handler: () => Response.json({}) },
          ]),
          trustedProxyHops: 0,
          appOrigin: "https://bookmarks.example.com",
          challenge: unconfigured().challenge,
          errors: unconfigured().errors,
      ...tenantDependencies(), ...rateLimitDependencies(),
          hooks: hookDispatcher(),
          responseValidation: "throw",
        },
        stages,
      );
      await hono.request("/api/v1/whoami");
      return output.requests();
    }

    expect(
      await logged({
        authentication: async (context, next) => {
          context.set("principalType", "api-token");
          context.set("workspaceId", workspaceId);
          await next();
        },
      }),
    ).toEqual([expect.objectContaining({ principalType: "api-token", workspaceId })]);

    const [named] = await logged({
      "tenant-resolution": async (context, next) => {
        context.set("workspaceId", "Acme Corp <ceo@acme.example>");
        await next();
      },
    });
    expect(named).not.toHaveProperty("workspaceId");
    expect(JSON.stringify(named)).not.toContain("acme");
  });

  it("never turns a failing log destination into a failing request", async () => {
    const failing: Logger = {
      info: () => {
        throw new Error("destination closed");
      },
      warn: () => undefined,
      error: () => undefined,
    };
    const { server } = compose({ logger: failing });
    const response = await server.fetch(new Request("http://localhost/api/v1/whoami"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(UUID_PATTERN);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});

describe("the request span", () => {
  it("is named after the route template and carries no path parameter, query or personal data", async () => {
    const { server } = compose({ hops: 1 });
    await server.fetch(
      new Request("http://localhost/api/v1/things/secret-slug-qx86?token=query-secret-qx87", {
        headers: {
          authorization: "Bearer slb_span-token-qx88",
          cookie: "slugbase_session=span-cookie-qx89",
          "x-forwarded-for": "198.51.100.7",
          "user-agent": "agent-qx89",
        },
      }),
    );
    const [span] = exporter.getFinishedSpans();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(span?.name).toBe("GET /api/v1/things/{id}");
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/api/v1/things/{id}",
      "http.response.status_code": 200,
    });
    const serialized = JSON.stringify({ name: span?.name, attributes: span?.attributes, events: span?.events });
    for (const leaked of ["secret-slug-qx86", "query-secret-qx87", "span-token-qx88", "span-cookie-qx89", "198.51.100.7", "agent-qx89"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("is named by the method alone when no operation matches, and by a constant for an unknown method", async () => {
    const { server } = compose();
    await server.fetch(new Request("http://localhost/api/v1/private-name-qx90"));
    await server.fetch(new Request("http://localhost/api/v1/whoami", { method: "PURGE-qx90" }));
    const names = exporter.getFinishedSpans().map((span) => span.name);
    expect(names).toEqual(["GET", "_OTHER"]);
  });

  it("marks a failed request as an error without recording the failure", async () => {
    const { server } = compose();
    await server.fetch(new Request("http://localhost/api/v1/boom"));
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events).toHaveLength(0);
    expect(span?.attributes["http.response.status_code"]).toBe(500);
  });
});
