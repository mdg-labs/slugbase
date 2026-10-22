import {
  PROBLEM_CATALOG,
  defineOperation,
  emptyResponse,
  jsonResponse,
  problemResponse,
  problemStatus,
  type OperationDefinition,
} from "@slugbase/contracts";
import { PortUnavailable, unconfigured, type Adapters, type ErrorReportContext } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProblemError } from "../../src/index.ts";
import { createServer, type RouteBinding, type ServerModule } from "../../src/create-server.ts";
import { describeError, mapError, problemDocument } from "../../src/http/problem.ts";
import { fakeDatabase, recordingLogger, serverConfig, documentOf } from "../support.ts";

interface Captured {
  readonly error: unknown;
  readonly context: ErrorReportContext | undefined;
}

function recordingErrorPort(behaviour: "ok" | "reject" | "throw" = "ok") {
  const captured: Captured[] = [];
  const port: Adapters["errors"] = {
    available: true,
    capture: (error, context) => {
      captured.push({ error, context });
      if (behaviour === "throw") {
        throw new Error("reporter down at postgres://reporter:hunter2@errors.internal/db");
      }
      return behaviour === "reject" ? Promise.reject(new Error("reporter rejected")) : Promise.resolve();
    },
  };
  return { port, captured };
}

const widget = defineOperation({
  method: "get",
  path: "/api/v1/widgets/{id}",
  operationId: "getWidget",
  tag: "test",
  auth: "anonymous",
  rate: "none",
  responses: {
    200: jsonResponse("ok", z.strictObject({ id: z.string(), name: z.string() })),
    204: emptyResponse("none"),
    404: problemResponse("not found"),
  },
});

function serve(
  handler: RouteBinding["handler"],
  options: { env?: string; port?: Adapters["errors"]; path?: string; operation?: OperationDefinition } = {},
) {
  const logger = recordingLogger();
  const errors = recordingErrorPort();
  const module: ServerModule = {
    name: "widgets",
    register: () => ({ routes: [{ operation: options.operation ?? widget, handler }] }),
  };
  const server = createServer({
    config: serverConfig(options.env === undefined ? {} : { NODE_ENV: options.env }),
    adapters: { ...unconfigured(), errors: options.port ?? errors.port },
    modules: [module],
    openApiDocument: documentOf([module]),
    migrations: [],
    logger,
    database: fakeDatabase(),
  });
  const request = (path = "/api/v1/widgets/7") => server.fetch(new Request(`http://localhost${path}`));
  return { request, logger, errors };
}

const everyCode = PROBLEM_CATALOG.map((entry) => entry.code);

describe("problem documents", () => {
  it.each(everyCode)("builds %s with its catalog status, a static title and the request ID header", (code) => {
    const response = problemDocument("req-1", { code, detail: "English detail." });
    expect(response.status).toBe(problemStatus(code));
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("x-request-id")).toBe("req-1");
  });

  it("carries type, title, status, code, detail, requestId and errors", async () => {
    const response = problemDocument("req-1", {
      code: "slug_taken",
      detail: 'You already use the slug "mail" in this workspace.',
      errors: [{ path: "slug", code: "slug_taken" }],
    });
    expect(await response.json()).toEqual({
      type: "https://slugbase.app/problems/slug_taken",
      title: "Slug already in use",
      status: 409,
      code: "slug_taken",
      detail: 'You already use the slug "mail" in this workspace.',
      requestId: "req-1",
      errors: [{ path: "slug", code: "slug_taken" }],
    });
  });

  it("gives every code a distinct non-empty title", async () => {
    const titles = new Set<string>();
    for (const code of everyCode) {
      const body = (await problemDocument("r", { code, detail: "d" }).json()) as { title: string };
      expect(body.title).not.toBe("");
      titles.add(body.title);
    }
    expect(titles.size).toBe(everyCode.length);
  });
});

describe("mapError", () => {
  it("maps a ZodError to validation_failed with one entry per issue and no input value", () => {
    const parsed = z.strictObject({ slug: z.string().min(3), tags: z.array(z.number()) }).safeParse({
      slug: "x",
      tags: ["secret-value-91"],
      extra: 1,
    });
    if (parsed.success) {
      throw new Error("expected the parse to fail");
    }
    const problem = mapError(parsed.error);
    expect(problem.code).toBe("validation_failed");
    expect(problem.unexpected).toBe(false);
    expect(problem.errors).toEqual([
      { path: "slug", code: "too_small" },
      { path: "tags.0", code: "invalid_type" },
      { path: "extra", code: "unrecognized_keys" },
    ]);
    expect(JSON.stringify(problem)).not.toContain("secret-value-91");
  });

  it.each(["unavailable", "mail_unavailable", "ai_unavailable", "billing_unavailable"] as const)(
    "maps a PortUnavailable carrying %s to a 503 with that code and no port name",
    (code) => {
      const problem = mapError(new PortUnavailable("secretBox", code));
      expect(problem.code).toBe(code);
      expect(problemStatus(problem.code)).toBe(503);
      expect(problem.unexpected).toBe(false);
      expect(problem.detail).not.toContain("secretBox");
    },
  );

  it("maps a ProblemError to its own code, detail and field errors", () => {
    const problem = mapError(new ProblemError("slug_taken", "taken", { errors: [{ path: "slug", code: "slug_taken" }] }));
    expect(problem).toEqual({
      code: "slug_taken",
      detail: "taken",
      errors: [{ path: "slug", code: "slug_taken" }],
      unexpected: false,
    });
  });

  it("maps anything else to internal with a static detail", () => {
    for (const thrown of [new Error("select * from bookmarks"), "text", undefined, { code: "not_found" }]) {
      const problem = mapError(thrown);
      expect(problem.code).toBe("internal");
      expect(problem.unexpected).toBe(true);
      expect(problem.detail).toBe("The request could not be completed.");
    }
  });

  it("describes an error by a safe class name and code only", () => {
    class Hostile extends Error {
      override name = "postgres://u:p@h/db";
      readonly code = "select * from users";
    }
    expect(describeError(new Hostile("boom"))).toEqual({});
    expect(describeError(Object.assign(new Error("boom"), { code: "28P01" }))).toEqual({
      errorName: "Error",
      errorCode: "28P01",
    });
  });
});

describe("the server's problem responses", () => {
  it("answers an unknown route with 404 not_found and a request ID equal to the header", async () => {
    const { request, errors } = serve(() => Response.json({ id: "1", name: "n" }));
    const response = await request("/api/v1/nothing");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = (await response.json()) as { requestId: string; code: string; title: string };
    expect(body).toMatchObject({ code: "not_found", title: "Not found", type: "https://slugbase.app/problems/not_found" });
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.requestId).not.toBe("");
    expect(errors.captured).toEqual([]);
  });

  it("answers a thrown ZodError with 422 validation_failed and errors[]", async () => {
    const { request, logger, errors } = serve(() => {
      z.object({ name: z.string() }).parse({ name: 3 });
      return Response.json({});
    });
    const response = await request();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "validation_failed",
      status: 422,
      detail: "The request did not pass validation.",
      errors: [{ path: "name", code: "invalid_type" }],
    });
    expect(logger.entries).toEqual([]);
    expect(errors.captured).toEqual([]);
  });

  it("answers an unavailable port with 503 and the port's code", async () => {
    const { request, errors } = serve(() => Promise.reject(new PortUnavailable("mail", "mail_unavailable")));
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "mail_unavailable", status: 503 });
    expect(errors.captured).toEqual([]);
  });

  it("answers a ProblemError with its own status and code", async () => {
    const { request } = serve(() => {
      throw new ProblemError("slug_taken", 'You already use the slug "mail" in this workspace.', {
        errors: [{ path: "slug", code: "slug_taken" }],
      });
    });
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "slug_taken",
      detail: 'You already use the slug "mail" in this workspace.',
      errors: [{ path: "slug", code: "slug_taken" }],
    });
  });

  it("keeps SQL and a connection string out of the body and the log, and reports the 500 with the request ID", async () => {
    const connection = "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase";
    const sql = 'insert into "bookmarks" ("id", "workspace_id") values ($1, $2)';
    const failure = Object.assign(new Error(`connect failed for ${connection}: ${sql}`), {
      name: "PostgresError",
      code: "28P01",
      query: sql,
      detail: connection,
      stack: `PostgresError: ${connection}\n    at /srv/app/db.ts:12:3`,
    });
    const { request, logger, errors } = serve(() => Promise.reject(failure));
    const response = await request();
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = JSON.parse(text) as { requestId: string; code: string };
    expect(body.code).toBe("internal");
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    for (const secret of [connection, "Zq8-prod-app-pw", "insert into", "bookmarks", "/srv/app", "db.internal", "at "]) {
      expect(text).not.toContain(secret);
      expect(JSON.stringify(logger.entries)).not.toContain(secret);
    }
    expect(logger.entries).toEqual([
      {
        level: "error",
        message: "Request failed",
        fields: { errorName: "PostgresError", errorCode: "28P01", requestId: body.requestId },
      },
    ]);
    await Promise.resolve();
    expect(errors.captured).toEqual([
      { error: failure, context: { requestId: body.requestId, route: "GET /api/v1/widgets/{id}" } },
    ]);
  });

  it("still answers 500 when the error port rejects or throws, and logs neither message", async () => {
    for (const behaviour of ["reject", "throw"] as const) {
      const reporter = recordingErrorPort(behaviour);
      const { request, logger } = serve(() => Promise.reject(new Error("boom")), { port: reporter.port });
      const response = await request();
      expect(response.status).toBe(500);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reporter.captured).toHaveLength(1);
      expect(logger.entries.map((entry) => entry.level)).toEqual(["error", "warn"]);
      expect(JSON.stringify(logger.entries)).not.toContain("hunter2");
      expect(JSON.stringify(logger.entries)).not.toContain("reporter rejected");
    }
  });

  it("uses the unconfigured error port as a no-op", async () => {
    const logger = recordingLogger();
    const server = createServer({
      config: serverConfig(),
      adapters: unconfigured(),
      modules: [{ name: "w", register: () => ({ routes: [{ operation: widget, handler: () => Promise.reject(new Error("x")) }] }) }],
      openApiDocument: documentOf([{ name: "w", register: () => ({ routes: [{ operation: widget, handler: () => Promise.reject(new Error("x")) }] }) }]),
      migrations: [],
      logger,
      database: fakeDatabase(),
    });
    expect((await server.fetch(new Request("http://localhost/api/v1/widgets/1"))).status).toBe(500);
  });
});

describe("response validation", () => {
  const good = () => Response.json({ id: "1", name: "n" });

  it("passes a response that matches its declared schema unchanged", async () => {
    const { request } = serve(good, { env: "test" });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "1", name: "n" });
  });

  it("throws in development and CI on an undeclared field, answering 500 internal", async () => {
    for (const env of ["development", "test"]) {
      const { request, logger } = serve(() => Response.json({ id: "1", name: "n", passwordHash: "x" }), { env });
      const response = await request();
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: "internal" });
      expect(text).not.toContain("passwordHash");
      expect(logger.entries).toHaveLength(1);
    }
  });

  it("throws in development on an undeclared field of a non-strict schema", async () => {
    const lenient = defineOperation({
      ...widget,
      responses: { ...widget.responses, 200: jsonResponse("ok", z.object({ id: z.string() })) },
    });
    const { request } = serve(() => Response.json({ id: "1", extra: 2 }), { env: "test", operation: lenient });
    expect((await request()).status).toBe(500);
  });

  it("strips undeclared fields in production, nested ones included", async () => {
    const nested = defineOperation({
      ...widget,
      responses: {
        ...widget.responses,
        200: jsonResponse("ok", z.strictObject({ id: z.string(), owner: z.strictObject({ name: z.string() }) })),
      },
    });
    const { request, logger } = serve(
      () => Response.json({ id: "1", token: "t", owner: { name: "o", email: "e@example.com" } }),
      { operation: nested },
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "1", owner: { name: "o" } });
    expect(logger.entries).toEqual([]);
  });

  it("strips undeclared fields of a non-strict schema in production", async () => {
    const lenient = defineOperation({
      ...widget,
      responses: { ...widget.responses, 200: jsonResponse("ok", z.object({ id: z.string() })) },
    });
    const { request } = serve(() => Response.json({ id: "1", extra: 2 }), { operation: lenient });
    expect(await (await request()).json()).toEqual({ id: "1" });
  });

  it("answers 500 in production for a mismatch that stripping does not fix", async () => {
    const { request } = serve(() => Response.json({ id: 1, name: "n" }));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal" });
  });

  it("answers 500 for an undeclared status, a wrong content type and a body on an empty response", async () => {
    const undeclared = serve(() => Response.json({}, { status: 201 }), { env: "test" });
    expect((await undeclared.request()).status).toBe(500);
    const text = serve(() => new Response("{}", { headers: { "content-type": "text/plain" } }), { env: "test" });
    expect((await text.request()).status).toBe(500);
    const body = serve(() => new Response("x", { status: 204 }), { env: "test" });
    expect((await body.request()).status).toBe(500);
  });

  it("accepts a declared empty response", async () => {
    const { request } = serve(() => new Response(null, { status: 204 }));
    expect((await request()).status).toBe(204);
  });

  it("checks a problem response from a handler against the problem schema", async () => {
    const invalid = serve(() => Response.json({ code: "nope" }, { status: 404, headers: { "content-type": "application/problem+json" } }));
    expect((await invalid.request()).status).toBe(500);

    const wrongId = serve(() =>
      new Response(
        JSON.stringify({
          type: "https://slugbase.app/problems/not_found",
          title: "Not found",
          status: 404,
          code: "not_found",
          detail: "d",
          requestId: "someone-else",
        }),
        { status: 404, headers: { "content-type": "application/problem+json", "x-request-id": "mine" } },
      ),
    );
    expect((await wrongId.request()).status).toBe(500);

    const built = serve(() => problemDocument("rid", { code: "not_found", detail: "d" }));
    expect((await built.request()).status).toBe(404);
  });

  it("sends a stripped production body without the handler's stale Content-Length", async () => {
    const body = JSON.stringify({ id: "1", name: "n", secretExtra: "x".repeat(40) });
    const server = serve(
      () => new Response(body, { headers: { "content-type": "application/json", "content-length": String(body.length) } }),
      { env: "production" },
    );
    const response = await server.request();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ id: "1", name: "n" });
    expect(text.length).toBeLessThan(body.length);
    expect(response.headers.get("content-length")).not.toBe(String(body.length));
  });

  it("answers a rejected response with a clean 500 that keeps none of its headers", async () => {
    const rejected = JSON.stringify({ code: "nope" });
    const server = serve(
      () =>
        new Response(rejected, {
          status: 404,
          headers: {
            "content-type": "application/problem+json",
            "content-length": String(rejected.length),
            "x-request-id": "mine",
            "cache-control": "public, max-age=60",
            etag: '"abc"',
            "set-cookie": "sid=1; Path=/",
          },
        }),
    );
    const response = await server.request();
    const text = await response.text();
    const problem = JSON.parse(text) as { requestId: string; code: string };
    expect(response.status).toBe(500);
    expect(problem.code).toBe("internal");
    expect(problem.requestId).toBe(response.headers.get("x-request-id"));
    expect(problem.requestId).not.toBe("mine");
    expect(response.headers.get("content-length")).not.toBe(String(rejected.length));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
