import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import {
  CreateInstanceWorkspaceRequestSchema,
  INSTANCE_DISPLAY_NAME_MAX_LENGTH,
  INSTANCE_SIGN_IN_NOTICE_MAX_LENGTH,
  InstanceAccountSchema,
  InstanceSettingsSchema,
  InstanceStatusSchema,
  UpdateInstanceAccountRequestSchema,
  InstanceWorkspaceCreatedSchema,
  InstanceWorkspaceSchema,
  UpdateInstanceSettingsRequestSchema,
  createInstanceWorkspace,
  deleteInstanceWorkspace,
  getInstanceSettings,
  getInstanceStatus,
  listInstanceAccounts,
  listInstanceWorkspaces,
  sendInstanceTestMail,
  updateInstanceAccount,
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

describe("the instance workspace operations", () => {
  const problemOnly = (operation: Obj | undefined, statuses: readonly string[]): void => {
    const responses = operation?.["responses"] as Record<string, Obj>;
    for (const status of statuses) {
      expect(Object.keys(responses[status]?.["content"] as Obj), status).toEqual(["application/problem+json"]);
    }
  };

  it("list with the read bucket, create with the write bucket, and delete with the write bucket and re-authentication, all for the instance admin", () => {
    const list = paths["/api/v1/instance/workspaces"]?.["get"];
    const create = paths["/api/v1/instance/workspaces"]?.["post"];
    const remove = paths["/api/v1/instance/workspaces/{id}"]?.["delete"];
    expect([listInstanceWorkspaces.operationId, createInstanceWorkspace.operationId, deleteInstanceWorkspace.operationId]).toEqual([
      "listInstanceWorkspaces",
      "createInstanceWorkspace",
      "deleteInstanceWorkspace",
    ]);
    expect([list?.["x-slugbase-auth"], create?.["x-slugbase-auth"], remove?.["x-slugbase-auth"]]).toEqual(["instanceAdmin", "instanceAdmin", "instanceAdmin"]);
    expect([list?.["x-slugbase-rate"], create?.["x-slugbase-rate"], remove?.["x-slugbase-rate"]]).toEqual(["read", "write", "write"]);
    expect([list?.["x-slugbase-reauth"], create?.["x-slugbase-reauth"], remove?.["x-slugbase-reauth"]]).toEqual([undefined, undefined, true]);
    problemOnly(list, ["400", "401", "403", "429", "503"]);
    problemOnly(create, ["400", "401", "403", "422", "429", "503"]);
    problemOnly(remove, ["400", "401", "403", "404", "409", "429", "503"]);
  });

  it("answers the deletion with 202 and no body, and the creation with 201", () => {
    const remove = (paths["/api/v1/instance/workspaces/{id}"]?.["delete"]?.["responses"] ?? {}) as Record<string, Obj>;
    expect(remove["202"]?.["content"]).toBeUndefined();
    const create = (paths["/api/v1/instance/workspaces"]?.["post"]?.["responses"] ?? {}) as Record<string, Obj>;
    expect(Object.keys(create["201"]?.["content"] as Obj)).toEqual(["application/json"]);
  });

  it("takes an owner account or an owner address, and never both or neither", () => {
    const parse = (body: unknown) => CreateInstanceWorkspaceRequestSchema.safeParse(body);
    const account = "0192f3a0-bbbb-7000-8000-0000000000aa";
    expect(parse({ name: "Acme", ownerAccountId: account }).success).toBe(true);
    expect(parse({ name: "Acme", ownerEmail: "owner@example.test" }).success).toBe(true);
    expect(parse({ name: "Acme" }).success).toBe(false);
    expect(parse({ name: "Acme", ownerAccountId: account, ownerEmail: "owner@example.test" }).success).toBe(false);
    expect(parse({ name: "Acme", ownerAccountId: "not-a-uuid" }).success).toBe(false);
    expect(parse({ name: "Acme", ownerEmail: "not an address" }).success).toBe(false);
    expect(parse({ name: "Acme", ownerAccountId: account, role: "owner" }).success).toBe(false);
  });

  it("holds the name to the rule of every workspace: trimmed, 1 to 64 characters", () => {
    const parse = (body: unknown) => CreateInstanceWorkspaceRequestSchema.safeParse(body);
    const account = "0192f3a0-bbbb-7000-8000-0000000000aa";
    expect(parse({ name: "n".repeat(64), ownerAccountId: account }).success).toBe(true);
    expect(parse({ name: "n".repeat(65), ownerAccountId: account }).success).toBe(false);
    expect(parse({ name: "   ", ownerAccountId: account }).success).toBe(false);
    const parsed = parse({ name: "  Acme  ", ownerAccountId: account });
    expect(parsed.success && parsed.data.name).toBe("Acme");
  });

  it("describes a closed listing that has a place for no content, and a closed creation answer", () => {
    const workspace = {
      id: "0192f3a0-bbbb-7000-8000-0000000000bb",
      name: "Acme",
      owners: [{ accountId: "0192f3a0-bbbb-7000-8000-0000000000aa", displayName: "Olivia", email: "olivia@example.test" }],
      memberCount: 3,
      createdAt: "2026-10-20T10:00:00.000Z",
    };
    expect(InstanceWorkspaceSchema.safeParse(workspace).success).toBe(true);
    expect(InstanceWorkspaceSchema.safeParse({ ...workspace, owners: [] , memberCount: 0 }).success).toBe(true);
    expect(InstanceWorkspaceSchema.safeParse({ ...workspace, bookmarkCount: 12 }).success).toBe(false);
    expect(InstanceWorkspaceSchema.safeParse({ ...workspace, owners: [{ ...workspace.owners[0], passwordHash: "x" }] }).success).toBe(false);
    const created = { id: workspace.id, name: "Acme", ownerInvitation: null };
    expect(InstanceWorkspaceCreatedSchema.safeParse(created).success).toBe(true);
    expect(
      InstanceWorkspaceCreatedSchema.safeParse({
        ...created,
        ownerInvitation: { id: workspace.id, email: "owner@example.test", expiresAt: "2026-10-27T10:00:00.000Z", link: "https://bookmarks.example.com/invite/abc" },
      }).success,
    ).toBe(true);
    expect(InstanceWorkspaceCreatedSchema.safeParse({ ...created, token: "abc" }).success).toBe(false);
  });
});

describe("the instance account operations", () => {
  const problemOnly = (operation: Obj | undefined, statuses: readonly string[]): void => {
    const responses = operation?.["responses"] as Record<string, Obj>;
    for (const status of statuses) {
      expect(Object.keys(responses[status]?.["content"] as Obj), status).toEqual(["application/problem+json"]);
    }
  };

  it("list with the read bucket and change with the write bucket and re-authentication, both for the instance admin", () => {
    const list = paths["/api/v1/instance/accounts"]?.["get"];
    const change = paths["/api/v1/instance/accounts/{id}"]?.["patch"];
    expect([listInstanceAccounts.operationId, updateInstanceAccount.operationId]).toEqual(["listInstanceAccounts", "updateInstanceAccount"]);
    expect([list?.["x-slugbase-auth"], change?.["x-slugbase-auth"]]).toEqual(["instanceAdmin", "instanceAdmin"]);
    expect([list?.["x-slugbase-rate"], change?.["x-slugbase-rate"]]).toEqual(["read", "write"]);
    expect([list?.["x-slugbase-reauth"], change?.["x-slugbase-reauth"]]).toEqual([undefined, true]);
    problemOnly(list, ["400", "401", "403", "429", "503"]);
    problemOnly(change, ["400", "401", "403", "404", "422", "429", "503"]);
  });

  it("takes the flag, the disabled state or both, and nothing else", () => {
    const parse = (body: unknown) => UpdateInstanceAccountRequestSchema.safeParse(body);
    expect(parse({ isInstanceAdmin: true }).success).toBe(true);
    expect(parse({ disabled: false }).success).toBe(true);
    expect(parse({ isInstanceAdmin: false, disabled: true }).success).toBe(true);
    expect(parse({}).success).toBe(false);
    expect(parse({ isInstanceAdmin: "yes" }).success).toBe(false);
    expect(parse({ disabled: true, emailVerified: true }).success).toBe(false);
    expect(parse({ disabled: true, passwordHash: "x" }).success).toBe(false);
  });

  it("describes a closed account that has a place for no hash, secret or content", () => {
    const listed = {
      id: "0192f3a0-bbbb-7000-8000-0000000000aa",
      displayName: "Ada",
      email: "ada@example.test",
      emailVerified: true,
      mfaEnabled: false,
      isInstanceAdmin: false,
      disabled: false,
      lastSignInAt: null,
      workspaceCount: 2,
    };
    expect(InstanceAccountSchema.safeParse(listed).success).toBe(true);
    expect(InstanceAccountSchema.safeParse({ ...listed, lastSignInAt: "2026-10-20T10:00:00.000Z" }).success).toBe(true);
    expect(InstanceAccountSchema.safeParse({ ...listed, passwordHash: "x" }).success).toBe(false);
    expect(InstanceAccountSchema.safeParse({ ...listed, mfaSecret: "x" }).success).toBe(false);
    expect(InstanceAccountSchema.safeParse({ ...listed, bookmarkCount: 3 }).success).toBe(false);
  });
});
