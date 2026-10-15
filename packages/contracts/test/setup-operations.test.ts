import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { operations } from "../src/operations/index.ts";
import { SetupRequestSchema, SetupResultSchema, SetupStatusSchema, completeSetup, getSetupStatus } from "../src/operations/setup.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const paths = document["paths"] as Record<string, Record<string, Obj>>;
const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;

function responsesOf(operation: Obj | undefined): Record<string, { content?: Obj; headers?: Obj }> {
  return operation?.["responses"] as Record<string, { content?: Obj; headers?: Obj }>;
}

const valid = {
  displayName: "First Admin",
  email: "admin@example.test",
  password: "a long enough password",
  workspaceName: "Home",
};

describe("getSetupStatus", () => {
  const operation = paths["/api/v1/setup/status"]?.["get"];

  it("is anonymous in the public bucket and is not token-callable", () => {
    expect(getSetupStatus.path).toBe("/api/v1/setup/status");
    expect(operation?.["operationId"]).toBe("getSetupStatus");
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("public");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
  });

  it("answers { setupRequired, setupTokenRequired } and problem+json for every client error", () => {
    const responses = responsesOf(operation);
    expect(responses["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/SetupStatus" } } });
    const answer = { setupRequired: true, setupTokenRequired: false };
    expect(SetupStatusSchema.parse(answer)).toEqual(answer);
    expect(SetupStatusSchema.safeParse({ setupRequired: true }).success).toBe(false);
    expect(SetupStatusSchema.safeParse({ ...answer, setupRequired: "yes" }).success).toBe(false);
    expect(SetupStatusSchema.safeParse({ ...answer, setupTokenRequired: "secret" }).success).toBe(false);
    expect(SetupStatusSchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
    for (const status of ["400", "429", "503"]) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
  });
});

describe("completeSetup", () => {
  const operation = paths["/api/v1/setup"]?.["post"];

  it("is anonymous in the setup bucket and is not token-callable", () => {
    expect(completeSetup.path).toBe("/api/v1/setup");
    expect(operation?.["operationId"]).toBe("completeSetup");
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("setup");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
  });

  it("takes a closed body of setupToken, displayName, email, password and workspaceName", () => {
    expect(operation?.["requestBody"]).toMatchObject({
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/SetupRequest" } } },
    });
    const body = schemas["SetupRequest"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties).sort()).toEqual(["displayName", "email", "password", "setupToken", "workspaceName"]);
    expect([...body.required].sort()).toEqual(["displayName", "email", "password", "workspaceName"]);
    expect(SetupRequestSchema.safeParse(valid).success).toBe(true);
    expect(SetupRequestSchema.safeParse({ ...valid, setupToken: "token" }).success).toBe(true);
    expect(SetupRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ ...valid, email: "not an address" }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ ...valid, displayName: "" }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ ...valid, displayName: "x".repeat(101) }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ ...valid, displayName: "   " }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ ...valid, displayName: "\u{1F600}".repeat(100) }).success).toBe(true);
    expect(SetupRequestSchema.safeParse({ ...valid, displayName: "\u{1F600}".repeat(101) }).success).toBe(false);
    expect(SetupRequestSchema.safeParse({ ...valid, displayName: ` ${"x".repeat(100)} ` }).data?.displayName).toBe("x".repeat(100));
    expect(body.properties["displayName"]).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(SetupRequestSchema.safeParse({ ...valid, workspaceName: "x".repeat(65) }).success).toBe(false);
  });

  it("leaves the password length to weak_password: a short password passes the schema", () => {
    expect(SetupRequestSchema.safeParse({ ...valid, password: "short" }).success).toBe(true);
  });

  it("answers 201 with the workspace and a Set-Cookie header, and problem+json for every client error", () => {
    const responses = responsesOf(operation);
    expect(responses["201"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/SetupResult" } } });
    expect(responses["201"]?.headers).toMatchObject({ "Set-Cookie": { required: true } });
    expect(SetupResultSchema.safeParse({ workspaceId: "0192f3a0-aaaa-7000-8000-000000000001" }).success).toBe(true);
    expect(SetupResultSchema.safeParse({ workspaceId: "not-a-uuid" }).success).toBe(false);
    for (const status of ["400", "403", "422", "429", "503"]) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
  });
});
