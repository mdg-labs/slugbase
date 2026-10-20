import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { InstanceStatusSchema, getInstanceStatus } from "../src/operations/instance.ts";
import { operations } from "../src/operations/index.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const paths = document["paths"] as Record<string, Record<string, Obj>>;

describe("the operations under /api/v1/instance", () => {
  it("all declare the instanceAdmin policy and no token scope, so no API token can call one", () => {
    const instance = Object.entries(paths).filter(([path]) => path === "/api/v1/instance" || path.startsWith("/api/v1/instance/"));
    expect(instance.length).toBeGreaterThan(0);
    for (const [path, item] of instance) {
      for (const [method, operation] of Object.entries(item)) {
        expect(operation["x-slugbase-auth"], `${method.toUpperCase()} ${path}`).toBe("instanceAdmin");
        expect(operation["x-slugbase-scope"], `${method.toUpperCase()} ${path}`).toBeUndefined();
      }
    }
  });

  it("are the only operations that declare the instanceAdmin policy", () => {
    const declared = Object.entries(paths).flatMap(([path, item]) =>
      Object.values(item)
        .filter((operation) => operation["x-slugbase-auth"] === "instanceAdmin")
        .map(() => path),
    );
    expect(declared.every((path) => path.startsWith("/api/v1/instance/"))).toBe(true);
  });
});

describe("getInstanceStatus", () => {
  const operation = paths["/api/v1/instance/status"]?.["get"];

  it("is a read of the instance admin, in the read bucket, with problem+json refusals", () => {
    expect(getInstanceStatus.operationId).toBe("getInstanceStatus");
    expect(operation?.["operationId"]).toBe("getInstanceStatus");
    expect(operation?.["x-slugbase-auth"]).toBe("instanceAdmin");
    expect(operation?.["x-slugbase-rate"]).toBe("read");
    const responses = operation?.["responses"] as Record<string, Obj>;
    for (const status of ["400", "401", "403", "429", "503"]) {
      expect(Object.keys(responses[status]?.["content"] as Obj), status).toEqual(["application/problem+json"]);
    }
  });

  it("describes a closed status document that has a place for no credential", () => {
    const status = {
      version: "1.4.2",
      migrations: { expected: 54, applied: 54 },
      ports: { mail: true, ai: false, errorReporting: false },
      oidcProviders: [{ slug: "idp", name: "Example IdP" }],
      signIn: { publicRegistration: false, emailVerificationRequired: false },
      counts: { accounts: 3, workspaces: 2, activeSessions: 4 },
      jobs: { queueDepth: 0, failed: 0 },
    };
    expect(InstanceStatusSchema.safeParse(status).success).toBe(true);
    expect(InstanceStatusSchema.safeParse({ ...status, databaseUrl: "postgres://user:pass@db/slugbase" }).success).toBe(false);
    expect(InstanceStatusSchema.safeParse({ ...status, oidcProviders: [{ slug: "idp", name: "Example IdP", clientSecret: "x" }] }).success).toBe(false);
    expect(InstanceStatusSchema.safeParse({ ...status, ports: { ...status.ports, smtp: "smtp://u:p@host" } }).success).toBe(false);
  });
});
