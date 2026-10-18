import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { ACCENT_PRESETS, AccountSchema, ApiTokenIdParamsSchema, CancelEmailChangeRequestSchema, ConfirmEmailChangeRequestSchema, RequestEmailChangeRequestSchema, cancelEmailChange, cancelPendingEmailChange, confirmEmailChange, requestEmailChange, ApiTokenListQuerySchema, ApiTokenListSchema, ApiTokenSchema, CreateApiTokenRequestSchema, CreatedApiTokenSchema, ChangePasswordRequestSchema, DisableMfaRequestSchema, IdentityIdParamsSchema, IdentityListQuerySchema, IdentityListSchema, IdentitySchema, ReauthRequestSchema, RegenerateBackupCodesRequestSchema, MembershipSchema, MeSchema, RevokeSessionsQuerySchema, SessionIdParamsSchema, SessionListQuerySchema, SessionListSchema, SessionSchema, UpdateAccountRequestSchema } from "../src/operations/me.ts";
import { operations } from "../src/operations/index.ts";

type Obj = Record<string, unknown>;

const document = JSON.parse(serializeOpenApiDocument(buildOpenApiDocument(operations))) as Obj;
const paths = document["paths"] as Record<string, Record<string, Obj>>;
const schemas = (document["components"] as { schemas: Record<string, Obj> }).schemas;

function responsesOf(operation: Obj | undefined): Record<string, { content?: Obj; headers?: Obj }> {
  return operation?.["responses"] as Record<string, { content?: Obj; headers?: Obj }>;
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
      "accent", "aiOptOut", "analyticsConsent", "defaultView", "displayName", "email", "emailVerified", "hasPassword", "id", "locale", "mfaEnabled", "onboarding", "pendingEmail", "signinAlerts", "singleKeyShortcuts", "theme",
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
      singleKeyShortcuts: true,
      signinAlerts: true,
      aiOptOut: false,
      analyticsConsent: "unset",
      onboarding: { browserSetupDone: false, importDone: true, checklistDismissed: false },
      emailVerified: true,
      hasPassword: false,
      mfaEnabled: false,
      pendingEmail: null,
    };
    const membership = { workspaceId: "0192f3a0-0000-7000-8000-0000000000b1", name: "Notes", role: "admin" };
    expect(MeSchema.safeParse({ account, memberships: [membership], activeWorkspaceId: null }).success).toBe(true);
    expect(MeSchema.safeParse({ account, memberships: [], activeWorkspaceId: membership.workspaceId, clientErrorReportDsn: "https://k@e.example/1" }).success).toBe(true);
    expect(MeSchema.safeParse({ account, memberships: [] }).success).toBe(false);
    expect(AccountSchema.safeParse({ ...account, passwordHash: "x" }).success).toBe(false);
    expect(AccountSchema.safeParse({ ...account, locale: "fr" }).success).toBe(false);
    expect(AccountSchema.safeParse({ ...account, accent: "#ff0000" }).success).toBe(false);
    expect(AccountSchema.safeParse({ ...account, accent: "teal" }).success).toBe(true);
    expect(AccountSchema.safeParse({ ...account, onboarding: { importDone: true } }).success).toBe(false);
    expect(MembershipSchema.safeParse({ ...membership, role: "guest" }).success).toBe(false);
    expect(MembershipSchema.safeParse({ ...membership, joinedAt: "2026-01-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("the profile and preferences operation", () => {
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

  it("takes a closed object of optional fields: the profile and the preferences, never the email or a flag of the account", () => {
    const request = schemas["UpdateAccountRequest"] as { additionalProperties: unknown; properties: Record<string, Obj>; required?: string[] };
    expect(request.additionalProperties).toBe(false);
    expect(Object.keys(request.properties).sort()).toEqual([
      "accent", "aiOptOut", "analyticsConsent", "defaultView", "displayName", "locale", "onboarding", "signinAlerts", "singleKeyShortcuts", "theme",
    ]);
    expect(request.required).toBeUndefined();
    expect(request.properties["displayName"]).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(request.properties["locale"]).toMatchObject({ enum: ["en", "de"] });
    expect(request.properties["theme"]).toMatchObject({ enum: ["light", "dark", "system"] });
    expect(request.properties["accent"]).toMatchObject({ enum: ["periwinkle", "violet", "rose", "amber", "green", "teal"] });
    expect(request.properties["defaultView"]).toMatchObject({ enum: ["grid", "table"] });
    expect(request.properties["analyticsConsent"]).toMatchObject({ enum: ["unset", "granted", "denied"] });
    expect(request.properties["singleKeyShortcuts"]).toMatchObject({ type: "boolean" });
    expect(request.properties["signinAlerts"]).toMatchObject({ type: "boolean" });
    expect(request.properties["aiOptOut"]).toMatchObject({ type: "boolean" });
    const onboarding = schemas["OnboardingChanges"] as { additionalProperties: unknown; properties: Obj; required?: string[] };
    expect(onboarding.additionalProperties).toBe(false);
    expect(Object.keys(onboarding.properties).sort()).toEqual(["browserSetupDone", "checklistDismissed", "importDone"]);
    expect(onboarding.required).toBeUndefined();
  });

  it("names six accent presets and no colour value", () => {
    expect(ACCENT_PRESETS).toHaveLength(6);
    for (const preset of ACCENT_PRESETS) {
      expect(preset).toMatch(/^[a-z]+$/);
    }
  });

  it.each([
    [{}, true],
    [{ displayName: "A" }, true],
    [{ displayName: "x".repeat(100), locale: "de" }, true],
    [{ displayName: "" }, false],
    [{ displayName: "x".repeat(101) }, false],
    [{ displayName: "  " + "x".repeat(100) + "  " }, true],
    [{ displayName: "  " + "x".repeat(101) + "  " }, false],
    [{ displayName: "   " }, false],
    [{ displayName: "\u{1F600}".repeat(60) }, true],
    [{ displayName: "\u{1F600}".repeat(100) }, true],
    [{ displayName: "\u{1F600}".repeat(101) }, false],
    [{ displayName: null }, false],
    [{ locale: "fr" }, false],
    [{ locale: null }, false],
    [{ email: "other@example.test" }, false],
    [{ isInstanceAdmin: true }, false],
    [{ id: "0192f3a0-0000-7000-8000-0000000000a1" }, false],
    [{ theme: "dark" }, true],
    [{ theme: "system", accent: "periwinkle", defaultView: "table", singleKeyShortcuts: false, aiOptOut: true, analyticsConsent: "denied" }, true],
    [{ onboarding: {} }, true],
    [{ onboarding: { importDone: true, browserSetupDone: false, checklistDismissed: true } }, true],
    [{ theme: "blue" }, false],
    [{ theme: null }, false],
    [{ accent: "#ff0000" }, false],
    [{ accent: "red" }, false],
    [{ accent: null }, false],
    [{ defaultView: "list" }, false],
    [{ singleKeyShortcuts: "no" }, false],
    [{ aiOptOut: 1 }, false],
    [{ analyticsConsent: "maybe" }, false],
    [{ onboarding: { extra: true } }, false],
    [{ onboarding: { importDone: "yes" } }, false],
    [{ onboarding: null }, false],
    [{ signinAlerts: false }, true],
    [{ signinAlerts: "no" }, false],
    [{ signinAlerts: null }, false],
    [{ consentAt: "2026-01-01T00:00:00Z" }, false],
  ])("%j is accepted: %s", (body, accepted) => {
    expect(UpdateAccountRequestSchema.safeParse(body).success).toBe(accepted);
  });
});

describe("the display name rule", () => {
  const astral = "\u{1F600}";

  it("trims the name and counts code points, so what the request parses to is what is stored", () => {
    expect(UpdateAccountRequestSchema.parse({ displayName: "  Ada  " })).toEqual({ displayName: "Ada" });
    expect(UpdateAccountRequestSchema.parse({ displayName: astral.repeat(60) })).toEqual({ displayName: astral.repeat(60) });
    expect(UpdateAccountRequestSchema.parse({ displayName: ` ${"x".repeat(100)} ` })).toEqual({ displayName: "x".repeat(100) });
  });

  it.each([
    ["blank after trimming", "   ", "too_small"],
    ["empty", "", "too_small"],
    ["101 astral code points", astral.repeat(101), "too_big"],
    ["101 letters between spaces", ` ${"x".repeat(101)} `, "too_big"],
  ])("refuses a name that is %s with the displayName field named", (_label, displayName, code) => {
    const result = UpdateAccountRequestSchema.safeParse({ displayName });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => ({ path: issue.path, code: issue.code }))).toEqual([{ path: ["displayName"], code }]);
  });
});

describe("the re-authentication and password operations", () => {
  const reauth = paths["/api/v1/me/reauth"]?.["post"];
  const password = paths["/api/v1/me/password"]?.["post"];

  it("declares reauthenticate: an account operation in the mfa bucket, not token-callable, that needs no earlier re-authentication", () => {
    expect(reauth?.["operationId"]).toBe("reauthenticate");
    expect(reauth?.["x-slugbase-auth"]).toBe("account");
    expect(reauth?.["x-slugbase-rate"]).toBe("mfa");
    expect(reauth?.["x-slugbase-scope"]).toBeUndefined();
    expect(reauth?.["x-slugbase-reauth"]).toBeUndefined();
    expect(Object.keys(responsesOf(reauth))).toContain("204");
    expect(responsesOf(reauth)["204"]?.content).toBeUndefined();
  });

  it("declares changePassword: an account operation in the write bucket that requires re-authentication and is not token-callable", () => {
    expect(password?.["operationId"]).toBe("changePassword");
    expect(password?.["x-slugbase-auth"]).toBe("account");
    expect(password?.["x-slugbase-rate"]).toBe("write");
    expect(password?.["x-slugbase-scope"]).toBeUndefined();
    expect(password?.["x-slugbase-reauth"]).toBe(true);
    expect(responsesOf(password)["204"]?.content).toBeUndefined();
  });

  it("declares application/problem+json for every client error, 401, 403, 422 and 429 among them", () => {
    for (const operation of [reauth, password]) {
      const responses = responsesOf(operation);
      const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
      expect(clientErrors).toEqual(expect.arrayContaining(["401", "403", "422", "429"]));
      for (const status of clientErrors) {
        expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
      }
    }
  });

  it("takes closed bodies that name the passwords and no account, session or hash", () => {
    const changePassword = schemas["ChangePasswordRequest"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(changePassword.additionalProperties).toBe(false);
    expect(Object.keys(changePassword.properties).sort()).toEqual(["currentPassword", "newPassword"]);
    // The current password is left out only to set the first password of an account that has none.
    expect([...changePassword.required].sort()).toEqual(["newPassword"]);
    expect(ChangePasswordRequestSchema.safeParse({ newPassword: "a new long password" }).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "", newPassword: "a new long password" }).success).toBe(false);
    expect(ReauthRequestSchema.safeParse({ password: "x" }).success).toBe(true);
    expect(ReauthRequestSchema.safeParse({ password: "" }).success).toBe(false);
    expect(ReauthRequestSchema.safeParse({ password: "x", sessionId: "y" }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "old", newPassword: "a new long password" }).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "old" }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: "old", newPassword: "a new long password", accountId: "x" }).success).toBe(false);
  });

  it("takes the password or a TOTP code to re-authenticate, never both and never anything else", () => {
    expect(schemas["ReauthRequest"]?.["anyOf"]).toHaveLength(2);
    expect(ReauthRequestSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(ReauthRequestSchema.safeParse({ code: "" }).success).toBe(false);
    expect(ReauthRequestSchema.safeParse({ code: "1".repeat(17) }).success).toBe(false);
    expect(ReauthRequestSchema.safeParse({ code: "123456", password: "x" }).success).toBe(false);
    expect(ReauthRequestSchema.safeParse({ backupCode: "ABCDE23456" }).success).toBe(false);
    expect(ReauthRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("the backup-code and disable operations", () => {
  const regenerate = paths["/api/v1/me/mfa/backup-codes"]?.["post"];
  const disable = paths["/api/v1/me/mfa"]?.["delete"];

  it.each([
    ["regenerateMfaBackupCodes", regenerate],
    ["disableMfa", disable],
  ])("declares %s: an account operation in the mfa bucket that requires re-authentication and is not token-callable", (operationId, operation) => {
    expect(operation?.["operationId"]).toBe(operationId);
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe("mfa");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBe(true);
    const responses = responsesOf(operation);
    const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
    expect(clientErrors).toEqual(expect.arrayContaining(["400", "401", "403", "422", "429"]));
    for (const status of clientErrors) {
      expect(Object.keys(responses[status]?.content ?? {}), status).toEqual(["application/problem+json"]);
    }
  });

  it("answers regeneration with the ten codes and disabling with an empty 204", () => {
    expect(responsesOf(regenerate)["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/MfaBackupCodes" } } });
    expect(responsesOf(disable)["204"]?.content).toBeUndefined();
  });

  it("takes a closed TOTP code to regenerate, and no backup code", () => {
    const schema = schemas["RegenerateBackupCodesRequest"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["code"]);
    expect(RegenerateBackupCodesRequestSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(RegenerateBackupCodesRequestSchema.safeParse({ code: "" }).success).toBe(false);
    expect(RegenerateBackupCodesRequestSchema.safeParse({ code: "1".repeat(17) }).success).toBe(false);
    expect(RegenerateBackupCodesRequestSchema.safeParse({ backupCode: "ABCDE23456" }).success).toBe(false);
    expect(RegenerateBackupCodesRequestSchema.safeParse({ code: "123456", extra: 1 }).success).toBe(false);
  });

  it("takes exactly one of a TOTP code and a backup code to disable, with the password an account without one leaves out", () => {
    expect(schemas["DisableMfaRequest"]?.["anyOf"]).toHaveLength(2);
    expect(DisableMfaRequestSchema.safeParse({ password: "x", code: "123456" }).success).toBe(true);
    expect(DisableMfaRequestSchema.safeParse({ password: "x", backupCode: "ABCDE23456" }).success).toBe(true);
    expect(DisableMfaRequestSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(DisableMfaRequestSchema.safeParse({ backupCode: "ABCDE23456" }).success).toBe(true);
    expect(DisableMfaRequestSchema.safeParse({}).success).toBe(false);
    expect(DisableMfaRequestSchema.safeParse({ password: "x" }).success).toBe(false);
    expect(DisableMfaRequestSchema.safeParse({ password: "x", code: "123456", backupCode: "ABCDE23456" }).success).toBe(false);
    expect(DisableMfaRequestSchema.safeParse({ password: "", code: "123456" }).success).toBe(false);
    expect(DisableMfaRequestSchema.safeParse({ password: "x", code: "123456", accountId: "y" }).success).toBe(false);
  });
});

describe("the API token operations", () => {
  const TOKEN = {
    id: "0192f3a0-0000-7000-8000-0000000000b1",
    name: "CI",
    workspaceId: "0192f3a0-0000-7000-8000-0000000000c1",
    workspaceName: "Team",
    scope: "read",
    prefix: "AbCdEf",
    createdAt: "2026-10-15T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };

  it.each([
    ["get", "/api/v1/me/api-tokens", "listApiTokens", "read", false],
    ["post", "/api/v1/me/api-tokens", "createApiToken", "token_create", true],
    ["delete", "/api/v1/me/api-tokens/{id}", "revokeApiToken", "write", false],
  ])("%s %s is %s: an account operation in the %s bucket that no API token may call", (method, path, operationId, rate, reauth) => {
    const operation = paths[path]?.[method];
    expect(operation?.["operationId"]).toBe(operationId);
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe(rate);
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBe(reauth ? true : undefined);
  });

  it("declares application/problem+json for every client error, and 404, 409 and 422 on the creation", () => {
    for (const [path, method] of [
      ["/api/v1/me/api-tokens", "get"],
      ["/api/v1/me/api-tokens", "post"],
      ["/api/v1/me/api-tokens/{id}", "delete"],
    ] as const) {
      const responses = responsesOf(paths[path]?.[method]);
      const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
      expect(clientErrors, `${method} ${path}`).toContain("401");
      expect(clientErrors, `${method} ${path}`).toContain("429");
      for (const status of clientErrors) {
        expect(Object.keys(responses[status]?.content ?? {}), `${method} ${path} ${status}`).toEqual(["application/problem+json"]);
      }
    }
    expect(Object.keys(responsesOf(paths["/api/v1/me/api-tokens"]?.["post"]))).toEqual(expect.arrayContaining(["201", "401", "404", "409", "422"]));
    expect(Object.keys(responsesOf(paths["/api/v1/me/api-tokens/{id}"]?.["delete"]))).toEqual(expect.arrayContaining(["204", "404"]));
  });

  it("lists closed ApiToken objects with no hash and no secret, and returns the secret only on the creation", () => {
    const token = schemas["ApiToken"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(token.additionalProperties).toBe(false);
    expect(Object.keys(token.properties).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "prefix", "scope", "workspaceId", "workspaceName"]);
    expect([...token.required].sort()).toEqual(Object.keys(token.properties).sort());
    expect(responsesOf(paths["/api/v1/me/api-tokens"]?.["get"])["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/ApiTokenList" } } });
    expect(responsesOf(paths["/api/v1/me/api-tokens"]?.["post"])["201"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/CreatedApiToken" } } });
    expect(ApiTokenSchema.safeParse({ ...TOKEN, token: "slb_x" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...TOKEN, tokenHash: "00" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse(TOKEN).success).toBe(true);
    expect(CreatedApiTokenSchema.safeParse({ ...TOKEN, token: `slb_${"A".repeat(43)}` }).success).toBe(true);
    expect(CreatedApiTokenSchema.safeParse(TOKEN).success).toBe(false);
    expect(ApiTokenListSchema.safeParse({ items: [TOKEN], nextCursor: null }).success).toBe(true);
  });

  it("takes a name of 1 to 64 characters, a scope of read or read-write and an expiry of 30, 90, 365 or null that is 90 when left out", () => {
    expect(CreateApiTokenRequestSchema.parse({ name: " CI ", scope: "read" })).toEqual({ name: "CI", scope: "read", expiresInDays: 90 });
    expect(CreateApiTokenRequestSchema.parse({ name: "CI", scope: "read-write", expiresInDays: null }).expiresInDays).toBeNull();
    for (const days of [30, 90, 365]) {
      expect(CreateApiTokenRequestSchema.parse({ name: "CI", scope: "read", expiresInDays: days }).expiresInDays).toBe(days);
    }
    for (const days of [0, 1, 31, 366, "90", 90.5]) {
      expect(CreateApiTokenRequestSchema.safeParse({ name: "CI", scope: "read", expiresInDays: days }).success, String(days)).toBe(false);
    }
    expect(CreateApiTokenRequestSchema.safeParse({ name: "", scope: "read" }).success).toBe(false);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "   ", scope: "read" }).success).toBe(false);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "x".repeat(64), scope: "read" }).success).toBe(true);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "x".repeat(65), scope: "read" }).success).toBe(false);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "CI", scope: "write" }).success).toBe(false);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "CI" }).success).toBe(false);
  });

  it("takes an optional workspace UUID and refuses a field it does not declare, an account among them", () => {
    const workspaceId = "0192f3a0-0000-7000-8000-0000000000c1";
    expect(CreateApiTokenRequestSchema.parse({ name: "CI", scope: "read", workspaceId }).workspaceId).toBe(workspaceId);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "CI", scope: "read", workspaceId: "not-a-uuid" }).success).toBe(false);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "CI", scope: "read", accountId: workspaceId }).success).toBe(false);
  });

  it("pages the list like the sessions and takes a UUID path identifier", () => {
    expect(ApiTokenListQuerySchema.parse({}).limit).toBe(50);
    expect(ApiTokenListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(ApiTokenListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ApiTokenIdParamsSchema.safeParse({ id: "0192f3a0-0000-7000-8000-0000000000b1" }).success).toBe(true);
    expect(ApiTokenIdParamsSchema.safeParse({ id: "nope" }).success).toBe(false);
  });
});

describe("the identity operations", () => {
  const IDENTITY = {
    id: "0192f3a0-0000-7000-8000-0000000000d1",
    provider: "idp",
    emailAtLink: "person@example.test",
    createdAt: "2026-10-15T10:00:00.000Z",
    lastUsedAt: null,
  };

  it.each([
    ["get", "/api/v1/me/identities", "listIdentities", "read", false],
    ["delete", "/api/v1/me/identities/{id}", "unlinkIdentity", "write", true],
  ])("%s %s is %s: an account operation in the %s bucket that no API token may call", (method, path, operationId, rate, reauth) => {
    const operation = paths[path]?.[method];
    expect(operation?.["operationId"]).toBe(operationId);
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe(rate);
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBe(reauth ? true : undefined);
    expect(operation?.["requestBody"]).toBeUndefined();
  });

  it("declares application/problem+json for every client error, and 404 and 422 on the unlink", () => {
    for (const [path, method] of [
      ["/api/v1/me/identities", "get"],
      ["/api/v1/me/identities/{id}", "delete"],
    ] as const) {
      const responses = responsesOf(paths[path]?.[method]);
      const clientErrors = Object.keys(responses).filter((status) => status.startsWith("4"));
      expect(clientErrors, `${method} ${path}`).toEqual(expect.arrayContaining(["401", "403", "422", "429"]));
      for (const status of clientErrors) {
        expect(Object.keys(responses[status]?.content ?? {}), `${method} ${path} ${status}`).toEqual(["application/problem+json"]);
      }
    }
    expect(Object.keys(responsesOf(paths["/api/v1/me/identities/{id}"]?.["delete"]))).toEqual(expect.arrayContaining(["204", "401", "404", "422"]));
    expect(JSON.stringify(responsesOf(paths["/api/v1/me/identities/{id}"]?.["delete"])["422"])).toContain("last_sign_in_method");
  });

  it("lists closed Identity objects with no subject of the provider", () => {
    const identity = schemas["Identity"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(identity.additionalProperties).toBe(false);
    expect(Object.keys(identity.properties).sort()).toEqual(["createdAt", "emailAtLink", "id", "lastUsedAt", "provider"]);
    expect([...identity.required].sort()).toEqual(Object.keys(identity.properties).sort());
    expect(responsesOf(paths["/api/v1/me/identities"]?.["get"])["200"]?.content).toEqual({ "application/json": { schema: { $ref: "#/components/schemas/IdentityList" } } });
    expect(IdentitySchema.safeParse(IDENTITY).success).toBe(true);
    expect(IdentitySchema.safeParse({ ...IDENTITY, subject: "sub-1" }).success).toBe(false);
    expect(IdentityListSchema.safeParse({ items: [IDENTITY], nextCursor: null }).success).toBe(true);
  });

  it("takes the page query and an identifier that is a UUID", () => {
    expect(IdentityListQuerySchema.parse({}).limit).toBe(50);
    expect(IdentityListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(IdentityListQuerySchema.safeParse({ offset: "1" }).success).toBe(false);
    expect(IdentityIdParamsSchema.safeParse({ id: IDENTITY.id }).success).toBe(true);
    expect(IdentityIdParamsSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("the email change operations", () => {
  const PROBLEM = { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } };

  it("asks for the change as an account operation that needs a fresh re-authentication, in the reset bucket, no API token may call", () => {
    const operation = paths["/api/v1/me/email"]?.["post"];
    expect(requestEmailChange.operationId).toBe("requestEmailChange");
    expect(operation?.["operationId"]).toBe("requestEmailChange");
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe("reset");
    expect(operation?.["x-slugbase-reauth"]).toBe(true);
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
  });

  it("answers the request with a 202 that has no body, and problem+json for every client error", () => {
    const responses = responsesOf(paths["/api/v1/me/email"]?.["post"]);
    expect(responses["202"]?.content).toBeUndefined();
    for (const status of ["400", "401", "403", "422", "503"]) {
      expect(responses[status]?.content, status).toEqual(PROBLEM);
    }
    expect(responses["429"]?.headers).toMatchObject({ "Retry-After": { required: true } });
    expect(Object.keys(responses)).not.toContain("409");
  });

  it.each([
    ["post", "/api/v1/me/email/confirm", "confirmEmailChange", "ConfirmEmailChangeRequest", ConfirmEmailChangeRequestSchema],
    ["post", "/api/v1/me/email/cancel", "cancelEmailChange", "CancelEmailChangeRequest", CancelEmailChangeRequestSchema],
  ] as const)("%s %s is %s: anonymous, in the token_redeem bucket, with a closed body of the token and 410 for a refused one", (method, path, operationId, schemaName, schema) => {
    const operation = paths[path]?.[method];
    expect(operation?.["operationId"]).toBe(operationId);
    expect(operation?.["x-slugbase-auth"]).toBe("anonymous");
    expect(operation?.["x-slugbase-rate"]).toBe("token_redeem");
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
    const body = schemas[schemaName] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties)).toEqual(["token"]);
    expect(body.required).toEqual(["token"]);
    expect(schema.safeParse({ token: "t" }).success).toBe(true);
    expect(schema.safeParse({ token: "" }).success).toBe(false);
    expect(schema.safeParse({ token: "t", extra: 1 }).success).toBe(false);
    const responses = responsesOf(operation);
    expect(responses["204"]?.content).toBeUndefined();
    for (const status of ["400", "403", "410", "422", "503"]) {
      expect(responses[status]?.content, status).toEqual(PROBLEM);
    }
    expect(responses["429"]?.headers).toMatchObject({ "Retry-After": { required: true } });
  });

  it("cancels the pending change as an account operation in the write bucket with no body and a 204", () => {
    const operation = paths["/api/v1/me/email/pending"]?.["delete"];
    expect(cancelPendingEmailChange.operationId).toBe("cancelPendingEmailChange");
    expect(operation?.["operationId"]).toBe("cancelPendingEmailChange");
    expect(operation?.["x-slugbase-auth"]).toBe("account");
    expect(operation?.["x-slugbase-rate"]).toBe("write");
    expect(operation?.["x-slugbase-reauth"]).toBeUndefined();
    expect(operation?.["x-slugbase-scope"]).toBeUndefined();
    expect(operation?.["requestBody"]).toBeUndefined();
    const responses = responsesOf(operation);
    expect(responses["204"]?.content).toBeUndefined();
    for (const status of ["400", "401", "403", "503"]) {
      expect(responses[status]?.content, status).toEqual(PROBLEM);
    }
  });

  it("takes a closed body of an email address for the request", () => {
    const body = schemas["RequestEmailChangeRequest"] as { additionalProperties: unknown; properties: Obj; required: string[] };
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties)).toEqual(["email"]);
    expect(body.required).toEqual(["email"]);
    expect(RequestEmailChangeRequestSchema.safeParse({ email: "a@example.test" }).success).toBe(true);
    expect(RequestEmailChangeRequestSchema.safeParse({ email: "not an address" }).success).toBe(false);
    expect(RequestEmailChangeRequestSchema.safeParse({ email: "a@example.test", extra: 1 }).success).toBe(false);
  });

  it("declares all four among the operations", () => {
    for (const operation of [requestEmailChange, confirmEmailChange, cancelEmailChange, cancelPendingEmailChange]) {
      expect(operations).toContain(operation);
    }
  });
});
