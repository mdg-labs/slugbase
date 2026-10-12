import { defineOperation, emptyResponse, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import { unconfigured } from "@slugbase/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RouteTable,
  installChain,
  type ChainEnv,
  type RouteBinding,
  type StageImplementations,
} from "../../src/http/chain.ts";
import { HEADER_RULES, declaredCachePolicy } from "../../src/http/headers.ts";
import { problemDocument } from "../../src/http/problem.ts";
import { operation, recordingLogger } from "../support.ts";
import { directivesOf, expectSecurityHeaders } from "./headers-support.ts";

function app(bindings: readonly RouteBinding[], stages: StageImplementations = {}, appOrigin = "https://bookmarks.example.com") {
  const hono = new Hono<ChainEnv>();
  installChain(
    hono,
    {
      logger: recordingLogger(),
      routes: new RouteTable(bindings),
      trustedProxyHops: 0,
      appOrigin,
      errors: unconfigured().errors,
      responseValidation: "throw",
    },
    stages,
  );
  return hono;
}

const ping: RouteBinding = {
  operation: operation("get", "/api/v1/ping", "ping"),
  handler: () => Response.json({}),
};

function withCache(schema: z.ZodType): OperationDefinition {
  return defineOperation({
    method: "get",
    path: "/api/v1/cached",
    operationId: "cached",
    tag: "test",
    auth: "anonymous",
    rate: "none",
    responses: {
      200: jsonResponse("ok", z.record(z.string(), z.unknown()), {
        headers: { "Cache-Control": { description: "cache policy", schema } },
      }),
      204: emptyResponse("no content"),
      404: problemResponse("not found"),
    },
  });
}

describe("the security headers on a response no operation produced", () => {
  it("are set on a static asset, whose own cache policy stays", async () => {
    const hono = app([], {
      authentication: () =>
        Promise.resolve(
          new Response("console.log(1)", {
            headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" },
          }),
        ),
    });
    const response = await hono.request("/assets/app-3f9a1c.js");
    expect(response.status).toBe(200);
    expectSecurityHeaders(response.headers, { https: true });
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log(1)");
  });

  it("are set on an answer a stage gives before the handler", async () => {
    const hono = app([ping], {
      authentication: () => Promise.resolve(problemDocument("req-0123456789", { code: "unauthenticated", detail: "Sign in." })),
    });
    const response = await hono.request("/api/v1/ping");
    expect(response.status).toBe(401);
    expectSecurityHeaders(response.headers, { https: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("are set on the problem that replaces a stage that failed, even when the security-headers stage never finished", async () => {
    const hono = app([ping], {
      "security-headers": () => {
        throw new Error("stage failed");
      },
    });
    const response = await hono.request("/api/v1/ping");
    expect(response.status).toBe(500);
    expectSecurityHeaders(response.headers, { https: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("are set on the problem that replaces a failing response stage", async () => {
    const hono = app([ping], {
      "audit-telemetry": () => {
        throw new Error("telemetry failed");
      },
    });
    const response = await hono.request("/api/v1/ping");
    expect(response.status).toBe(500);
    expectSecurityHeaders(response.headers, { https: true });
  });

  it("keep the body, the status and the other headers of the answer", async () => {
    const hono = app([
      {
        operation: operation("get", "/api/v1/ping", "ping"),
        handler: () => Response.json({ a: 1 }, { headers: { "x-custom": "kept" } }),
      },
    ]);
    const response = await hono.request("/api/v1/ping");
    expect(await response.json()).toEqual({ a: 1 });
    expect(response.headers.get("x-custom")).toBe("kept");
    expect(response.headers.get("x-request-id")).not.toBeNull();
  });
});

describe("Strict-Transport-Security follows the scheme of APP_ORIGIN", () => {
  it.each([
    ["https://bookmarks.example.com", true],
    ["http://localhost:5173", false],
  ])("for %s", async (origin, https) => {
    const response = await app([ping], {}, origin).request("/api/v1/ping");
    expectSecurityHeaders(response.headers, { https });
  });
});

describe("the declared cache policy", () => {
  it("is the literal a response header declares for the status", () => {
    expect(declaredCachePolicy(withCache(z.literal("public, max-age=60")), 200)).toBe("public, max-age=60");
  });

  it("is absent for a status that declares none", () => {
    const declared = withCache(z.literal("public, max-age=60"));
    expect(declaredCachePolicy(declared, 204)).toBeUndefined();
    expect(declaredCachePolicy(declared, 404)).toBeUndefined();
    expect(declaredCachePolicy(declared, 500)).toBeUndefined();
  });

  it("is absent when the schema does not state one value, so the default applies", () => {
    expect(declaredCachePolicy(withCache(z.string()), 200)).toBeUndefined();
    expect(declaredCachePolicy(withCache(z.enum(["no-store", "public"])), 200)).toBeUndefined();
  });

  it("is what an operation's answer carries, and never reaches that operation's error answers", async () => {
    const declared = withCache(z.literal("public, max-age=60"));
    const hono = app([
      {
        operation: declared,
        handler: (context) => (context.req.query("fail") === undefined ? Response.json({}) : Response.json({}, { status: 201 })),
      },
    ]);
    const ok = await hono.request("/api/v1/cached");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=60");
    const failed = await hono.request("/api/v1/cached?fail=1");
    expect(failed.status).toBe(500);
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });

  it("is read from a header the contract spells in lower case", async () => {
    const declared = defineOperation({
      method: "get",
      path: "/api/v1/cased",
      operationId: "cased",
      tag: "test",
      auth: "anonymous",
      rate: "none",
      responses: {
        200: jsonResponse("ok", z.record(z.string(), z.unknown()), {
          headers: { "cache-control": { description: "cache policy", schema: z.literal("private, max-age=600") } },
        }),
        404: problemResponse("not found"),
      },
    });
    const response = await app([{ operation: declared, handler: () => Response.json({}) }]).request("/api/v1/cased");
    expect(response.headers.get("cache-control")).toBe("private, max-age=600");
  });
});

describe("the header table", () => {
  it("names the /go rule, which sends no referrer and no-store", () => {
    const go = HEADER_RULES.find((rule) => rule.name === "go");
    expect(go?.applies("/go/docs")).toBe(true);
    expect(go?.applies("/gone")).toBe(false);
    expect(go?.applies("/api/go/docs")).toBe(false);
    expect(go?.headers).toEqual({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  });

  it("applies the API rule to /api and below it only", () => {
    const api = HEADER_RULES.find((rule) => rule.name === "api");
    expect(api?.applies("/api")).toBe(true);
    expect(api?.applies("/api/config")).toBe(true);
    expect(api?.applies("/apiary")).toBe(false);
    expect(api?.applies("/assets/api/app.js")).toBe(false);
  });
});

describe("the check the suite runs on every response", () => {
  const good = (): Headers => {
    const headers = new Headers({
      "content-security-policy":
        "default-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    return headers;
  };

  it("accepts the headers the server sends", async () => {
    const response = await app([ping]).request("/api/v1/ping");
    expectSecurityHeaders(response.headers, { https: true });
    expectSecurityHeaders(good(), { https: false });
    expect(directivesOf(response.headers.get("content-security-policy") ?? "").get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("fails a policy without frame-ancestors 'none'", () => {
    const headers = good();
    headers.set("content-security-policy", (headers.get("content-security-policy") ?? "").replace("; frame-ancestors 'none'", ""));
    expect(() => {
      expectSecurityHeaders(headers, { https: false });
    }).toThrow();
  });

  it.each([
    "'unsafe-inline'",
    "'UNSAFE-INLINE'",
    "'unsafe-eval'",
    "'Unsafe-Eval'",
    "*",
    "https://cdn.example.com",
    "cdn.example.com",
    "*.example.com",
    "data:",
  ])("fails a script-src that allows %s", (source) => {
    const headers = good();
    headers.set(
      "content-security-policy",
      (headers.get("content-security-policy") ?? "").replace("script-src 'self'", `script-src 'self' ${source}`),
    );
    expect(() => {
      expectSecurityHeaders(headers, { https: false });
    }).toThrow();
  });

  it.each([
    ["script-src-attr", "script-src-attr 'unsafe-inline'"],
    ["script-src-elem", "script-src-elem 'self' 'unsafe-inline'"],
    ["script-src-elem", "script-src-elem https://cdn.example.com"],
    ["script-src-attr", "script-src-attr 'unsafe-hashes' 'sha256-abc'"],
    ["script-src-elem", "script-src-elem 'self' 'UNSAFE-INLINE'"],
    ["script-src-elem", "script-src-elem cdn.example.com"],
  ])("fails a policy that adds %s: %s", (_name, directive) => {
    const headers = good();
    headers.set("content-security-policy", `${headers.get("content-security-policy") ?? ""}; ${directive}`);
    expect(() => {
      expectSecurityHeaders(headers, { https: false });
    }).toThrow();
  });

  it.each(["frame-ancestors *", "script-src 'unsafe-inline'", "default-src *"])(
    "fails a policy that repeats a directive, ahead of the real one, as %s",
    (directive) => {
      const headers = good();
      headers.set("content-security-policy", `${directive}; ${headers.get("content-security-policy") ?? ""}`);
      expect(() => {
        expectSecurityHeaders(headers, { https: false });
      }).toThrow();
    },
  );

  it("fails a policy that repeats a directive after the real one", () => {
    const headers = good();
    headers.set("content-security-policy", `${headers.get("content-security-policy") ?? ""}; frame-ancestors 'none'`);
    expect(() => {
      expectSecurityHeaders(headers, { https: false });
    }).toThrow();
  });

  it("fails a default-src that allows an inline script", () => {
    const headers = good();
    headers.set(
      "content-security-policy",
      (headers.get("content-security-policy") ?? "").replace("default-src 'self';", "default-src 'self' 'unsafe-inline';").replace("script-src 'self'; ", ""),
    );
    expect(() => {
      expectSecurityHeaders(headers, { https: false });
    }).toThrow();
  });

  it("fails a response that carries a CORS header", () => {
    const headers = good();
    headers.set("access-control-allow-origin", "*");
    expect(() => {
      expectSecurityHeaders(headers, { https: false });
    }).toThrow();
  });
});
