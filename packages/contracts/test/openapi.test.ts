import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApiDocument, OperationDeclarationError, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import {
  defineOperation,
  emptyResponse,
  jsonResponse,
  problemResponse,
  rateLimitedResponse,
  type OperationDefinition,
} from "../src/operations/define.ts";
import { operations } from "../src/operations/index.ts";
import { omit } from "./omit.ts";

type Obj = Record<string, unknown>;

const committed = readFileSync(new URL("../generated/openapi.json", import.meta.url), "utf8");

function problemsOf(input: readonly unknown[]): readonly string[] {
  try {
    buildOpenApiDocument(input);
  } catch (error) {
    if (error instanceof OperationDeclarationError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("expected the generator to refuse the declaration");
}

const Pong = z.strictObject({ ok: z.boolean() }).meta({ id: "PongForOpenApiTest" });

const base: OperationDefinition = {
  method: "post",
  path: "/api/v1/things",
  operationId: "createThing",
  tag: "things",
  auth: "member",
  rate: "write",
  responses: { 201: jsonResponse("created", Pong), 422: problemResponse("invalid") },
};

describe("generated document", () => {
  const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
  const paths = document["paths"] as Record<string, Record<string, Obj>>;

  it("is OpenAPI 3.1", () => {
    expect(document["openapi"]).toBe("3.1.0");
  });

  it("declares the three probes, all anonymous and unlimited", () => {
    const probes: [string, string, string][] = [
      ["/health", "getHealth", "get"],
      ["/ready", "getReady", "get"],
      ["/version", "getVersion", "get"],
    ];
    for (const [path, operationId, method] of probes) {
      const operation = paths[path]?.[method];
      expect(operation?.["operationId"]).toBe(operationId);
      expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
      expect(operation?.["x-slugbase-rate"]).toBe("none");
    }
  });

  it("answers /ready with 200 or 503", () => {
    const responses = paths["/ready"]?.["get"]?.["responses"] as Obj;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(["200", "503"]));
  });

  it("gives every operation a 4xx application/problem+json response", () => {
    for (const methods of Object.values(paths)) {
      for (const operation of Object.values(methods)) {
        const responses = operation["responses"] as Record<string, { content?: Obj }>;
        const problem = Object.entries(responses).filter(
          ([status, response]) => status.startsWith("4") && response.content?.["application/problem+json"] !== undefined,
        );
        expect(problem.length).toBeGreaterThan(0);
      }
    }
  });

  it("declares Retry-After as a required positive integer on every 429, and on no other problem response", () => {
    let limited = 0;
    for (const methods of Object.values(paths)) {
      for (const operation of Object.values(methods)) {
        const responses = operation["responses"] as Record<string, { headers?: Record<string, Obj> }>;
        for (const [status, response] of Object.entries(responses)) {
          if (status === "429") {
            limited += 1;
            expect(response.headers?.["Retry-After"], String(operation["operationId"])).toMatchObject({
              required: true,
              schema: { type: "integer", minimum: 1 },
            });
          } else if (status.startsWith("4")) {
            expect(response.headers, `${String(operation["operationId"])} ${status}`).toBeUndefined();
          }
        }
      }
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("limits the version response to name, version, commit and builtAt", () => {
    const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;
    const version = schemas["VersionInfo"] as { properties: Obj; required: string[]; additionalProperties: unknown };
    expect(Object.keys(version.properties).sort()).toEqual(["builtAt", "commit", "name", "version"]);
    expect([...version.required].sort()).toEqual(["builtAt", "commit", "name", "version"]);
    expect(version.additionalProperties).toBe(false);
  });

  it("is deterministic and has sorted keys", () => {
    const first = serializeOpenApiDocument(buildOpenApiDocument(operations));
    const second = serializeOpenApiDocument(buildOpenApiDocument([...operations].reverse()));
    expect(second).toBe(first);
    const sorted = (value: unknown): boolean =>
      Array.isArray(value)
        ? value.every(sorted)
        : typeof value === "object" && value !== null
          ? Object.keys(value).join() === Object.keys(value).sort().join() &&
            Object.values(value).every(sorted)
          : true;
    expect(sorted(JSON.parse(first))).toBe(true);
  });

  it("matches the committed generated/openapi.json", () => {
    expect(serializeOpenApiDocument(buildOpenApiDocument(operations))).toBe(committed);
  });

  it("publishes the policy extensions, scope, entitlement and audience of an operation", () => {
    const op: OperationDefinition = {
      ...base,
      scope: "write",
      entitlement: "sharing.teams",
      audience: "marketing-form",
    };
    const built = buildOpenApiDocument([op]);
    const entry = (built["paths"] as Record<string, Record<string, Obj>>)["/api/v1/things"]?.["post"];
    expect(entry).toMatchObject({
      "x-slugbase-auth": "member",
      "x-slugbase-rate": "write",
      "x-slugbase-scope": "write",
      "x-slugbase-entitlement": "sharing.teams",
      "x-slugbase-audience": "marketing-form",
    });
  });
});

describe("declaration checks", () => {
  it("publishes a re-authentication requirement as x-slugbase-reauth and leaves it out when absent or false", () => {
    const entryOf = (op: OperationDefinition): Obj | undefined =>
      (buildOpenApiDocument([op])["paths"] as Record<string, Record<string, Obj>>)["/api/v1/things"]?.["post"];
    expect(entryOf({ ...base, reauth: true })?.["x-slugbase-reauth"]).toBe(true);
    expect(entryOf({ ...base, reauth: false })).not.toHaveProperty("x-slugbase-reauth");
    expect(entryOf(base)).not.toHaveProperty("x-slugbase-reauth");
  });

  it("refuses a reauth that is not a boolean", () => {
    for (const value of ["yes", 1, null]) {
      expect(problemsOf([{ ...base, reauth: value }]).join("\n")).toContain("x-slugbase-reauth (reauth) must be a boolean");
    }
  });

  it("accepts a positive integer maxBodyBytes and leaves it out of the document", () => {
    const built = buildOpenApiDocument([defineOperation({ ...base, maxBodyBytes: 5 * 1024 * 1024 })]);
    expect(JSON.stringify(built)).not.toContain("5242880");
  });

  it("refuses a maxBodyBytes that is not a positive integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      const problems = problemsOf([{ ...base, maxBodyBytes: value }]);
      expect(problems.join("\n")).toContain("maxBodyBytes must be a positive integer");
    }
  });

  it("names the operation that has no policy", () => {
    const rest = omit(base, "auth", "rate");
    const problems = problemsOf([rest]);
    expect(problems).toHaveLength(2);
    expect(problems.every((message) => message.startsWith("operation createThing:"))).toBe(true);
    expect(problems.join("\n")).toContain("x-slugbase-auth");
    expect(problems.join("\n")).toContain("x-slugbase-rate");
  });

  it("rejects an unknown auth policy, bucket and scope", () => {
    const problems = problemsOf([{ ...base, auth: "everyone", rate: "fast", scope: "admin" }]);
    expect(problems).toHaveLength(3);
  });

  it("rejects an operation without a 4xx problem response", () => {
    const problems = problemsOf([{ ...base, responses: { 201: jsonResponse("created", Pong) } }]);
    expect(problems).toEqual([expect.stringContaining("operation createThing: at least one 4xx")]);
  });

  it("rejects a 429 that does not declare Retry-After, whatever its spelling", () => {
    const bare = { kind: "problem", description: "slow down" };
    const problems = problemsOf([{ ...base, responses: { 201: jsonResponse("created", Pong), 429: bare } }]);
    expect(problems.join("\n")).toContain("response 429 must declare the Retry-After header");
    const lower = { ...bare, headers: { "retry-after": { description: "wait", schema: z.number().int() } } };
    expect(() => buildOpenApiDocument([{ ...base, responses: { 201: jsonResponse("created", Pong), 429: lower } }])).not.toThrow();
  });

  it("emits the Retry-After header of a rateLimitedResponse", () => {
    const document = buildOpenApiDocument([{ ...base, responses: { 201: jsonResponse("created", Pong), 429: rateLimitedResponse("slow down") } }]);
    const responses = (document["paths"] as Record<string, Record<string, { responses: Obj }>>)["/api/v1/things"]?.["post"]?.responses;
    expect(responses?.["429"]).toMatchObject({
      content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
      headers: { "Retry-After": { required: true, schema: { type: "integer", minimum: 1 } } },
    });
  });

  it("rejects a 4xx response that is not a problem document", () => {
    const problems = problemsOf([
      { ...base, responses: { 201: jsonResponse("created", Pong), 422: emptyResponse("no body") } },
    ]);
    expect(problems.join("\n")).toContain("response 422 must be an application/problem+json response");
  });

  it("rejects duplicate operation ids and duplicate routes", () => {
    const problems = problemsOf([base, base]);
    expect(problems.join("\n")).toContain("operation createThing: operationId is declared more than once");
    expect(problems.join("\n")).toContain("POST".toLowerCase() + " /api/v1/things is declared more than once");
  });

  it("rejects path parameters that request.params does not describe", () => {
    const problems = problemsOf([{ ...base, method: "get", path: "/api/v1/things/{id}" }]);
    expect(problems.join("\n")).toContain("path parameters {id} do not match request.params");
  });

  it("names a declaration that has no operationId by its route", () => {
    const rest = omit(base, "operationId");
    expect(problemsOf([rest])[0]).toContain("POST /api/v1/things");
  });

  it("accepts a strict request body", () => {
    const body = z.strictObject({ name: z.string(), nested: z.strictObject({ n: z.number() }) });
    expect(() => buildOpenApiDocument([defineOperation({ ...base, request: { body } })])).not.toThrow();
  });

  it("rejects a request body whose object schema is not strict", () => {
    const body = z.object({ name: z.string() });
    const problems = problemsOf([defineOperation({ ...base, request: { body } })]);
    expect(problems).toEqual([expect.stringContaining("operation createThing: request body must use strict object schemas")]);
  });

  it("rejects a non-strict object nested in a named body schema", () => {
    const Inner = z.object({ n: z.number() }).meta({ id: "LooseInnerForOpenApiTest" });
    const body = z.strictObject({ inner: Inner });
    const problems = problemsOf([defineOperation({ ...base, request: { body } })]);
    expect(problems[0]).toContain("LooseInnerForOpenApiTest");
  });

  it("accepts a map body whose values are typed", () => {
    const body = z.strictObject({ labels: z.record(z.string(), z.string()) });
    expect(() => buildOpenApiDocument([defineOperation({ ...base, request: { body } })])).not.toThrow();
  });

  it("publishes a documented response header", () => {
    const Etag = z.string().describe("Entity tag");
    const op: OperationDefinition = {
      ...base,
      responses: {
        201: jsonResponse("created", Pong, { headers: { ETag: { description: "Entity tag", schema: Etag } } }),
        422: problemResponse("invalid"),
      },
    };
    const built = buildOpenApiDocument([op]);
    const entry = (built["paths"] as Record<string, Record<string, Obj>>)["/api/v1/things"]?.["post"];
    const created = (entry?.["responses"] as Record<string, Obj>)["201"];
    expect(created?.["headers"]).toEqual({
      ETag: { description: "Entity tag", required: true, schema: { type: "string", description: "Entity tag" } },
    });
  });

  it("rejects a malformed response header", () => {
    const bad = {
      ...base,
      responses: {
        201: { kind: "json", description: "created", schema: Pong, headers: { "Bad Name": { description: "x" } } },
        422: problemResponse("invalid"),
      },
    };
    const problems = problemsOf([bad]);
    expect(problems.join("\n")).toContain("response 201 header Bad Name");
  });
});
