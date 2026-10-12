import { defineOperation, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import type { Adapters } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CompositionError, createServer, type RouteBinding, type ServerModule } from "../../src/create-server.ts";
import { sanitiseOrigin } from "../../src/http/cross-site.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// The http/cross-site suite (doc 08 section 3.5): stage 5 of the chain, exercised
// through the mutation routes a test module registers.

const APP_ORIGIN = serverConfig().APP_ORIGIN;
const MARKETING_ORIGIN = "https://www.example.com";
const Echo = z.record(z.string(), z.unknown());

interface Seen {
  readonly method: string;
  readonly cookie: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

function operationOf(
  method: OperationDefinition["method"],
  path: string,
  operationId: string,
  extra: Pick<OperationDefinition, "audience" | "auth"> = { auth: "anonymous" },
): OperationDefinition {
  return defineOperation({
    method,
    path,
    operationId,
    tag: "test",
    rate: "none",
    ...extra,
    responses: { 200: jsonResponse("ok", Echo), 400: problemResponse("bad request") },
  });
}

function setup(challenge: { ok: boolean } = { ok: true }) {
  const seen: Seen[] = [];
  const solutions: (string | undefined)[] = [];
  const handler: RouteBinding["handler"] = async (context) => {
    seen.push({
      method: context.req.method,
      cookie: context.req.header("cookie"),
      authorization: context.req.header("authorization"),
      body: await context.req.text(),
    });
    return Response.json({});
  };
  const routes: RouteBinding[] = [
    { operation: operationOf("post", "/api/v1/things", "createThing"), handler },
    { operation: operationOf("put", "/api/v1/things/{id}", "replaceThing"), handler },
    { operation: operationOf("patch", "/api/v1/things/{id}", "updateThing"), handler },
    { operation: operationOf("delete", "/api/v1/things/{id}", "deleteThing"), handler },
    { operation: operationOf("get", "/api/v1/things", "listThings"), handler },
    { operation: operationOf("post", "/api/v1/auth/login", "login"), handler },
    { operation: operationOf("post", "/api/v1/import/netscape", "importNetscape"), handler, acceptsMultipart: true },
    { operation: operationOf("post", "/api/v1/events", "receiveEvent", { auth: "machine", audience: "machine" }), handler },
    {
      operation: operationOf("post", "/api/v1/contact", "sendContact", { auth: "anonymous", audience: "marketing-form" }),
      handler,
      marketingOrigin: MARKETING_ORIGIN,
    },
  ];
  const module: ServerModule = { name: "cross-site-routes", register: () => ({ routes }) };
  const logger = recordingLogger();
  const port: Adapters = {
    ...adapters(),
    challenge: {
      available: true,
      verify: (solution) => {
        solutions.push(solution);
        return Promise.resolve(challenge);
      },
    },
  };
  const server = createServer({ config: serverConfig(), adapters: port, modules: [module], migrations: [], logger, database: fakeDatabase() });
  return { server, seen, solutions, logger };
}

const JSON_TYPE = { "content-type": "application/json" };
const SAME_ORIGIN = { origin: APP_ORIGIN, ...JSON_TYPE };

function send(path: string, init: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function codeOf(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return ((await response.json()) as { code: string }).code;
}

describe("a mutation from the app's own origin", () => {
  it.each([
    ["post", "/api/v1/things"],
    ["put", "/api/v1/things/1"],
    ["patch", "/api/v1/things/1"],
    ["delete", "/api/v1/things/1"],
  ] as const)("reaches the handler for %s", async (method, path) => {
    const { server, seen } = setup();
    const response = await server.fetch(send(path, { method: method.toUpperCase(), headers: SAME_ORIGIN, body: "{}" }));
    expect(response.status).toBe(200);
    expect(seen.map((entry) => entry.method)).toEqual([method.toUpperCase()]);
  });

  it("accepts a JSON media type with parameters and in any case, and Sec-Fetch-Site: same-origin", async () => {
    const { server, seen } = setup();
    for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
      const response = await server.fetch(
        send("/api/v1/things", { method: "POST", headers: { origin: APP_ORIGIN, "content-type": type, "sec-fetch-site": "same-origin" }, body: "{}" }),
      );
      expect(response.status, type).toBe(200);
    }
    expect(seen).toHaveLength(2);
  });

  it("keeps the cookie and the body", async () => {
    const { server, seen } = setup();
    await server.fetch(send("/api/v1/things", { method: "POST", headers: { ...SAME_ORIGIN, cookie: "session=abc" }, body: '{"a":1}' }));
    expect(seen).toEqual([{ method: "POST", cookie: "session=abc", authorization: undefined, body: '{"a":1}' }]);
  });
});

describe("the failure scenario: a hostile page submits a form with the member's cookie", () => {
  it("answers 403 cross_site_request to a text/plain form and never calls the handler", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(
      send("/api/v1/things", {
        method: "POST",
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain", cookie: "session=abc" },
        body: '{"title":"x"}',
      }),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site_request");
    expect(seen).toEqual([]);
  });

  it("refuses the same form even when the page's Origin is hidden, by its content type", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(
      send("/api/v1/things", { method: "POST", headers: { origin: APP_ORIGIN, "content-type": "text/plain", cookie: "session=abc" }, body: "x" }),
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });
});

describe("the Origin header", () => {
  it("is required on every mutation method", async () => {
    const { server, seen, logger } = setup();
    for (const [method, path] of [["POST", "/api/v1/things"], ["PUT", "/api/v1/things/1"], ["PATCH", "/api/v1/things/1"], ["DELETE", "/api/v1/things/1"]] as const) {
      const response = await server.fetch(send(path, { method, headers: JSON_TYPE, body: "{}" }));
      expect(response.status, method).toBe(403);
      expect(await codeOf(response)).toBe("cross_site_request");
    }
    expect(seen).toEqual([]);
    expect(logger.entries.filter((entry) => entry.level === "warn" && entry.fields["reason"] === "missing_origin")).toHaveLength(4);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["another scheme", APP_ORIGIN.replace("https:", "http:")],
    ["another port", `${APP_ORIGIN}:8443`],
    ["a subdomain", APP_ORIGIN.replace("https://", "https://www.")],
    ["a trailing slash", `${APP_ORIGIN}/`],
    ["a prefix of the app origin", `${APP_ORIGIN}.evil.example`],
    ["null", "null"],
    ["the empty string", ""],
    ["two origins", `${APP_ORIGIN}, https://evil.example`],
  ])("must equal APP_ORIGIN exactly: %s is refused", async (_name, origin) => {
    const { server, seen } = setup();
    const response = await server.fetch(send("/api/v1/things", { method: "POST", headers: { origin, ...JSON_TYPE }, body: "{}" }));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site_request");
    expect(seen).toEqual([]);
  });
});

describe("Sec-Fetch-Site", () => {
  it.each(["cross-site", "same-site", "none", "", "Same-Origin"])("refuses %j when it is present", async (value) => {
    const { server, seen } = setup();
    const response = await server.fetch(
      send("/api/v1/things", { method: "POST", headers: { ...SAME_ORIGIN, "sec-fetch-site": value }, body: "{}" }),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site_request");
    expect(seen).toEqual([]);
  });

  it("is not required when it is absent", async () => {
    const { server } = setup();
    expect((await server.fetch(send("/api/v1/things", { method: "POST", headers: SAME_ORIGIN, body: "{}" }))).status).toBe(200);
  });
});

describe("the content type", () => {
  it.each([
    ["text/plain", "text/plain"],
    ["application/x-www-form-urlencoded", "application/x-www-form-urlencoded"],
    ["multipart/form-data on a route that does not declare it", "multipart/form-data; boundary=x"],
    ["application/json-patch+json", "application/json-patch+json"],
    ["a missing content type", undefined],
  ])("must be application/json: %s is refused", async (_name, type) => {
    const { server, seen } = setup();
    const headers: Record<string, string> = { origin: APP_ORIGIN };
    if (type !== undefined) {
      headers["content-type"] = type;
    }
    const response = await server.fetch(send("/api/v1/things", { method: "POST", headers, body: "a=1" }));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site_request");
    expect(seen).toEqual([]);
  });

  it("is multipart/form-data on a route that declares it, and only there", async () => {
    const { server, seen } = setup();
    const headers = { origin: APP_ORIGIN, "content-type": "multipart/form-data; boundary=x" };
    expect((await server.fetch(send("/api/v1/import/netscape", { method: "POST", headers, body: "--x--" }))).status).toBe(200);
    expect((await server.fetch(send("/api/v1/import/netscape", { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: "--x--" }))).status).toBe(403);
    expect((await server.fetch(send("/api/v1/import/netscape", { method: "POST", headers: { origin: APP_ORIGIN, "content-type": "text/plain" }, body: "x" }))).status).toBe(403);
    expect(seen).toHaveLength(1);
  });
});

describe("no path is exempt", () => {
  it("checks an anonymous mutation such as sign-in", async () => {
    const { server, seen } = setup();
    const refused = await server.fetch(send("/api/v1/auth/login", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }));
    expect(refused.status).toBe(403);
    expect(seen).toEqual([]);
    const accepted = await server.fetch(send("/api/v1/auth/login", { method: "POST", headers: SAME_ORIGIN, body: "{}" }));
    expect(accepted.status).toBe(200);
  });

  it("checks a mutation to a path no operation serves", async () => {
    const { server } = setup();
    const refused = await server.fetch(send("/nowhere", { method: "POST", headers: JSON_TYPE, body: "{}" }));
    expect(refused.status).toBe(403);
    const passed = await server.fetch(send("/nowhere", { method: "POST", headers: SAME_ORIGIN, body: "{}" }));
    expect(passed.status).toBe(404);
  });
});

describe("safe methods", () => {
  it("never blocks GET and HEAD, whatever the Origin and content type", async () => {
    const { server, seen } = setup();
    const hostile = { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" };
    const get = await server.fetch(send("/api/v1/things", { method: "GET", headers: hostile }));
    expect(get.status).toBe(200);
    const head = await server.fetch(send("/api/v1/things", { method: "HEAD", headers: hostile }));
    expect(head.status).not.toBe(403);
    expect(seen.map((entry) => entry.method)).toEqual(["GET"]);
  });
});

describe("a bearer request", () => {
  const bearer = { authorization: "Bearer example-token" };

  it("skips the rule and loses its cookies, whatever the method", async () => {
    const { server, seen } = setup();
    const mutation = await server.fetch(send("/api/v1/things", { method: "POST", headers: { ...bearer, ...JSON_TYPE, cookie: "session=abc" }, body: '{"a":1}' }));
    expect(mutation.status).toBe(200);
    const read = await server.fetch(send("/api/v1/things", { method: "GET", headers: { ...bearer, cookie: "session=abc" } }));
    expect(read.status).toBe(200);
    expect(seen).toEqual([
      { method: "POST", cookie: undefined, authorization: "Bearer example-token", body: '{"a":1}' },
      { method: "GET", cookie: undefined, authorization: "Bearer example-token", body: "" },
    ]);
  });

  it("keeps a request without a body bodiless", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(send("/api/v1/things/1", { method: "DELETE", headers: { ...bearer, cookie: "session=abc" } }));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: "DELETE", cookie: undefined, authorization: "Bearer example-token", body: "" }]);
  });

  it("does not skip the rule with another Authorization scheme, and still loses its cookies", async () => {
    const { server, seen } = setup();
    const refused = await server.fetch(
      send("/api/v1/things", { method: "POST", headers: { authorization: "Basic dXNlcjpwYXNz", "content-type": "text/plain", cookie: "session=abc" }, body: "x" }),
    );
    expect(refused.status).toBe(403);
    const accepted = await server.fetch(
      send("/api/v1/things", { method: "POST", headers: { ...SAME_ORIGIN, authorization: "Basic dXNlcjpwYXNz", cookie: "session=abc" }, body: "{}" }),
    );
    expect(accepted.status).toBe(200);
    expect(seen.map((entry) => entry.cookie)).toEqual([undefined]);
  });
});

describe("a machine route", () => {
  it("takes a request that is not from the app origin and strips its cookies before the handler", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(
      send("/api/v1/events", { method: "POST", headers: { "content-type": "text/plain", cookie: "session=abc" }, body: "payload" }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: "POST", cookie: undefined, authorization: undefined, body: "payload" }]);
  });
});

describe("a marketing-form route", () => {
  const form = { origin: MARKETING_ORIGIN, ...JSON_TYPE };

  it("takes the marketing origin, strips cookies and verifies the challenge before the handler", async () => {
    const { server, seen, solutions } = setup();
    const response = await server.fetch(
      send("/api/v1/contact", { method: "POST", headers: { ...form, cookie: "session=abc", "x-challenge-solution": "solved" }, body: '{"a":1}' }),
    );
    expect(response.status).toBe(200);
    expect(solutions).toEqual(["solved"]);
    expect(seen).toEqual([{ method: "POST", cookie: undefined, authorization: undefined, body: '{"a":1}' }]);
  });

  it("refuses the app's own origin, any other origin and a missing one", async () => {
    const { server, seen, solutions } = setup();
    for (const origin of [APP_ORIGIN, "https://evil.example", `${MARKETING_ORIGIN}/`, undefined]) {
      const headers: Record<string, string> = { ...JSON_TYPE, cookie: "session=abc" };
      if (origin !== undefined) {
        headers["origin"] = origin;
      }
      const response = await server.fetch(send("/api/v1/contact", { method: "POST", headers, body: "{}" }));
      expect(response.status, String(origin)).toBe(403);
      expect(await codeOf(response)).toBe("cross_site_request");
    }
    expect(seen).toEqual([]);
    expect(solutions).toEqual([]);
  });

  it("checks the rule even when the request carries a bearer token", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(
      send("/api/v1/contact", { method: "POST", headers: { ...JSON_TYPE, authorization: "Bearer example-token" }, body: "{}" }),
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("must be JSON", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(send("/api/v1/contact", { method: "POST", headers: { origin: MARKETING_ORIGIN, "content-type": "text/plain" }, body: "x" }));
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("answers 403 forbidden and never calls the handler when the challenge is not solved", async () => {
    const { server, seen, solutions } = setup({ ok: false });
    const response = await server.fetch(send("/api/v1/contact", { method: "POST", headers: form, body: "{}" }));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("forbidden");
    expect(solutions).toEqual([undefined]);
    expect(seen).toEqual([]);
  });
});

describe("CORS", () => {
  it.each(["/api/v1/things", "/api/v1/things/1", "/api/v1/nowhere", "/api"])("refuses an OPTIONS preflight to %s with 403", async (path) => {
    const { server, seen } = setup();
    const response = await server.fetch(
      send(path, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site_request");
    expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("does not turn a preflight away outside /api", async () => {
    const { server } = setup();
    expect((await server.fetch(send("/apiary", { method: "OPTIONS" }))).status).toBe(404);
  });

  it("emits no CORS header on an accepted or a refused request", async () => {
    const { server } = setup();
    const accepted = await server.fetch(send("/api/v1/things", { method: "POST", headers: SAME_ORIGIN, body: "{}" }));
    const refused = await server.fetch(send("/api/v1/things", { method: "POST", headers: { origin: "https://evil.example", ...JSON_TYPE }, body: "{}" }));
    for (const response of [accepted, refused]) {
      expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("the log line of a refusal", () => {
  it("is a warning with the reason and a truncated, sanitised origin", async () => {
    const { server, logger } = setup();
    const hostile = `https://evil.example/\t${"a".repeat(500)}é`;
    await server.fetch(send("/api/v1/things", { method: "POST", headers: { origin: hostile, ...JSON_TYPE }, body: "{}" }));
    const line = logger.entries.find((entry) => entry.message === "Cross-site request refused");
    expect(line?.level).toBe("warn");
    expect(line?.fields["reason"]).toBe("origin_mismatch");
    const logged = String(line?.fields["origin"]);
    expect(logged.length).toBeLessThanOrEqual(103);
    expect(logged).toMatch(/^[\x20-\x7e]+$/);
    expect(logged).toContain("https://evil.example/?");
  });

  it("does not echo the origin back to the caller", async () => {
    const { server } = setup();
    const response = await server.fetch(send("/api/v1/things", { method: "POST", headers: { origin: "https://evil.example", ...JSON_TYPE }, body: "{}" }));
    expect(JSON.stringify(await response.json())).not.toContain("evil.example");
  });

  it("sanitiseOrigin leaves a missing origin missing and replaces control characters", () => {
    expect(sanitiseOrigin(null)).toBeNull();
    expect(sanitiseOrigin("a\r\nb\u0000c")).toBe("a??b?c");
  });
});

describe("the audience declaration of a route", () => {
  function composeWith(binding: RouteBinding) {
    return () =>
      createServer({
        config: serverConfig(),
        adapters: adapters(),
        modules: [{ name: "declared", register: () => ({ routes: [binding] }) }],
        migrations: [],
        logger: recordingLogger(),
        database: fakeDatabase(),
      });
  }
  const handler = () => Response.json({});
  const marketing = operationOf("post", "/api/v1/contact", "sendContact", { auth: "anonymous", audience: "marketing-form" });

  it.each([
    ["has no origin", { operation: marketing, handler }],
    ["has an origin with a path", { operation: marketing, handler, marketingOrigin: "https://www.example.com/contact" }],
    ["has an origin that is not http or https", { operation: marketing, handler, marketingOrigin: "ftp://www.example.com" }],
    ["is a GET", { operation: operationOf("get", "/api/v1/contact", "readContact", { auth: "anonymous", audience: "marketing-form" }), handler, marketingOrigin: MARKETING_ORIGIN }],
    ["is not a marketing-form route but names an origin", { operation: operationOf("post", "/api/v1/things", "createThing"), handler, marketingOrigin: MARKETING_ORIGIN }],
  ] satisfies [string, RouteBinding][])("refuses a route that %s", (_name, binding) => {
    expect(composeWith(binding)).toThrow(CompositionError);
    try {
      composeWith(binding)();
    } catch (error) {
      expect((error as CompositionError).code).toBe("invalid_route");
    }
  });

  it("accepts a marketing-form route with an origin", () => {
    expect(composeWith({ operation: marketing, handler, marketingOrigin: MARKETING_ORIGIN })).not.toThrow();
  });
});
