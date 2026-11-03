import { operations as contractOperations, defineOperation, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import { unconfigured } from "@slugbase/core";
import type { AccountAccessModeRecord } from "@slugbase/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXPORT_ONLY_OPERATIONS } from "../../src/http/access-mode.ts";
import type { ApiTokenPrincipal, SessionPrincipal } from "../../src/http/authenticate.ts";
import { RouteTable, installChain, type ChainEnv, type RouteBinding } from "../../src/http/chain.ts";
import { hookDispatcher, rateLimitDependencies, recordingLogger, tenantDependencies } from "../support.ts";

// The access-mode check of stage 4 (doc 01 section 4, doc 02 section 2.11, doc 04 section 3.2, doc 10 T4 and T18). The failure
// scenarios: an export-only account whose session reaches an operation that writes, one an API token reaches, or one that is anonymous
// by policy but carries the session; a token that passes because the operation it calls is one a session may call; a database that cannot
// answer, which must not let the request go on; and a list of allowed operations that names an operation the contracts do not declare, or
// a write, so that a typo or an addition changes who can do what without a test saying so.

const ACCOUNT = "0190a000-0000-7000-8000-0000000000b1";
const UNTIL = new Date("2026-12-01T10:00:00.000Z");
const Echo = z.record(z.string(), z.unknown());

function operationOf(method: "get" | "post" | "patch" | "delete", path: string, operationId: string, auth: OperationDefinition["auth"]): OperationDefinition {
  return defineOperation({
    method,
    path,
    operationId,
    tag: "test",
    auth,
    rate: "none",
    ...(auth === "anonymous" || auth === "partial" ? {} : { scope: method === "get" ? ("read" as const) : ("write" as const) }),
    responses: { 200: jsonResponse("ok", Echo), 404: problemResponse("not found") },
  });
}

const OPERATIONS = {
  getMe: operationOf("get", "/api/v1/me", "getMe", "account"),
  listBookmarks: operationOf("get", "/api/v1/bookmarks", "listBookmarks", "member"),
  createBookmark: operationOf("post", "/api/v1/bookmarks", "createBookmark", "member"),
  updateMe: operationOf("patch", "/api/v1/me", "updateMe", "account"),
  acceptInvitation: operationOf("post", "/api/v1/invitations/accept", "acceptInvitation", "anonymous"),
  logout: operationOf("post", "/api/v1/auth/logout", "logout", "partial"),
  openThing: operationOf("get", "/api/v1/open", "getApiConfig", "anonymous"),
  oidcStart: operationOf("get", "/api/v1/auth/oidc/idp/start", "startOidcSignIn", "anonymous"),
  oidcCallback: operationOf("get", "/api/v1/auth/oidc/idp/callback", "completeOidcSignIn", "anonymous"),
};

const session: SessionPrincipal = { kind: "session", sessionId: "stub-session", accountId: ACCOUNT, activeWorkspaceId: undefined, instanceAdmin: false };
const token: ApiTokenPrincipal = { kind: "api-token", tokenId: "stub-token", accountId: ACCOUNT, workspaceId: "0190a000-0000-7000-8000-000000000001", scope: "read-write" };

type Mode = AccountAccessModeRecord | undefined | Error;

function build(mode: Mode) {
  const lookups: string[] = [];
  const reached: string[] = [];
  const app = new Hono<ChainEnv>();
  const bindings: RouteBinding[] = Object.values(OPERATIONS).map((operation) => ({
    operation,
    handler: () => {
      reached.push(operation.operationId);
      return Response.json({});
    },
  }));
  installChain(
    app,
    {
      logger: recordingLogger(),
      routes: new RouteTable(bindings),
      trustedProxyHops: 0,
      appOrigin: "https://bookmarks.example.com",
      challenge: unconfigured().challenge,
      errors: unconfigured().errors,
      ...tenantDependencies(),
      ...rateLimitDependencies(),
      hooks: hookDispatcher(),
      responseValidation: "throw",
      authenticators: [
        { credential: "bearer", authenticate: () => Promise.resolve(token) },
        { credential: "cookie", authenticate: () => Promise.resolve(session) },
      ],
      accessMode: {
        accountAccessMode: (accountId) => {
          lookups.push(accountId);
          return mode instanceof Error ? Promise.reject(mode) : Promise.resolve(mode);
        },
      },
    },
    // The stages after authentication are not under test; they would judge the stub tenant and policy.
    { "cross-site-protection": (_context, next) => next(), "rate-limiting": (_context, next) => next(), "tenant-resolution": (_context, next) => next(), validation: (_context, next) => next(), authorization: (_context, next) => next() },
  );
  const call = (method: string, path: string, credential: "session" | "token" | "none"): Promise<Response> =>
    Promise.resolve(
      app.request(`https://bookmarks.example.com${path}`, {
        method,
        headers: { origin: "https://bookmarks.example.com", "content-type": "application/json", ...(credential === "token" ? { authorization: "Bearer slb_x" } : credential === "session" ? { cookie: "sid=1" } : {}) },
        ...(method === "GET" ? {} : { body: "{}" }),
      }),
    );
  return { call, lookups, reached };
}

const EXPORT_ONLY: AccountAccessModeRecord = { mode: "exportOnly", until: UNTIL };

describe("an export-only account", () => {
  it("is refused 403 account_export_only on a write, naming when the period ends, and the handler never runs", async () => {
    const { call, reached } = build(EXPORT_ONLY);
    for (const [method, path] of [["POST", "/api/v1/bookmarks"], ["PATCH", "/api/v1/me"]] as const) {
      const response = await call(method, path, "session");
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ code: "account_export_only", status: 403, until: UNTIL.toISOString() });
    }
    expect(reached).toEqual([]);
  });

  it("is refused on an operation that is anonymous by policy when the request carries its session, as accepting an invitation is", async () => {
    const { call, reached } = build(EXPORT_ONLY);
    const response = await call("POST", "/api/v1/invitations/accept", "session");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "account_export_only" });
    expect(reached).toEqual([]);
  });

  it("is refused on every request of an API token, also on an operation a session may call", async () => {
    const { call, reached } = build(EXPORT_ONLY);
    for (const path of ["/api/v1/bookmarks", "/api/v1/me"]) {
      const response = await call("GET", path, "token");
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "account_export_only" });
    }
    expect(reached).toEqual([]);
  });

  it("reads what the list allows, ends the session and finishes a sign-in, without asking the database for the mode", async () => {
    const { call, reached, lookups } = build(EXPORT_ONLY);
    expect((await call("GET", "/api/v1/me", "session")).status).toBe(200);
    expect((await call("GET", "/api/v1/bookmarks", "session")).status).toBe(200);
    expect((await call("POST", "/api/v1/auth/logout", "session")).status).toBe(200);
    expect(reached).toEqual(["getMe", "listBookmarks", "logout"]);
    expect(lookups).toEqual([]);
  });

  it("reads the configuration the web app loads at boot with its session cookie, which is anonymous by policy, without asking the database for the mode", async () => {
    const { call, reached, lookups } = build(EXPORT_ONLY);
    expect((await call("GET", "/api/v1/open", "session")).status).toBe(200);
    expect(reached).toEqual(["getApiConfig"]);
    expect(lookups).toEqual([]);
  });

  it("reaches the provider's sign-in and re-authentication with its session, without asking the database for the mode, which the start's handler judges by intent", async () => {
    const { call, reached, lookups } = build(EXPORT_ONLY);
    expect((await call("GET", "/api/v1/auth/oidc/idp/start", "session")).status).toBe(200);
    expect((await call("GET", "/api/v1/auth/oidc/idp/callback", "session")).status).toBe(200);
    expect(reached).toEqual(["startOidcSignIn", "completeOidcSignIn"]);
    expect(lookups).toEqual([]);
  });

  it("is still refused on the provider's sign-in with an API token", async () => {
    const { call, reached } = build(EXPORT_ONLY);
    for (const path of ["/api/v1/auth/oidc/idp/start", "/api/v1/auth/oidc/idp/callback"]) {
      const response = await call("GET", path, "token");
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "account_export_only" });
    }
    expect(reached).toEqual([]);
  });

  it("is not judged when there is no principal: a request without a credential is outside the check", async () => {
    const { call, reached, lookups } = build(EXPORT_ONLY);
    expect((await call("GET", "/api/v1/open", "none")).status).toBe(200);
    expect(reached).toEqual(["getApiConfig"]);
    expect(lookups).toEqual([]);
  });
});

describe("an account with full access", () => {
  it("reaches every operation, the lookup naming the account of the principal", async () => {
    const { call, reached, lookups } = build({ mode: "full" });
    expect((await call("POST", "/api/v1/bookmarks", "session")).status).toBe(200);
    expect((await call("GET", "/api/v1/bookmarks", "token")).status).toBe(200);
    expect(reached).toEqual(["createBookmark", "listBookmarks"]);
    expect(lookups).toEqual([ACCOUNT, ACCOUNT]);
  });
});

describe("a database that cannot answer, or an account that is gone", () => {
  it("does not let the request go on: a rejection is an error, never a request that continues", async () => {
    const { call, reached } = build(new Error("connection refused"));
    const response = await call("POST", "/api/v1/bookmarks", "session");
    expect(response.status).toBe(500);
    expect(reached).toEqual([]);
  });

  it("answers 401 for an account that no longer exists", async () => {
    const { call, reached } = build(undefined);
    const response = await call("POST", "/api/v1/bookmarks", "session");
    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
  });
});

describe("the operations an export-only session may call", () => {
  const declared = new Map(contractOperations.map((operation) => [operation.operationId, operation]));

  it("are all declared by the contracts", () => {
    for (const id of EXPORT_ONLY_OPERATIONS) {
      expect(declared.has(id), id).toBe(true);
    }
  });

  it("read, export, finish a sign-in or sign-out, change the workspace the session acts in, or delete the account itself, and write nothing else", () => {
    const writes = [...EXPORT_ONLY_OPERATIONS].filter((id) => declared.get(id)?.method !== "get").sort();
    expect(writes).toEqual(["deleteMe", "logout", "reauthenticate", "setActiveWorkspace", "verifyMfa"]);
  });

  it("are none of the operations of the instance admin, of API tokens, of invitations or of /go", () => {
    for (const id of EXPORT_ONLY_OPERATIONS) {
      const operation = declared.get(id);
      expect(operation?.auth, id).not.toBe("instanceAdmin");
      expect(operation?.path, id).not.toMatch(/\/api-tokens|\/invitations|\/go\//);
    }
  });
});
