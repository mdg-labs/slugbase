import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import {
  INSTANCE_DISPLAY_NAME_MAX_LENGTH,
  INSTANCE_SIGN_IN_NOTICE_MAX_LENGTH,
  InstanceSettingsSchema,
  InstanceStatusSchema,
  UpdateInstanceSettingsRequestSchema,
  getInstanceSettings,
  getInstanceStatus,
  sendInstanceTestMail,
  updateInstanceSettings,
} from "../src/operations/instance.ts";
import { ApiConfigSchema } from "../src/operations/meta.ts";
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

describe("the instance settings operations", () => {
  const problemOnly = (operation: Obj | undefined, statuses: readonly string[]): void => {
    const responses = operation?.["responses"] as Record<string, Obj>;
    for (const status of statuses) {
      expect(Object.keys(responses[status]?.["content"] as Obj), status).toEqual(["application/problem+json"]);
    }
  };

  it("reads the settings with the read bucket and changes them with the write bucket, both for the instance admin", () => {
    const read = paths["/api/v1/instance/settings"]?.["get"];
    const write = paths["/api/v1/instance/settings"]?.["patch"];
    expect(getInstanceSettings.operationId).toBe("getInstanceSettings");
    expect(updateInstanceSettings.operationId).toBe("updateInstanceSettings");
    expect(read?.["x-slugbase-auth"]).toBe("instanceAdmin");
    expect(read?.["x-slugbase-rate"]).toBe("read");
    expect(write?.["x-slugbase-auth"]).toBe("instanceAdmin");
    expect(write?.["x-slugbase-rate"]).toBe("write");
    problemOnly(read, ["400", "401", "403", "429", "503"]);
    problemOnly(write, ["400", "401", "403", "422", "429", "503"]);
  });

  it("answers the test email with 202, or 503 and the problem document when no mail adapter is configured", () => {
    const operation = paths["/api/v1/instance/mail/test"]?.["post"];
    expect(sendInstanceTestMail.operationId).toBe("sendInstanceTestMail");
    expect(operation?.["x-slugbase-auth"]).toBe("instanceAdmin");
    expect(operation?.["x-slugbase-rate"]).toBe("write");
    const responses = operation?.["responses"] as Record<string, Obj>;
    expect(responses["202"]?.["content"]).toBeUndefined();
    problemOnly(operation, ["400", "401", "403", "429", "503"]);
  });

  it("stores a setting as a value or as null, and refuses a request that names no setting or names one the operation does not declare", () => {
    const parse = (body: unknown) => UpdateInstanceSettingsRequestSchema.safeParse(body);
    expect(parse({ allowWorkspaceCreation: true }).success).toBe(true);
    expect(parse({ allowWorkspaceCreation: null, displayName: null, signInNotice: null }).success).toBe(true);
    expect(parse({}).success).toBe(false);
    expect(parse({ displayName: undefined }).success).toBe(false);
    expect(parse({ allowWorkspaceCreation: "yes" }).success).toBe(false);
    expect(parse({ displayName: "Acme", theme: "dark" }).success).toBe(false);
  });

  it("holds the name to 1 to 100 characters and the notice to 1 to 500, after trimming, and removes the surrounding whitespace", () => {
    const parse = (body: unknown) => UpdateInstanceSettingsRequestSchema.safeParse(body);
    expect(parse({ displayName: "n".repeat(INSTANCE_DISPLAY_NAME_MAX_LENGTH) }).success).toBe(true);
    expect(parse({ displayName: "n".repeat(INSTANCE_DISPLAY_NAME_MAX_LENGTH + 1) }).success).toBe(false);
    expect(parse({ displayName: "   " }).success).toBe(false);
    expect(parse({ signInNotice: "n".repeat(INSTANCE_SIGN_IN_NOTICE_MAX_LENGTH) }).success).toBe(true);
    expect(parse({ signInNotice: "n".repeat(INSTANCE_SIGN_IN_NOTICE_MAX_LENGTH + 1) }).success).toBe(false);
    expect(parse({ signInNotice: "" }).success).toBe(false);
    const parsed = parse({ displayName: "  Acme  ", signInNotice: "\n Maintenance on Friday. \n" });
    expect(parsed.success && parsed.data).toEqual({ displayName: "Acme", signInNotice: "Maintenance on Friday." });
  });

  it.each(["displayName", "signInNotice"])("refuses a NUL character in %s, which the database cannot store", (field) => {
    const parse = (body: unknown) => UpdateInstanceSettingsRequestSchema.safeParse(body);
    const refused = parse({ [field]: "a\u0000b" });
    expect(refused.success).toBe(false);
    expect(!refused.success && refused.error.issues.map((issue) => issue.path)).toEqual([[field]]);
    expect(parse({ [field]: "\u0000" }).success).toBe(false);
    expect(parse({ [field]: "ab" }).success).toBe(true);
  });

  it("describes a closed settings document", () => {
    const settings = { allowWorkspaceCreation: null, displayName: "Acme", signInNotice: null };
    expect(InstanceSettingsSchema.safeParse(settings).success).toBe(true);
    expect(InstanceSettingsSchema.safeParse({ ...settings, updatedBy: "x" }).success).toBe(false);
    expect(InstanceSettingsSchema.safeParse({ displayName: "Acme" }).success).toBe(false);
  });
});

describe("the instance fields of GET /api/config", () => {
  const config = {
    apiVersion: "v1",
    origin: "https://bookmarks.example.com",
    product: { name: "SlugBase", version: "1.0.0" },
    locales: ["en", "de"],
    defaultLocale: "en",
    docsBaseUrl: "https://slugbase.app/docs",
    features: { mail: false, ai: false },
  };

  it("carry the display name as text and the notice as text or null, and nothing else", () => {
    expect(ApiConfigSchema.safeParse({ ...config, instance: { displayName: "Acme", signInNotice: "<b>Hello</b>" } }).success).toBe(true);
    expect(ApiConfigSchema.safeParse({ ...config, instance: { displayName: "SlugBase", signInNotice: null } }).success).toBe(true);
    expect(ApiConfigSchema.safeParse({ ...config, instance: { displayName: null, signInNotice: null } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, instance: { displayName: "Acme" } }).success).toBe(false);
    expect(ApiConfigSchema.safeParse({ ...config, instance: { displayName: "Acme", signInNotice: null, allowWorkspaceCreation: true } }).success).toBe(false);
  });
});
