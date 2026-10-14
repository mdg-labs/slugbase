import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer, type ServerModule } from "../../src/create-server.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";
import { buildDocument, type TestDocument } from "./build-document.ts";
import { readOperations } from "./document.ts";
import { componentResolver, validateSchema } from "./schema.ts";
import { getProbeRow, probeOperations } from "./probe-module.ts";
import { walkContract, type ContractFixtures, type PolicyHooks } from "./walker.ts";
import type { Credentials } from "./walker.ts";

// The walker and its validator, shown to fail (doc 10 T3): a handler that
// returns a field the response schema does not declare and a route that answers
// a status the contract omits fail it, against the real chain and against
// answers the chain would never let through; and each call it makes fails
// when the server does not answer as declared.

const committed = {
  components: {
    schemas: {
      Problem: {
        type: "object",
        additionalProperties: {},
        required: ["type", "title", "status", "code", "detail", "requestId"],
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          code: { type: "string" },
          detail: { type: "string" },
          requestId: { type: "string" },
        },
      },
    },
  },
};

const config = serverConfig({ NODE_ENV: "test" });
const none: Credentials = { headers: {} };

const problems = { 400: problemResponse("The request was malformed") } as const;
const getThing = defineOperation({
  method: "get",
  path: "/api/v1/thing",
  operationId: "getThing",
  tag: "test",
  auth: "anonymous",
  rate: "none",
  responses: {
    200: jsonResponse("The thing", z.strictObject({ id: z.string() }), {
      headers: { "X-Thing-Version": { description: "The version", schema: z.literal("1") } },
    }),
    ...problems,
  },
});
const thingDocument = buildDocument([getThing], committed);
const thingFixtures: ContractFixtures = { getThing: {} };
const noHooks: PolicyHooks = {
  authorized: () => none,
  withoutReauth: () => none,
  tooLowRole: () => none,
  readOnlyToken: () => none,
  withoutEntitlement: () => none,
  workspaceA: () => none,
};

function answering(respond: (request: Request) => Response): (request: Request) => Promise<Response> {
  return (request) => Promise.resolve(respond(request));
}

function walk(document: TestDocument, send: (request: Request) => Promise<Response>, fixtures: ContractFixtures, hooks: PolicyHooks = noHooks) {
  return walkContract({ document, send, origin: config.APP_ORIGIN, fixtures, hooks });
}

const thing = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response =>
  Response.json(body, { status: init.status ?? 200, headers: { "X-Thing-Version": "1", ...init.headers } });

const kinds = (report: Awaited<ReturnType<typeof walk>>): string[] => report.failures.map((failure) => failure.kind);

describe("the walker against a conforming answer", () => {
  it("passes", async () => {
    const report = await walk(thingDocument, answering(() => thing({ id: "a" })), thingFixtures);
    expect(report.failures).toEqual([]);
    expect(report.calls).toBe(1);
  });
});

describe("the walker against an answer that differs from the document", () => {
  it("fails a field the response schema does not declare", async () => {
    const report = await walk(thingDocument, answering(() => thing({ id: "a", secret: "s" })), thingFixtures);
    expect(kinds(report)).toEqual(["schema_mismatch"]);
    expect(report.failures[0]?.detail).toContain("secret: not a declared property");
  });

  it("fails a status the operation does not declare", async () => {
    const report = await walk(thingDocument, answering(() => thing({ id: "a" }, { status: 202 })), thingFixtures);
    expect(kinds(report)).toEqual(["undeclared_status", "unexpected_status"]);
  });

  it("fails a missing required field, a wrong type and a wrong content type", async () => {
    expect(kinds(await walk(thingDocument, answering(() => thing({})), thingFixtures))).toEqual(["schema_mismatch"]);
    expect(kinds(await walk(thingDocument, answering(() => thing({ id: 3 })), thingFixtures))).toEqual(["schema_mismatch"]);
    const text = answering(() => new Response('{"id":"a"}', { headers: { "content-type": "text/plain", "X-Thing-Version": "1" } }));
    expect(kinds(await walk(thingDocument, text, thingFixtures))).toEqual(["wrong_content_type"]);
  });

  it("fails a declared header that is absent or has the wrong value", async () => {
    const absent = answering(() => Response.json({ id: "a" }));
    expect(kinds(await walk(thingDocument, absent, thingFixtures))).toEqual(["missing_header"]);
    const wrong = answering(() => thing({ id: "a" }, { headers: { "X-Thing-Version": "2" } }));
    expect(kinds(await walk(thingDocument, wrong, thingFixtures))).toEqual(["header_mismatch"]);
  });

  it("fails a problem document whose status is not the response's", async () => {
    const problem = { type: "t", title: "t", status: 500, code: "internal", detail: "d", requestId: "r" };
    const report = await walk(thingDocument, answering(() => Response.json(problem, { status: 400, headers: { "content-type": "application/problem+json" } })), thingFixtures);
    expect(kinds(report)).toEqual(["problem_status_mismatch", "unexpected_status"]);
  });

  it("fails a request the server cannot answer", async () => {
    const report = await walk(thingDocument, () => Promise.reject(new Error("connection refused")), thingFixtures);
    expect(kinds(report)).toEqual(["request_failed"]);
  });
});

describe("the walker does not skip what it cannot call", () => {
  it("fails an operation without a fixture", async () => {
    const report = await walk(thingDocument, answering(() => thing({ id: "a" })), {});
    expect(kinds(report)).toEqual(["no_fixture"]);
    expect(report.calls).toBe(0);
  });

  it("fails a fixture without a value for a path parameter", async () => {
    const document = buildDocument([getProbeRow], committed);
    const report = await walk(document, answering(() => thing({})), { getProbeRow: {} });
    expect(kinds(report)).toContain("fixture_incomplete");
    expect(report.calls).toBe(0);
  });

  it("fails an operation that declares no policy, and a document without operations", async () => {
    const entry = (thingDocument.paths["/api/v1/thing"] ?? {})["get"] as Record<string, unknown>;
    const withoutPolicy = Object.fromEntries(Object.entries(entry).filter(([name]) => name !== "x-slugbase-auth"));
    const document: TestDocument = { ...thingDocument, paths: { "/api/v1/thing": { get: withoutPolicy } } };
    expect(kinds(await walk(document, answering(() => thing({ id: "a" })), thingFixtures))).toEqual(["policy_missing"]);
    expect(kinds(await walk({ paths: {} }, answering(() => thing({ id: "a" })), thingFixtures))).toEqual(["no_operations"]);
  });

  it("fails an operation that declares no success response, unless the fixture names the status", async () => {
    const refused = defineOperation({
      method: "get",
      path: "/api/v1/refused",
      operationId: "getRefused",
      tag: "test",
      auth: "anonymous",
      rate: "none",
      responses: { 200: jsonResponse("Never", z.strictObject({})), 400: problemResponse("Bad") },
    });
    const document = buildDocument([refused], committed);
    const entry = (document.paths["/api/v1/refused"] ?? {})["get"] as { responses: Record<string, unknown> };
    delete entry.responses["200"];
    expect(kinds(await walk(document, answering(() => thing({})), { getRefused: {} }))).toEqual(["no_success_response"]);
  });
});

describe("the walker against a server that does not enforce the policy", () => {
  const document = buildDocument(probeOperations, committed);
  const fixtures: ContractFixtures = {
    getProbeRow: { path: { rowId: "0192f3a0-2222-7000-8000-00000000a021" }, foreign: { path: { rowId: "0192f3a0-2222-7000-8000-00000000b021" } } },
    checkProbeRow: {
      path: { rowId: "0192f3a0-2222-7000-8000-00000000a021" },
      body: { label: "x" },
      foreign: { path: { rowId: "0192f3a0-2222-7000-8000-00000000b021" }, body: { label: "x" } },
    },
    getProbeAdminRow: { path: { rowId: "0192f3a0-2222-7000-8000-00000000a021" }, foreign: { path: { rowId: "0192f3a0-2222-7000-8000-00000000b021" } } },
    getProbeSettings: {},
    getProbeOwnership: {},
    getProbeInstance: {},
    getProbePremium: { status: 403 },
    getProbeMe: {},
  };
  const row = { id: "0192f3a0-2222-7000-8000-00000000a021", label: "l" };

  /** Answers every request with the success of its path, whoever asks. */
  const open = answering((request) => {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith("/check")) {
      return Response.json({ id: row.id, matches: true });
    }
    if (pathname.includes("probe-rows") || pathname.includes("probe-admin-rows")) {
      return Response.json(row);
    }
    if (pathname.endsWith("probe-me")) {
      return Response.json({ accountId: row.id });
    }
    if (pathname.endsWith("probe-instance") || pathname.endsWith("probe-premium")) {
      return Response.json({ ok: true });
    }
    return Response.json({ workspaceId: row.id });
  });

  it("fails every scenario that expects a refusal", async () => {
    const report = await walk(document, open, fixtures);
    const failed = new Set(report.failures.map((failure) => failure.subject.split(", ").slice(1).join(", ")));
    expect(failed).toEqual(new Set(["without credentials", "too-low role", "read-only token", "without the entitlement", "resource of workspace B", "valid request"]));
    const unexpected = (scenario: string): number =>
      report.failures.filter((failure) => failure.kind === "unexpected_status" && failure.subject.endsWith(`, ${scenario}`)).length;
    expect(unexpected("without credentials")).toBe(8);
    expect(unexpected("too-low role")).toBe(7);
    expect(unexpected("read-only token")).toBe(1);
    expect(unexpected("without the entitlement")).toBe(1);
    expect(unexpected("resource of workspace B")).toBe(3);
    // the premium operation answers 200 where its fixture expects the refusal
    expect(unexpected("valid request")).toBe(1);
  });

  it("fails an answer with the wrong problem code", async () => {
    const problem = (code: string, status: number): Response =>
      Response.json({ type: "t", title: "t", status, code, detail: "d", requestId: "r" }, { status, headers: { "content-type": "application/problem+json" } });
    const credentials: Credentials = { headers: { cookie: "slugbase_stub=session:x" } };
    const hooks: PolicyHooks = { ...noHooks, authorized: () => credentials };
    const send = (request: Request): Promise<Response> => Promise.resolve(request.headers.has("cookie") ? Response.json(row) : problem("forbidden", 401));
    const report = await walk(buildDocument([getProbeRow], committed), send, { getProbeRow: { path: fixtures.getProbeRow?.path ?? {}, foreign: fixtures.getProbeRow?.foreign ?? {} } }, hooks);
    // a 401 problem, so the status is as expected and only the code is wrong
    expect(report.failures.filter((failure) => failure.subject.endsWith(", without credentials")).map((failure) => failure.kind)).toEqual(["wrong_code"]);
  });

  it("fails a hook that gives no principal where a role is below the policy, and a tenant operation without a foreign fixture", async () => {
    const hooks: PolicyHooks = { ...noHooks, tooLowRole: () => undefined };
    const report = await walk(buildDocument([getProbeRow], committed), open, { getProbeRow: { path: fixtures.getProbeRow?.path ?? {} } }, hooks);
    expect(kinds(report)).toEqual(expect.arrayContaining(["hook_missing", "no_foreign_fixture"]));
  });
});

describe("the walker against the server's chain", () => {
  function serve(operations: Parameters<typeof buildDocument>[0], module: ServerModule["register"]) {
    const document = buildDocument(operations, committed);
    const server = createServer({
      config,
      adapters: adapters(),
      modules: [{ name: "faulty", register: module }],
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
      openApiDocument: document,
    });
    return { document, send: (request: Request) => server.fetch(request) };
  }

  it("passes a handler that answers as declared", async () => {
    const { document, send } = serve([getThing], () => ({
      routes: [{ operation: getThing, handler: () => thing({ id: "a" }) }],
    }));
    expect((await walk(document, send, thingFixtures)).failures).toEqual([]);
  });

  it("fails a handler that returns a field the response schema does not declare", async () => {
    const { document, send } = serve([getThing], () => ({
      routes: [{ operation: getThing, handler: () => thing({ id: "a", secret: "s" }) }],
    }));
    // The response stage refuses the answer, so the walker sees a 500 the document does not declare.
    expect(kinds(await walk(document, send, thingFixtures))).toEqual(["undeclared_status", "unexpected_status"]);
  });

  it("fails a route that answers a status the contract omits", async () => {
    const { document, send } = serve([getThing], () => ({
      routes: [{ operation: getThing, handler: () => thing({ id: "a" }, { status: 202 }) }],
    }));
    expect(kinds(await walk(document, send, thingFixtures))).toEqual(["undeclared_status", "unexpected_status"]);
  });
});

describe("the re-authentication policy extension", () => {
  const rotateThing = defineOperation({
    method: "post",
    path: "/api/v1/thing/rotate",
    operationId: "rotateThing",
    tag: "test",
    auth: "member",
    rate: "write",
    reauth: true,
    responses: { 200: jsonResponse("Rotated", z.strictObject({ id: z.string() })), 401: problemResponse("Not signed in") },
  });
  const plainThing = defineOperation({ ...rotateThing, operationId: "plainThing", path: "/api/v1/thing/plain", reauth: false });
  const entryOf = (document: TestDocument, operation: { path: string; method: string }): Record<string, unknown> =>
    (document.paths[operation.path] ?? {})[operation.method] as Record<string, unknown>;

  it("is written for an operation that declares it and for no other", () => {
    const document = buildDocument([rotateThing, plainThing, getThing], committed);
    expect(entryOf(document, rotateThing)["x-slugbase-reauth"]).toBe(true);
    expect("x-slugbase-reauth" in entryOf(document, plainThing)).toBe(false);
    expect("x-slugbase-reauth" in entryOf(document, getThing)).toBe(false);
  });

  it("is read onward, and a value that is not a boolean is a missing policy", () => {
    const document = buildDocument([rotateThing, plainThing], committed);
    const read = readOperations(document);
    expect(read.failures).toEqual([]);
    expect(read.operations.map((operation) => [operation.operationId, operation.reauth])).toEqual([
      ["rotateThing", true],
      ["plainThing", undefined],
    ]);
    for (const value of ["yes", 1, null, {}]) {
      const invalid: TestDocument = {
        ...document,
        paths: { [rotateThing.path]: { post: { ...entryOf(document, rotateThing), "x-slugbase-reauth": value } } },
      };
      const failures = readOperations(invalid).failures;
      expect(failures.map((failure) => failure.kind)).toEqual(["policy_missing"]);
      expect(failures[0]?.detail).toContain("x-slugbase-reauth");
    }
    const explicitFalse: TestDocument = {
      ...document,
      paths: { [rotateThing.path]: { post: { ...entryOf(document, rotateThing), "x-slugbase-reauth": false } } },
    };
    expect(readOperations(explicitFalse).failures).toEqual([]);
  });

  describe("walked", () => {
    const fresh: Credentials = { headers: { cookie: "state=fresh" } };
    const stale: Credentials = { headers: { cookie: "state=stale" } };
    const outsider: Credentials = { headers: { cookie: "state=outsider" } };
    const hooks: PolicyHooks = { ...noHooks, authorized: () => fresh, withoutReauth: () => stale, tooLowRole: () => outsider };
    const walked = defineOperation({
      ...rotateThing,
      operationId: "walkedThing",
      path: "/api/v1/thing/walked",
      responses: { ...rotateThing.responses, 404: problemResponse("No workspace") },
    });
    const document = buildDocument([walked], committed);
    const fixtures: ContractFixtures = { walkedThing: {} };

    const refusal = (status: number, code: string): Response =>
      Response.json({ type: "t", title: "t", status, code, detail: "d", requestId: "r" }, { status, headers: { "content-type": "application/problem+json" } });

    /** A server that holds to the declaration: only the "fresh" session gets through, and a stale one is asked to re-authenticate. */
    const conforming = (request: Request): Response => {
      const state = /state=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      switch (state) {
        case "fresh":
          return Response.json({ id: "a" });
        case "stale":
          return refusal(401, "reauth_required");
        case "outsider":
          return refusal(404, "not_found");
        default:
          return refusal(401, "unauthenticated");
      }
    };

    it("asks the hooks for a session without re-authentication, only for an operation that declares it, and passes a server that refuses it", async () => {
      const asked: string[] = [];
      const counting: PolicyHooks = { ...hooks, withoutReauth: (operation) => (asked.push(operation.operationId), stale) };
      const report = await walk(document, answering(conforming), fixtures, counting);
      expect(report.failures).toEqual([]);
      // the valid request, the one without credentials, the one without re-authentication and the one below the role
      expect(report.calls).toBe(4);
      expect(asked).toEqual(["walkedThing"]);

      const plain = buildDocument([plainThing], committed);
      const plainAsked: string[] = [];
      const plainReport = await walk(plain, answering(conforming), { plainThing: {} }, { ...hooks, withoutReauth: (operation) => (plainAsked.push(operation.operationId), stale) });
      expect(plainAsked).toEqual([]);
      expect(plainReport.calls).toBe(3);
    });

    it("fails a server that lets a session without re-authentication through", async () => {
      const lax = (request: Request): Response => (request.headers.get("cookie")?.includes("stale") === true ? Response.json({ id: "a" }) : conforming(request));
      const report = await walk(document, answering(lax), fixtures, hooks);
      expect(report.failures.map((failure) => [failure.subject, failure.kind])).toEqual([
        ["walkedThing (POST /api/v1/thing/walked), without re-authentication", "unexpected_status"],
        ["walkedThing (POST /api/v1/thing/walked), without re-authentication", "wrong_code"],
      ]);
    });

    it("fails a server that refuses it for another reason than the missing re-authentication", async () => {
      const wrongCode = (request: Request): Response => (request.headers.get("cookie")?.includes("stale") === true ? refusal(401, "unauthenticated") : conforming(request));
      const report = await walk(document, answering(wrongCode), fixtures, hooks);
      expect(report.failures.map((failure) => failure.kind)).toEqual(["wrong_code"]);
    });
  });

  it("registers against a document built from the operation", () => {
    expect(() =>
      createServer({
        config,
        adapters: adapters(),
        modules: [{ name: "reauth", register: () => ({ routes: [{ operation: rotateThing, handler: () => Response.json({ id: "a" }) }] }) }],
        migrations: [],
        logger: recordingLogger(),
        database: fakeDatabase(),
        openApiDocument: buildDocument([rotateThing], committed),
      }),
    ).not.toThrow();
  });
});

describe("the schema validator", () => {
  const resolve = componentResolver({ components: { schemas: { Name: { type: "string", minLength: 1 } } } });
  const issues = (schema: unknown, value: unknown): string[] => validateSchema(schema, value, resolve).map((issue) => `${issue.path}: ${issue.message}`);

  it("reads the keywords the generated document uses", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["id", "tags"],
      properties: {
        id: { type: "string", format: "uuid" },
        tags: { type: "array", items: { $ref: "#/components/schemas/Name" }, minItems: 1 },
        at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
        kind: { const: "a" },
      },
    };
    expect(issues(schema, { id: "0192f3a0-2222-7000-8000-00000000a021", tags: ["x"], at: null, kind: "a" })).toEqual([]);
    expect(issues(schema, { id: "no", tags: [""], at: "yesterday", kind: "b", extra: 1 })).toEqual([
      "id: not a valid uuid",
      "tags[0]: shorter than 1 characters",
      "at: matches none of the alternatives",
      "kind: expected the constant \"a\"",
      "extra: not a declared property",
    ]);
  });

  it("refuses to read what it does not understand", () => {
    expect(issues({ type: "string", propertyNames: {} }, "a")).toEqual([": the schema uses the keyword \"propertyNames\", which the validator does not read"]);
    expect(issues({ type: "string", format: "hostname" }, "a")).toEqual([": the format \"hostname\" is not one the validator reads"]);
    expect(issues({ $ref: "#/components/schemas/Missing" }, "a")).toEqual([": the reference #/components/schemas/Missing does not resolve"]);
  });

  it("does not take an inherited name for a declared one", () => {
    expect(issues({ type: "object", required: ["constructor"] }, {})).toEqual(["constructor: required but absent"]);
  });
});
