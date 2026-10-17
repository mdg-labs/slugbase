import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import {
  LoginRequestSchema,
  LoginResultSchema,
  OidcProviderParamsSchema,
  OidcStartQuerySchema,
  RegisterRequestSchema,
  VerifyMfaRequestSchema,
  VerifyMfaResultSchema,
  completeOidcSignIn,
  login,
  logout,
  register,
  startOidcSignIn,
  verifyMfa,
} from "../src/operations/auth.ts";
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

describe("register", () => {
  const operation = paths["/api/v1/auth/register"]?.["post"];

  it("is anonymous in the register bucket and is not token-callable", () => {
    expect(register.path).toBe("/api/v1/auth/register");
    expect(operation?.["operationId"]).toBe("register");
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("register");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
  });

  it("takes a closed body of displayName, email and password, all required", () => {
    expect(operation?.["requestBody"]).toMatchObject({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } },
    });
    const body = schemas["RegisterRequest"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties).sort()).toEqual(["displayName", "email", "password"]);
    expect([...body.required].sort()).toEqual(["displayName", "email", "password"]);
    const valid = { displayName: "Ada", email: "ada@example.test", password: "a long enough password" };
    expect(RegisterRequestSchema.parse({ ...valid, displayName: "  Ada  " }).displayName).toBe("Ada");
    expect(RegisterRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...valid, displayName: "   " }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...valid, email: "not an address" }).success).toBe(false);
  });

  it("answers 202 with no body, and problem+json for every client error and the 503", () => {
    const responses = responsesOf(operation);
    expect(responses["202"]?.content).toBeUndefined();
    for (const status of ["400", "403", "422", "429", "503"]) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
    expect(responses["429"]?.headers).toMatchObject({ "Retry-After": { required: true } });
    expect(Object.keys(responses).sort()).toEqual(["202", "400", "403", "422", "429", "503"]);
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

describe("the OIDC sign-in redirects", () => {
  const start = paths["/api/v1/auth/oidc/{provider}/start"]?.["get"];
  const callback = paths["/api/v1/auth/oidc/{provider}/callback"]?.["get"];

  it("are anonymous GETs in the login bucket and are not token-callable", () => {
    expect(startOidcSignIn.path).toBe("/api/v1/auth/oidc/{provider}/start");
    expect(completeOidcSignIn.path).toBe("/api/v1/auth/oidc/{provider}/callback");
    for (const operation of [start, callback]) {
      expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
      expect(operation?.["x-slugbase-rate"]).toBe("login");
      expect(operation?.["x-slugbase-scope"]).toBeUndefined();
      expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
      expect(operation?.["requestBody"]).toBeUndefined();
    }
    expect(start?.["operationId"]).toBe("startOidcSignIn");
    expect(callback?.["operationId"]).toBe("completeOidcSignIn");
  });

  it("take the provider slug in the path, the start also an optional returnTo and an intent, and the callback no declared query", () => {
    const parameters = (operation: Obj | undefined): Obj[] => operation?.["parameters"] as Obj[];
    expect(parameters(start).map((parameter) => [parameter["in"], parameter["name"], parameter["required"]])).toEqual([
      ["path", "provider", true],
      ["query", "returnTo", false],
      ["query", "intent", false],
    ]);
    expect(parameters(callback).map((parameter) => [parameter["in"], parameter["name"]])).toEqual([["path", "provider"]]);
    expect(OidcProviderParamsSchema.safeParse({ provider: "my-idp2" }).success).toBe(true);
    for (const provider of ["", "My-Idp", "a_b", "-a", "a-", "a--b", "a/b", "x".repeat(65)]) {
      expect(OidcProviderParamsSchema.safeParse({ provider }).success, provider).toBe(false);
    }
    expect(OidcStartQuerySchema.safeParse({}).success).toBe(true);
    expect(OidcStartQuerySchema.parse({}).intent).toBe("login");
    for (const intent of ["login", "link", "reauth"]) {
      expect(OidcStartQuerySchema.safeParse({ returnTo: "/go/docs", intent }).success, intent).toBe(true);
    }
    // The invitation intent arrives with its own operation.
    for (const intent of ["invite", "delete", ""]) {
      expect(OidcStartQuerySchema.safeParse({ intent }).success, intent).toBe(false);
    }
    expect(OidcStartQuerySchema.safeParse({ returnTo: "/go/docs", unknown: "x" }).success).toBe(false);
    expect(OidcStartQuerySchema.safeParse({ returnTo: "x".repeat(2049) }).success).toBe(false);
  });

  it("answer 302 with a Location and a Set-Cookie header and no body, and problem+json for every client error", () => {
    for (const operation of [start, callback]) {
      const responses = responsesOf(operation);
      expect(responses["302"]?.content).toBeUndefined();
      expect(responses["302"]?.headers).toMatchObject({ Location: { required: true }, "Set-Cookie": { required: true } });
      expect(Object.keys(responses).filter((status) => Number(status) < 400)).toEqual(["302"]);
      for (const status of ["400", "422", "429"]) {
        expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
      }
      expect(responses["429"]?.headers).toMatchObject({ "Retry-After": { required: true } });
    }
  });
});
