import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { AccountSchema, MembershipSchema, MeSchema, RevokeSessionsQuerySchema, SessionIdParamsSchema, SessionListQuerySchema, SessionListSchema, SessionSchema, UpdateAccountRequestSchema } from "../src/operations/me.ts";
import { operations } from "../src/operations/index.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const paths = document["paths"] as Record<string, Record<string, Obj>>;
const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;

function responsesOf(operation: Obj | undefined): Record<string, { content?: Obj }> {
  return operation?.["responses"] as Record<string, { content?: Obj }>;
}

describe("the session operations", () => {
  it.each([
    ["get", "/api/v1/me/sessions", "listSessions", "read"],
    ["delete", "/api/v1/me/sessions/{id}", "revokeSession", "write"],
    ["delete", "/api/v1/me/sessions", "revokeSessions", "write"],
  ])("%s %s is %s: an account operation in the %s bucket that no API token may call", (method, path, operationId, rate) => {
    const operation = paths[path]?.[method];
    expect(operation?.["operationId"]).toBe(operationId);
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe(rate);
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
    expect(operation?.["requestBody"]).toBeUndefined();
  });

  it("declares application/problem+json for every client error", () => {
    for (const [path, method] of [
      ["/api/v1/me/sessions", "get"],
      ["/api/v1/me/sessions/{id}", "delete"],
      ["/api/v1/me/sessions", "delete"],
    ] as const) {
      const responses = responsesOf(paths[path]?.[method]);
      const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
      expect(clientErrors, `${method} ${path}`).toContain("401");
      for (const status of clientErrors) {
        expect(Object.keys(responses[status]?.content ?? {}), `${method} ${path} ${status}`).toEqual(["application/problem+json"]);
      }
    }
    expect(Object.keys(responsesOf(paths["/api/v1/me/sessions/{id}"]?.["delete"]))).toContain("404");
  });

  it("answers the list as closed Session objects with no token hash and no full address field", () => {
    const session = schemas["Session"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(session.additionalProperties).toBe(false);
    expect(Object.keys(session.properties).sort()).toEqual(["createdAt", "current", "id", "ipPrefix", "lastSeenAt", "userAgentFamily"]);
    expect([...session.required].sort()).toEqual(Object.keys(session.properties).sort());
    expect(responsesOf(paths["/api/v1/me/sessions"]?.["get"])["200"]?.content).toEqual({
      "application/json": { schema: { $ref: "#/components/schemas/SessionList" } },
    });
    const valid = {
      id: "0192f3a0-0000-7000-8000-0000000000a1",
      createdAt: "2026-10-14T10:00:00.000Z",
      lastSeenAt: "2026-10-14T10:01:00.000Z",
      userAgentFamily: null,
      ipPrefix: null,
      current: true,
    };
    expect(SessionListSchema.safeParse({ items: [valid], nextCursor: null }).success).toBe(true);
    expect(SessionListSchema.safeParse({ items: [valid], nextCursor: "abc.def" }).success).toBe(true);
    expect(SessionListSchema.safeParse({ items: [valid] }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...valid, tokenHash: "x" }).success).toBe(false);
  });

  it("takes a UUID path identifier and an includeCurrent query that defaults to false", () => {
    expect(SessionIdParamsSchema.safeParse({ id: "not-an-id" }).success).toBe(false);
    expect(SessionIdParamsSchema.safeParse({ id: "0192f3a0-0000-7000-8000-0000000000a1" }).success).toBe(true);
    expect(RevokeSessionsQuerySchema.parse({}).includeCurrent).toBe("false");
    expect(RevokeSessionsQuerySchema.safeParse({ includeCurrent: "yes" }).success).toBe(false);
    expect(RevokeSessionsQuerySchema.safeParse({ includeCurrent: "true", other: "1" }).success).toBe(false);
  });

  it("pages the list with a limit of 1 to 100 that defaults to 50 and an optional cursor, as doc 04 section 6.1 says", () => {
    const parameters = paths["/api/v1/me/sessions"]?.["get"]?.["parameters"] as { name: string; in: string; required: boolean; schema: Obj }[];
    expect(parameters.map((parameter) => [parameter.name, parameter.in, parameter.required])).toEqual([
      ["limit", "query", false],
      ["cursor", "query", false],
    ]);
    expect(parameters[0]?.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(SessionListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(SessionListQuerySchema.parse({ limit: "100", cursor: "abc.def" })).toEqual({ limit: 100, cursor: "abc.def" });
    for (const bad of [{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: "many" }, { cursor: "" }, { offset: "1" }]) {
      expect(SessionListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const list = schemas["SessionList"] as { required: string[] };
    expect([...list.required].sort()).toEqual(["items", "nextCursor"]);
  });
});

describe("the account operation", () => {
  const operation = paths["/api/v1/me"]?.["get"];

  it("is getMe: an account operation in the read bucket that a read-scope API token may call", () => {
    expect(operation?.["operationId"]).toBe("getMe");
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe("read");
    expect(operation?.["x-slugbase-scope"]).toBe("read");
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
    expect(operation?.["requestBody"]).toBeUndefined();
    expect(operation?.["parameters"]).toBeUndefined();
  });

  it("declares application/problem+json for every client error, among them 401", () => {
    const responses = responsesOf(operation);
    const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
    expect(clientErrors).toContain("401");
    for (const status of clientErrors) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
    expect(responsesOf(operation)["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/Me" } } });
  });

  it("answers closed objects that carry no hash and no secret, with the DSN as the one optional field", () => {
    const me = schemas["Me"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(me.additionalProperties).toBe(false);
    expect(Object.keys(me.properties).sort()).toEqual(["account", "activeWorkspaceId", "clientErrorReportDsn", "memberships"]);
    expect([...me.required].sort()).toEqual(["account", "activeWorkspaceId", "memberships"]);
    const account = schemas["Account"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(account.additionalProperties).toBe(false);
    expect(Object.keys(account.properties).sort()).toEqual([
      "accent", "aiOptOut", "defaultView", "displayName", "email", "emailVerified", "hasPassword", "id", "locale", "theme",
    ]);
    expect([...account.required].sort()).toEqual(Object.keys(account.properties).sort());
    const membership = schemas["Membership"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(membership.additionalProperties).toBe(false);
    expect(Object.keys(membership.properties).sort()).toEqual(["name", "role", "workspaceId"]);
  });

  it("accepts the shape the server answers and refuses an extra field or a role outside the three", () => {
    const account = {
      id: "0192f3a0-0000-7000-8000-0000000000a1",
      email: "ada@example.test",
      displayName: "Ada",
      locale: "de",
      theme: "dark",
      accent: null,
      defaultView: "table",
      aiOptOut: false,
      emailVerified: true,
      hasPassword: false,
    };
    const membership = { workspaceId: "0192f3a0-0000-7000-8000-0000000000b1", name: "Notes", role: "admin" };
    expect(MeSchema.safeParse({ account, memberships: [membership], activeWorkspaceId: null }).success).toBe(true);
    expect(MeSchema.safeParse({ account, memberships: [], activeWorkspaceId: membership.workspaceId, clientErrorReportDsn: "https://k@e.example/1" }).success).toBe(true);
    expect(MeSchema.safeParse({ account, memberships: [] }).success).toBe(false);
    expect(AccountSchema.safeParse({ ...account, passwordHash: "x" }).success).toBe(false);
    expect(AccountSchema.safeParse({ ...account, locale: "fr" }).success).toBe(false);
    expect(MembershipSchema.safeParse({ ...membership, role: "guest" }).success).toBe(false);
    expect(MembershipSchema.safeParse({ ...membership, joinedAt: "2026-01-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("the profile operation", () => {
  const operation = paths["/api/v1/me"]?.["patch"];

  it("is updateMe: an account operation in the write bucket that no API token may call", () => {
    expect(operation?.["operationId"]).toBe("updateMe");
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe("write");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
    expect(operation?.["parameters"]).toBeUndefined();
    expect(operation?.["requestBody"]).toEqual({
      content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateAccountRequest" } } },
      required: true,
    });
  });

  it("answers the account and declares application/problem+json for every client error, among them 401, 403 and 422", () => {
    const responses = responsesOf(operation);
    expect(responses["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/Account" } } });
    const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
    expect(clientErrors).toEqual(expect.arrayContaining(["401", "403", "422"]));
    for (const status of clientErrors) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
  });

  it("takes a closed object of two optional fields: a name of 1 to 100 characters and a locale of en or de", () => {
    const request = schemas["UpdateAccountRequest"] as { additionalProperties: unknown; properties: Record<string, Obj>; required?: string[] };
    expect(request.additionalProperties).toBe(false);
    expect(Object.keys(request.properties).sort()).toEqual(["displayName", "locale"]);
    expect(request.required).toBeUndefined();
    expect(request.properties["displayName"]).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(request.properties["locale"]).toMatchObject({ enum: ["en", "de"] });
  });

  it.each([
    [{}, true],
    [{ displayName: "A" }, true],
    [{ displayName: "x".repeat(100), locale: "de" }, true],
    [{ displayName: "" }, false],
    [{ displayName: "x".repeat(101) }, false],
    [{ displayName: null }, false],
    [{ locale: "fr" }, false],
    [{ locale: null }, false],
    [{ email: "other@example.test" }, false],
    [{ isInstanceAdmin: true }, false],
    [{ id: "0192f3a0-0000-7000-8000-0000000000a1" }, false],
    [{ theme: "dark" }, false],
  ])("%j is accepted: %s", (body, accepted) => {
    expect(UpdateAccountRequestSchema.safeParse(body).success).toBe(accepted);
  });
});
