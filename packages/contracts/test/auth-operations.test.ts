import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { LoginRequestSchema, LoginResultSchema, VerifyMfaRequestSchema, VerifyMfaResultSchema, login, logout, verifyMfa } from "../src/operations/auth.ts";
import { operations } from "../src/operations/index.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const paths = document["paths"] as Record<string, Record<string, Obj>>;
const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;

function responsesOf(operation: Obj | undefined): Record<string, { content?: Obj; headers?: Obj }> {
  return operation?.["responses"] as Record<string, { content?: Obj; headers?: Obj }>;
}

describe("login", () => {
  const operation = paths["/api/v1/auth/login"]?.["post"];

  it("is anonymous in the login bucket and is not token-callable", () => {
    expect(login.path).toBe("/api/v1/auth/login");
    expect(operation?.["operationId"]).toBe("login");
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("login");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
  });

  it("takes a closed body of email, password and remember", () => {
    expect(operation?.["requestBody"]).toMatchObject({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
    });
    const body = schemas["LoginRequest"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties).sort()).toEqual(["email", "password", "remember"]);
    expect([...body.required].sort()).toEqual(["email", "password"]);
    expect(LoginRequestSchema.safeParse({ email: "a@example.test", password: "x", remember: true, extra: 1 }).success).toBe(false);
    expect(LoginRequestSchema.parse({ email: "a@example.test", password: "x" }).remember).toBe(false);
    expect(LoginRequestSchema.safeParse({ email: "a@example.test", password: "x".repeat(257) }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ email: "a@example.test", password: "" }).success).toBe(false);
  });

  it("answers 200 { next: 'done' | 'mfa' } with a Set-Cookie header, and problem+json for every client error", () => {
    const responses = responsesOf(operation);
    expect(responses["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/LoginResult" } } });
    expect(responses["200"]?.headers).toMatchObject({ "Set-Cookie": { required: true } });
    expect(LoginResultSchema.parse({ next: "done" })).toEqual({ next: "done" });
    expect(LoginResultSchema.parse({ next: "mfa" })).toEqual({ next: "mfa" });
    expect(LoginResultSchema.safeParse({ next: "later" }).success).toBe(false);
    for (const status of ["400", "401", "403", "422", "429"]) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
  });
});

describe("verifyMfa", () => {
  const operation = paths["/api/v1/auth/mfa/verify"]?.["post"];

  it("admits a partial session, sits in the mfa bucket and is not token-callable", () => {
    expect(verifyMfa.path).toBe("/api/v1/auth/mfa/verify");
    expect(operation?.["operationId"]).toBe("verifyMfa");
    expect(operation?.["x-slugbase-auth"]).toBe("partial");
    expect(operation?.["x-slugbase-rate"]).toBe("mfa");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
  });

  it("takes a code or a backup code, never both and nothing else", () => {
    expect(operation?.["requestBody"]).toMatchObject({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/VerifyMfaRequest" } } },
    });
    expect(VerifyMfaRequestSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(VerifyMfaRequestSchema.safeParse({ backupCode: "ABCDE23456" }).success).toBe(true);
    expect(VerifyMfaRequestSchema.safeParse({}).success).toBe(false);
    expect(VerifyMfaRequestSchema.safeParse({ code: "123456", backupCode: "ABCDE23456" }).success).toBe(false);
    expect(VerifyMfaRequestSchema.safeParse({ code: "123456", extra: 1 }).success).toBe(false);
    expect(VerifyMfaRequestSchema.safeParse({ code: "" }).success).toBe(false);
    expect(VerifyMfaRequestSchema.safeParse({ code: "1".repeat(17) }).success).toBe(false);
    expect(VerifyMfaRequestSchema.safeParse({ backupCode: "A".repeat(33) }).success).toBe(false);
  });

  it("answers 200 { next: 'done' } with a Set-Cookie header, and problem+json for every client error", () => {
    const responses = responsesOf(operation);
    expect(responses["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/VerifyMfaResult" } } });
    expect(responses["200"]?.headers).toMatchObject({ "Set-Cookie": { required: true } });
    expect(VerifyMfaResultSchema.parse({ next: "done" })).toEqual({ next: "done" });
    expect(VerifyMfaResultSchema.safeParse({ next: "mfa" }).success).toBe(false);
    for (const status of ["400", "401", "403", "422", "429"]) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
  });
});

describe("logout", () => {
  const operation = paths["/api/v1/auth/logout"]?.["post"];

  it("admits a partial session, is rate limited like any mutation and is not token-callable", () => {
    expect(logout.path).toBe("/api/v1/auth/logout");
    expect(operation?.["operationId"]).toBe("logout");
    expect(operation?.["x-slugbase-auth"]).toBe("partial");
    expect(operation?.["x-slugbase-rate"]).toBe("write");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["requestBody"]).toBeUndefined();
  });

  it("answers 204 without a body and 401 when there is no session", () => {
    const responses = responsesOf(operation);
    expect(responses["204"]).toEqual({ description: "The session is deleted and its cookie cleared" });
    expect(Object.keys(responses["401"]?.content ?? {})).toEqual(["application/problem+json"]);
  });
});
