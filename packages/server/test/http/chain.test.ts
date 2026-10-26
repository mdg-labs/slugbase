import { unconfigured } from "@slugbase/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  CHAIN_STAGES,
  RouteTable,
  installChain,
  type ChainEnv,
  type RequestStage,
  type RouteBinding,
  type StageImplementations,
  type StageName,
} from "../../src/http/chain.ts";
import { hookDispatcher, operation, recordingLogger, tenantDependencies, rateLimitDependencies } from "../support.ts";
import { HookResult } from "../../src/hooks/index.ts";

// The order of doc 01 section 4, written out here so that a change to the
// installed order has to change this list as well.
const DOCUMENTED_ORDER: readonly StageName[] = [
  "request-context",
  "security-headers",
  "body-limits",
  "ip-rate-limiting",
  "authentication",
  "cross-site-protection",
  "rate-limiting",
  "tenant-resolution",
  "validation",
  "authorization",
  "idempotency",
  "handler",
  "response",
  "audit-telemetry",
];

function build(bindings: readonly RouteBinding[], stages: StageImplementations = {}, hooks = hookDispatcher()) {
  const app = new Hono<ChainEnv>();
  const logger = recordingLogger();
  const installed = installChain(
    app,
    { logger, routes: new RouteTable(bindings), trustedProxyHops: 0, appOrigin: "https://bookmarks.example.com", challenge: unconfigured().challenge, errors: unconfigured().errors, ...tenantDependencies(), ...rateLimitDependencies(), hooks, responseValidation: "throw" },
    stages,
  );
  return { app, logger, installed };
}

function recorder(trace: string[]): StageImplementations {
  const request = (name: string): RequestStage => async (_context, next) => {
    trace.push(name);
    await next();
  };
  const response = (name: string) => (): void => {
    trace.push(name);
  };
  return {
    "request-context": request("request-context"),
    "security-headers": request("security-headers"),
    "body-limits": request("body-limits"),
    "ip-rate-limiting": request("ip-rate-limiting"),
    authentication: request("authentication"),
    "cross-site-protection": request("cross-site-protection"),
    "rate-limiting": request("rate-limiting"),
    "tenant-resolution": request("tenant-resolution"),
    validation: request("validation"),
    authorization: request("authorization"),
    idempotency: request("idempotency"),
    response: response("response"),
    "audit-telemetry": response("audit-telemetry"),
  };
}

const ping = (trace: string[] = []): RouteBinding => ({
  operation: operation("get", "/api/v1/ping", "ping"),
  handler: () => {
    trace.push("handler");
    return Response.json({});
  },
});

describe("the middleware chain", () => {
  it("lists the stages in the order of doc 01 section 4", () => {
    expect([...CHAIN_STAGES]).toEqual(DOCUMENTED_ORDER);
  });

  it("installs every stage by name in the documented order, pass-throughs included", () => {
    expect(build([]).installed).toEqual(DOCUMENTED_ORDER);
  });

  it("runs the installed stages in the documented order around the handler", async () => {
    const trace: string[] = [];
    const { app } = build([ping(trace)], recorder(trace));
    const response = await app.request("/api/v1/ping");
    expect(response.status).toBe(200);
    expect(trace).toEqual(DOCUMENTED_ORDER);
  });

  it("lets a request stage answer and skips the stages after it, but not the response stages", async () => {
    const trace: string[] = [];
    const stages = recorder(trace);
    const { app } = build([ping(trace)], {
      ...stages,
      authentication: () => {
        trace.push("authentication");
        return Promise.resolve(new Response("no", { status: 401 }));
      },
    });
    const response = await app.request("/api/v1/ping");
    expect(response.status).toBe(401);
    expect(trace).toEqual([
      "request-context",
      "security-headers",
      "body-limits",
      "ip-rate-limiting",
      "authentication",
      "response",
      "audit-telemetry",
    ]);
  });

  it("answers an unknown path with a not_found problem through the whole chain", async () => {
    const trace: string[] = [];
    const { app } = build([ping(trace)], recorder(trace));
    const response = await app.request("/api/v1/nothing");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({
      type: "https://slugbase.app/problems/not_found",
      status: 404,
      code: "not_found",
    });
    expect(trace).not.toContain("handler");
    expect(trace).toContain("authorization");
  });

  it("answers a known path with another method as not_found", async () => {
    const { app } = build([ping()]);
    expect((await app.request("/api/v1/ping", { method: "DELETE", headers: { origin: "https://bookmarks.example.com", "content-type": "application/json" } })).status).toBe(404);
  });

  it("resolves the route before the first stage and hands the decoded parameters to the handler", async () => {
    const seen: unknown[] = [];
    const early: RequestStage = async (context, next) => {
      seen.push(context.get("route")?.operation.operationId);
      await next();
    };
    const { app } = build(
      [
        {
          operation: operation("get", "/api/v1/bookmarks/{id}", "getBookmark"),
          handler: (_context, route) => Response.json(route.params),
        },
        {
          operation: operation("get", "/api/v1/bookmarks/export", "exportBookmarks"),
          handler: () => Response.json({ export: true }),
        },
      ],
      { "request-context": early },
    );
    const byId = await app.request("/api/v1/bookmarks/a%20b");
    expect(await byId.json()).toEqual({ id: "a b" });
    const literal = await app.request("/api/v1/bookmarks/export");
    expect(await literal.json()).toEqual({ export: true });
    expect(seen).toEqual(["getBookmark", "exportBookmarks"]);
  });

  it("does not match an empty, malformed or extra path segment", async () => {
    const { app } = build([
      { operation: operation("get", "/api/v1/bookmarks/{id}", "getBookmark"), handler: () => Response.json({}) },
    ]);
    expect((await app.request("/api/v1/bookmarks/")).status).toBe(404);
    expect((await app.request("/api/v1/bookmarks/%E0%A4%A")).status).toBe(404);
    expect((await app.request("/api/v1/bookmarks/1/2")).status).toBe(404);
  });

  it("matches a template that ends in * to anything below its path, at least one segment deep, and prefers a template that names every segment", async () => {
    const { app } = build([
      { operation: operation("get", "/go/*", "goBeyond"), handler: () => Response.json({ route: "beyond" }) },
      { operation: operation("get", "/go/{slug}", "goTo"), handler: (_context, route) => Response.json({ route: "slug", ...route.params }) },
      { operation: operation("get", "/go/suggest", "goSuggest"), handler: () => Response.json({ route: "suggest" }) },
    ]);
    const answer = async (path: string): Promise<unknown> => (await app.request(path)).json();
    expect(await answer("/go/mail")).toEqual({ route: "slug", slug: "mail" });
    expect(await answer("/go/suggest")).toEqual({ route: "suggest" });
    for (const path of ["/go/mail/inbox", "/go/mail/", "/go/", "/go/a/b/c"]) {
      expect(await answer(path), path).toEqual({ route: "beyond" });
    }
    expect((await app.request("/go")).status).toBe(404);
    expect((await app.request("/gone/mail")).status).toBe(404);
    expect((await app.request("/go/mail", { method: "DELETE", headers: { origin: "https://bookmarks.example.com", "content-type": "application/json" } })).status).toBe(404);
  });

  it("answers a failing stage with a 500 problem that carries neither the message nor the stack", async () => {
    const trace: string[] = [];
    const { app, logger } = build([ping(trace)], {
      ...recorder(trace),
      validation: () => {
        throw new Error("secret-detail-qx90");
      },
    });
    const response = await app.request("/api/v1/ping");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "internal", status: 500 });
    expect(text).not.toContain("secret-detail-qx90");
    expect(JSON.stringify(logger.entries)).not.toContain("secret-detail-qx90");
    expect(logger.entries.map((entry) => entry.level)).toEqual(["error"]);
    expect(trace).toEqual([
      "request-context",
      "security-headers",
      "body-limits",
      "ip-rate-limiting",
      "authentication",
      "cross-site-protection",
      "rate-limiting",
      "tenant-resolution",
      "response",
      "audit-telemetry",
    ]);
  });

  it("answers a failing handler with a 500 problem", async () => {
    const { app } = build([
      {
        operation: operation("get", "/api/v1/ping", "ping"),
        handler: () => Promise.reject(new Error("boom")),
      },
    ]);
    expect((await app.request("/api/v1/ping")).status).toBe(500);
  });

  it("answers a stage that calls next twice with a 500 problem", async () => {
    const { app } = build([ping()], {
      validation: async (_context, next) => {
        await next();
        await next();
      },
    });
    expect((await app.request("/api/v1/ping")).status).toBe(500);
  });

  it("answers a failing response stage with a 500 problem and still runs the stages after it", async () => {
    const trace: string[] = [];
    const { app } = build([ping(trace)], {
      response: () => {
        throw new Error("mapping failed");
      },
      "audit-telemetry": () => {
        trace.push("audit-telemetry");
      },
    });
    const response = await app.request("/api/v1/ping");
    expect(response.status).toBe(500);
    expect(trace).toEqual(["handler", "audit-telemetry"]);
  });
});

describe("hooks in the chain", () => {
  const seatInput = { workspaceId: "w1", accountId: "a1", invitationId: "i1" };

  function withHooks(trace: string[]) {
    const registrations = [
      {
        module: "probe",
        hooks: {
          seatCheck: () => {
            trace.push("seatCheck");
            return { seatLimit: 3 };
          },
          registrationPolicy: () => {
            trace.push("registrationPolicy");
            return HookResult.allow();
          },
        },
      },
    ];
    return hookDispatcher(registrations);
  }

  const consulting = (trace: string[]): RouteBinding => ({
    operation: operation("get", "/api/v1/ping", "ping"),
    handler: async (context) => {
      trace.push("handler");
      const limit = await context.get("hooks")?.seatLimit(seatInput, null);
      return Response.json({ limit });
    },
  });

  it("runs a hook only after every request stage, from inside the handler", async () => {
    const trace: string[] = [];
    const { app } = build([consulting(trace)], recorder(trace), withHooks(trace));
    const response = await app.request("/api/v1/ping");
    expect(await response.json()).toEqual({ limit: 3 });
    expect(trace).toEqual([
      "request-context",
      "security-headers",
      "body-limits",
      "ip-rate-limiting",
      "authentication",
      "cross-site-protection",
      "rate-limiting",
      "tenant-resolution",
      "validation",
      "authorization",
      "idempotency",
      "handler",
      "seatCheck",
      "response",
      "audit-telemetry",
    ]);
  });

  it("gives no request stage a way to consult a hook", async () => {
    const trace: string[] = [];
    const sees = (name: string): RequestStage => async (context, next) => {
      trace.push(`${name}:${context.get("hooks") === undefined ? "none" : "hooks"}`);
      await next();
    };
    const { app } = build([consulting([])], { authentication: sees("authentication"), authorization: sees("authorization") }, withHooks(trace));
    await app.request("/api/v1/ping");
    expect(trace.slice(0, 2)).toEqual(["authentication:none", "authorization:none"]);
  });

  it("does not run a hook when a stage answers before the handler", async () => {
    const trace: string[] = [];
    const { app } = build(
      [consulting(trace)],
      { authorization: () => Promise.resolve(new Response("no", { status: 403 })), response: () => undefined },
      withHooks(trace),
    );
    expect((await app.request("/api/v1/ping")).status).toBe(403);
    expect(trace).toEqual([]);
  });

  it("hands a hook plain values only", async () => {
    const received: unknown[] = [];
    const hooks = hookDispatcher([
      {
        module: "probe",
        hooks: {
          seatCheck: (input) => {
            received.push(input);
            return { seatLimit: null };
          },
        },
      },
    ]);
    const { app } = build([consulting([])], {}, hooks);
    await app.request("/api/v1/ping");
    expect(received).toEqual([seatInput]);
    for (const value of Object.values(received[0] as object)) {
      expect(typeof value).toBe("string");
    }
  });

  it("answers 503 unavailable, with nothing written, when a hook fails", async () => {
    const written: string[] = [];
    const hooks = hookDispatcher([
      {
        module: "broken",
        hooks: {
          seatCheck: () => {
            throw new Error("boom");
          },
        },
      },
    ]);
    const { app } = build(
      [
        {
          operation: operation("get", "/api/v1/ping", "ping"),
          handler: async (context) => {
            await context.get("hooks")?.seatLimit(seatInput, null);
            written.push("membership");
            return Response.json({});
          },
        },
      ],
      {},
      hooks,
    );
    const response = await app.request("/api/v1/ping");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(written).toEqual([]);
  });
});
