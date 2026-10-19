import { defineOperation, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import {
  PortUnavailable,
  type Adapters,
  type TenantPrincipal,
  type TenantResolution,
  type TenantResolver,
  type WorkspaceRole,
} from "@slugbase/core";
import type { TenantContext } from "@slugbase/db";
import { Hono } from "hono";
import { FixedClock } from "@slugbase/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createServer,
  type ApiTokenPrincipal,
  type Authenticator,
  type RequestTenant,
  type RouteBinding,
  type ServerModule,
  type SessionPrincipal,
} from "../../src/create-server.ts";
import { RouteTable, installChain, type ChainEnv } from "../../src/http/chain.ts";
import type { EntitlementCheck, EntitlementSubject } from "../../src/http/authorize.ts";
import { adapters, documentOf, fakeDatabase, hookDispatcher, recordingLogger, serverConfig, tenantDependencies, rateLimitDependencies } from "../support.ts";

// Stages 4, 7 and 9 of the chain (doc 01 section 4), exercised through the
// operations a test module registers, with stub authenticators and a stub
// tenant resolver. A refusal never reaches the handler: every test that
// expects one also asserts the handler spy.

const APP_ORIGIN = serverConfig().APP_ORIGIN;
const MARKETING_ORIGIN = "https://www.example.com";
const Echo = z.record(z.string(), z.unknown());

const WORKSPACE = "0190a000-0000-7000-8000-000000000001";
const OTHER_WORKSPACE = "0190a000-0000-7000-8000-000000000002";
const MEMBER_ID = "0190a000-0000-7000-8000-0000000000a1";

const account = (name: string): string => `0190a000-0000-7000-8000-0000000000${name}`;
const ACCOUNTS = { member: account("b1"), admin: account("b2"), owner: account("b3"), outsider: account("b4"), instanceAdmin: account("b5") };

type Who = keyof typeof ACCOUNTS;

const ROLES: Partial<Record<string, WorkspaceRole>> = {
  [ACCOUNTS.member]: "member",
  [ACCOUNTS.admin]: "admin",
  [ACCOUNTS.owner]: "owner",
  [ACCOUNTS.instanceAdmin]: "member",
};

const MINUTE = 60_000;
/** The instant the "anchored" session re-authenticated, for the tests that move an injected clock instead of reading the real one. */
const ANCHOR = Date.parse("2026-10-14T12:00:00.000Z");

function session(who: Who, state: Pick<SessionPrincipal, "mfaPending" | "reauthAt"> = {}): SessionPrincipal {
  return { kind: "session", sessionId: "stub-session", accountId: ACCOUNTS[who], activeWorkspaceId: WORKSPACE, instanceAdmin: who === "instanceAdmin", ...state };
}

// The session state a test cookie asks its authenticator to report: `sid=member; state=partial`.
function sessionState(name: string | undefined): Pick<SessionPrincipal, "mfaPending" | "reauthAt"> {
  switch (name) {
    case "partial":
      return { mfaPending: true, reauthAt: new Date(Date.now() - MINUTE) };
    case "fresh":
      return { reauthAt: new Date(Date.now() - 9 * MINUTE) };
    case "stale":
      return { reauthAt: new Date(Date.now() - 11 * MINUTE) };
    case "future":
      return { reauthAt: new Date(Date.now() + 5 * MINUTE) };
    case "anchored":
      return { reauthAt: new Date(ANCHOR) };
    case "invalid":
      return { reauthAt: new Date(Number.NaN) };
    default:
      return {};
  }
}

function token(who: Who, scope: ApiTokenPrincipal["scope"], workspaceId = WORKSPACE): ApiTokenPrincipal {
  return { kind: "api-token", accountId: ACCOUNTS[who], workspaceId, scope };
}

interface OperationOptions {
  readonly method?: "get" | "post";
  readonly scope?: "read" | "write";
  readonly entitlement?: string;
  readonly audience?: "machine" | "marketing-form";
  readonly body?: boolean;
  readonly reauth?: boolean;
}

function operationOf(path: string, operationId: string, auth: OperationDefinition["auth"], options: OperationOptions = {}): OperationDefinition {
  return defineOperation({
    method: options.method ?? "get",
    path,
    operationId,
    tag: "test",
    auth,
    rate: "none",
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.entitlement === undefined ? {} : { entitlement: options.entitlement }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.reauth === undefined ? {} : { reauth: options.reauth }),
    ...(options.body === true ? { request: { body: z.strictObject({ title: z.string() }) } } : {}),
    responses: { 200: jsonResponse("ok", Echo), 422: problemResponse("invalid") },
  });
}

interface Seen {
  readonly operationId: string;
  readonly principal: ApiTokenPrincipal | SessionPrincipal | undefined;
  readonly tenant: RequestTenant | undefined;
}

interface SetupOptions {
  readonly authenticators?: boolean;
  readonly resolver?: TenantResolver;
  readonly now?: () => number;
  readonly extraRoutes?: (handler: (id: string) => RouteBinding["handler"]) => readonly RouteBinding[];
}

const bearerTokens: Readonly<Record<string, ApiTokenPrincipal>> = {
  "Bearer slb_member_read": token("member", "read"),
  "Bearer slb_member_write": token("member", "read-write"),
  "Bearer slb_owner_write": token("owner", "read-write"),
  "Bearer slb_other_workspace": token("member", "read-write", OTHER_WORKSPACE),
};

function setup(options: SetupOptions = {}) {
  const seen: Seen[] = [];
  const cookieCalls: string[] = [];
  const bearerCalls: string[] = [];
  const resolved: TenantPrincipal[] = [];
  const transactions: TenantContext[] = [];

  const authenticators: Authenticator[] = [
    {
      credential: "bearer",
      authenticate: (authorization) => {
        bearerCalls.push(authorization);
        return Promise.resolve(bearerTokens[authorization]);
      },
    },
    {
      credential: "cookie",
      authenticate: (cookie) => {
        cookieCalls.push(cookie);
        const name = /(?:^|;\s*)sid=([A-Za-z]+)/.exec(cookie)?.[1];
        const state = /(?:^|;\s*)state=([A-Za-z]+)/.exec(cookie)?.[1];
        return Promise.resolve(name !== undefined && name in ACCOUNTS ? session(name as Who, sessionState(state)) : undefined);
      },
    },
  ];

  const resolver: TenantResolver = options.resolver ?? {
    available: true,
    resolve: (principal): Promise<TenantResolution | undefined> => {
      resolved.push(principal);
      const role = ROLES[principal.accountId];
      if (role === undefined) {
        return Promise.resolve(undefined);
      }
      const workspaceId = principal.kind === "api-token" ? principal.workspaceId : (principal.activeWorkspaceId ?? WORKSPACE);
      return Promise.resolve({ workspaceId, memberId: MEMBER_ID, role });
    },
  };

  const handler =
    (operationId: string): RouteBinding["handler"] =>
    async (context) => {
      const tenant = context.get("tenant");
      seen.push({ operationId, principal: context.get("principal"), tenant });
      await tenant?.withTenant(() => Promise.resolve());
      return Response.json({});
    };

  const operations = {
    anonymous: operationOf("/api/v1/open", "openThing", "anonymous"),
    account: operationOf("/api/v1/account-check", "checkAccount", "account", { scope: "read" }),
    member: operationOf("/api/v1/bookmarks", "listBookmarks", "member", { scope: "read" }),
    memberWrite: operationOf("/api/v1/bookmarks", "createBookmark", "member", { method: "post", scope: "write", body: true }),
    admin: operationOf("/api/v1/admin-check", "adminCheck", "admin", { scope: "read" }),
    owner: operationOf("/api/v1/owner-check", "checkOwner", "owner", { scope: "read" }),
    unscoped: operationOf("/api/v1/tokens", "listTokens", "account"),
    instance: operationOf("/api/v1/instance/accounts", "listAccounts", "instanceAdmin"),
    gated: operationOf("/api/v1/teams", "listTeams", "member", { scope: "read", entitlement: "teams.manage" }),
    machine: operationOf("/api/v1/events", "receiveEvent", "machine", { method: "post", audience: "machine" }),
    form: operationOf("/api/v1/contact", "sendContact", "anonymous", { method: "post", audience: "marketing-form" }),
    partial: operationOf("/api/v1/test/partial", "checkPartial", "partial", { method: "post" }),
    changeTestPassword: operationOf("/api/v1/test/password", "changeTestPassword", "account", { method: "post", reauth: true }),
    deleteWorkspace: operationOf("/api/v1/workspace/delete", "deleteWorkspace", "owner", { method: "post", reauth: true }),
    instanceReauth: operationOf("/api/v1/instance/accounts/delete", "deleteAccountAsAdmin", "instanceAdmin", { method: "post", reauth: true }),
  };
  const routes: RouteBinding[] = [
    ...Object.values(operations).map((operation): RouteBinding => ({
      operation,
      handler: handler(operation.operationId),
      ...(operation.audience === "marketing-form" ? { marketingOrigin: MARKETING_ORIGIN } : {}),
    })),
    ...(options.extraRoutes?.(handler) ?? []),
  ];
  const module: ServerModule = {
    name: "authorization-routes",
    register: () => ({ routes, ...(options.authenticators === false ? {} : { authenticators }) }),
  };
  const database = fakeDatabase();
  const server = createServer({
    config: serverConfig(),
    adapters: { ...adapters(), tenantResolver: resolver } satisfies Adapters,
    modules: [module],
    openApiDocument: documentOf([module]),
    migrations: [],
    logger: recordingLogger(),
    database: {
      ...database,
      withTenant: (context, fn) => {
        transactions.push(context);
        return database.withTenant(context, fn);
      },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { server, seen, cookieCalls, bearerCalls, resolved, transactions, operations };
}

const BROWSER_MUTATION = { origin: APP_ORIGIN, "content-type": "application/json" };

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

function post(path: string, headers: Record<string, string>, body = "{}"): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers, body });
}

async function codeOf(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return ((await response.json()) as { code: string }).code;
}

const cookieOf = (who: Who) => ({ cookie: `sid=${who}` });

describe("the failure scenario (T3): an anonymous caller of an operation that requires a member", () => {
  it("answers 401 unauthenticated and never reaches the handler", async () => {
    const { server, seen, resolved } = setup();
    const response = await server.fetch(get("/api/v1/bookmarks"));
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("unauthenticated");
    expect(seen).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it.each([
    ["/api/v1/admin-check"],
    ["/api/v1/owner-check"],
    ["/api/v1/account-check"],
    ["/api/v1/instance/accounts"],
  ])("answers 401 on %s too", async (path) => {
    const { server, seen } = setup();
    expect((await server.fetch(get(path))).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("reaches an anonymous operation", async () => {
    const { server, seen } = setup();
    expect((await server.fetch(get("/api/v1/open"))).status).toBe(200);
    expect(seen).toEqual([{ operationId: "openThing", principal: undefined, tenant: undefined }]);
  });
});

describe("stage 4: authentication", () => {
  it("makes a request anonymous when no module registers an authenticator and it carries only a cookie", async () => {
    const { server, seen, resolved } = setup({ authenticators: false });
    const open = await server.fetch(get("/api/v1/open", cookieOf("owner")));
    expect(open.status).toBe(200);
    expect(seen).toEqual([{ operationId: "openThing", principal: undefined, tenant: undefined }]);

    const guarded = await server.fetch(get("/api/v1/bookmarks", cookieOf("owner")));
    expect(guarded.status).toBe(401);
    expect(seen).toHaveLength(1);
    expect(resolved).toEqual([]);
  });

  it("answers 401 to an Authorization header that is not an API token of the server, whatever the module authenticators", async () => {
    const { server, seen, resolved } = setup({ authenticators: false });
    for (const path of ["/api/v1/open", "/api/v1/bookmarks"]) {
      const response = await server.fetch(get(path, { authorization: "Bearer slb_member_write", ...cookieOf("owner") }));
      expect(response.status, path).toBe(401);
      expect(await codeOf(response)).toBe("unauthenticated");
    }
    expect(seen).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("answers 401 to an Authorization header no authenticator accepts, and does not fall back to a valid cookie", async () => {
    const { server, seen, cookieCalls, bearerCalls, resolved } = setup();
    for (const path of ["/api/v1/bookmarks", "/api/v1/open"]) {
      const response = await server.fetch(get(path, { authorization: "Bearer slb_unknown", ...cookieOf("owner") }));
      expect(response.status, path).toBe(401);
      expect(await codeOf(response)).toBe("unauthenticated");
    }
    expect(bearerCalls).toEqual(["Bearer slb_unknown", "Bearer slb_unknown"]);
    expect(cookieCalls).toEqual([]);
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("resolves a token and ignores the cookie when both are sent", async () => {
    const { server, seen, cookieCalls } = setup();
    const response = await server.fetch(get("/api/v1/bookmarks", { authorization: "Bearer slb_member_read", ...cookieOf("owner") }));
    expect(response.status).toBe(200);
    expect(cookieCalls).toEqual([]);
    expect(seen[0]?.principal).toEqual(token("member", "read"));
  });

  it("resolves the session from the cookie", async () => {
    const { server, seen } = setup();
    expect((await server.fetch(get("/api/v1/bookmarks", cookieOf("member")))).status).toBe(200);
    expect(seen[0]?.principal).toEqual(session("member"));
  });

  it("treats a cookie no authenticator accepts as an anonymous request", async () => {
    const { server, seen } = setup();
    expect((await server.fetch(get("/api/v1/open", { cookie: "sid=expired" }))).status).toBe(200);
    expect(seen).toEqual([{ operationId: "openThing", principal: undefined, tenant: undefined }]);
    expect((await server.fetch(get("/api/v1/bookmarks", { cookie: "sid=expired" }))).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("resolves no credential for a request that matches no operation", async () => {
    const { server, cookieCalls, bearerCalls } = setup();
    expect((await server.fetch(get("/api/v1/nothing", { authorization: "Bearer slb_unknown", ...cookieOf("owner") }))).status).toBe(404);
    expect(cookieCalls).toEqual([]);
    expect(bearerCalls).toEqual([]);
  });

  it("fails the request when an authenticator cannot decide", async () => {
    const failing: ServerModule = {
      name: "failing-authenticator",
      register: () => ({
        routes: [{ operation: operationOf("/api/v1/open", "openThing", "anonymous"), handler: () => Response.json({}) }],
        authenticators: [{ credential: "cookie", authenticate: () => Promise.reject(new Error("database down")) }],
      }),
    };
    const server = createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [failing],
      openApiDocument: documentOf([failing]),
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });
    const response = await server.fetch(get("/api/v1/open", { cookie: "sid=member" }));
    expect(response.status).toBe(500);
    expect(await codeOf(response)).toBe("internal");
  });

  describe("a route with an audience", () => {
    it("never derives a principal on a machine route, with a valid session cookie or a valid token", async () => {
      const { server, seen, cookieCalls, bearerCalls, resolved } = setup();
      for (const credential of [cookieOf("owner"), { authorization: "Bearer slb_owner_write" }]) {
        const response = await server.fetch(post("/api/v1/events", { "content-type": "application/json", ...credential }));
        expect(response.status).toBe(200);
      }
      expect(seen).toEqual([
        { operationId: "receiveEvent", principal: undefined, tenant: undefined },
        { operationId: "receiveEvent", principal: undefined, tenant: undefined },
      ]);
      expect(cookieCalls).toEqual([]);
      expect(bearerCalls).toEqual([]);
      expect(resolved).toEqual([]);
    });

    it("never derives a principal on a marketing-form route, with a valid session cookie", async () => {
      const { server, seen, cookieCalls, resolved } = setup();
      const response = await server.fetch(
        post("/api/v1/contact", { origin: MARKETING_ORIGIN, "content-type": "application/json", ...cookieOf("owner") }),
      );
      expect(response.status).toBe(200);
      expect(seen).toEqual([{ operationId: "sendContact", principal: undefined, tenant: undefined }]);
      expect(cookieCalls).toEqual([]);
      expect(resolved).toEqual([]);
    });
  });
});

describe("stage 7: tenant resolution", () => {
  it("hands the handler a withTenant bound to the resolved workspace and the account", async () => {
    const { server, seen, resolved, transactions } = setup();
    const response = await server.fetch(get("/api/v1/bookmarks", { ...cookieOf("member"), "x-request-id": "request-id-0001" }));
    expect(response.status).toBe(200);
    expect(resolved).toEqual([session("member")]);
    expect(seen[0]?.tenant).toMatchObject({ accountId: ACCOUNTS.member, workspaceId: WORKSPACE, memberId: MEMBER_ID, role: "member" });
    expect(transactions).toEqual([{ accountId: ACCOUNTS.member, workspaceId: WORKSPACE, requestId: "request-id-0001" }]);
  });

  it("resolves a token in the workspace it is bound to", async () => {
    const { server, seen, resolved } = setup();
    expect((await server.fetch(get("/api/v1/bookmarks", { authorization: "Bearer slb_member_read" }))).status).toBe(200);
    expect(resolved).toEqual([token("member", "read")]);
    expect(seen[0]?.tenant?.workspaceId).toBe(WORKSPACE);
  });

  it("does not call the resolver for an anonymous request, and sets no tenant context", async () => {
    const { server, seen, resolved, transactions } = setup();
    await server.fetch(get("/api/v1/open"));
    expect(resolved).toEqual([]);
    expect(seen[0]?.tenant).toBeUndefined();
    expect(transactions).toEqual([]);
  });

  it("sets no tenant context when the resolver finds no workspace for a session, and refuses a workspace operation", async () => {
    const stranger = setup({
      resolver: { available: true, resolve: () => Promise.resolve(undefined) },
    });
    for (const path of ["/api/v1/bookmarks", "/api/v1/admin-check", "/api/v1/owner-check"]) {
      const missing = await stranger.server.fetch(get(path, cookieOf("owner")));
      expect(missing.status, path).toBe(404);
      expect(await codeOf(missing), path).toBe("not_found");
    }
    expect(stranger.seen).toEqual([]);

    const account = await stranger.server.fetch(get("/api/v1/account-check", cookieOf("member")));
    expect(account.status).toBe(200);
    expect(stranger.seen).toEqual([{ operationId: "checkAccount", principal: session("member"), tenant: undefined }]);
  });

  it("hands the resolver the request's identifier, which the tenant transaction it opens is named after", async () => {
    const requests: string[] = [];
    const { server } = setup({
      resolver: {
        available: true,
        resolve: (_principal, request) => {
          requests.push(request.requestId);
          return Promise.resolve({ workspaceId: WORKSPACE, memberId: MEMBER_ID, role: "member" });
        },
      },
    });
    const response = await server.fetch(get("/api/v1/bookmarks", { ...cookieOf("member"), "x-request-id": "req-from-the-edge" }));
    expect(response.status).toBe(200);
    expect(requests).toEqual(["req-from-the-edge"]);
  });

  it("resolves no workspace for a session still waiting for its second factor, and asks it for the factor", async () => {
    const { server, seen, resolved } = setup();
    const response = await server.fetch(get("/api/v1/bookmarks", { cookie: "sid=member; state=partial" }));
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("mfa_required");
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("answers 401 for a token whose workspace the resolver no longer finds", async () => {
    const { server, seen } = setup({ resolver: { available: true, resolve: () => Promise.resolve(undefined) } });
    const response = await server.fetch(get("/api/v1/bookmarks", { authorization: "Bearer slb_member_read" }));
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("unauthenticated");
    expect(seen).toEqual([]);
  });

  it("refuses a token the resolver places in another workspace than the one it is bound to", async () => {
    const { server, seen } = setup({
      resolver: { available: true, resolve: () => Promise.resolve({ workspaceId: WORKSPACE, memberId: MEMBER_ID, role: "owner" }) },
    });
    const response = await server.fetch(get("/api/v1/owner-check", { authorization: "Bearer slb_other_workspace" }));
    expect(response.status).toBe(500);
    expect(seen).toEqual([]);
  });

  it("answers 503 when the tenant resolver port is unavailable", async () => {
    const { server, seen } = setup({
      resolver: { available: false, resolve: () => Promise.reject(new PortUnavailable("tenantResolver", "unavailable")) },
    });
    const response = await server.fetch(get("/api/v1/bookmarks", cookieOf("member")));
    expect(response.status).toBe(503);
    expect(seen).toEqual([]);
  });
});

describe("stage 9: authorization", () => {
  const MATRIX: readonly (readonly [string, Who | undefined, number])[] = [
    ["/api/v1/bookmarks", "member", 200],
    ["/api/v1/bookmarks", "admin", 200],
    ["/api/v1/bookmarks", "owner", 200],
    ["/api/v1/admin-check", "member", 403],
    ["/api/v1/admin-check", "admin", 200],
    ["/api/v1/admin-check", "owner", 200],
    ["/api/v1/owner-check", "member", 403],
    ["/api/v1/owner-check", "admin", 403],
    ["/api/v1/owner-check", "owner", 200],
  ];

  it.each(MATRIX)("%s as %s answers %s, in the order owner above admin above member", async (path, who, status) => {
    const { server, seen } = setup();
    const response = await server.fetch(get(path, who === undefined ? {} : cookieOf(who)));
    expect(response.status).toBe(status);
    expect(seen).toHaveLength(status === 200 ? 1 : 0);
    if (status === 403) {
      expect(await codeOf(response)).toBe("forbidden");
    }
  });

  it("lets any signed-in account call an account operation", async () => {
    const { server } = setup();
    expect((await server.fetch(get("/api/v1/account-check", cookieOf("member")))).status).toBe(200);
  });

  it("admits an instance admin session only to an instanceAdmin operation", async () => {
    const { server, seen } = setup();
    expect((await server.fetch(get("/api/v1/instance/accounts", cookieOf("instanceAdmin")))).status).toBe(200);
    const refused = await server.fetch(get("/api/v1/instance/accounts", cookieOf("owner")));
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe("forbidden");
    expect(seen).toHaveLength(1);
  });

  describe("API tokens", () => {
    it("refuses a read-only token on a write operation with 403 token_scope", async () => {
      const { server, seen } = setup();
      const response = await server.fetch(post("/api/v1/bookmarks", { authorization: "Bearer slb_member_read", "content-type": "application/json" }, '{"title":"x"}'));
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("token_scope");
      expect(seen).toEqual([]);
    });

    it("lets a read-write token write and a read-only token read", async () => {
      const { server, seen } = setup();
      const written = await server.fetch(post("/api/v1/bookmarks", { authorization: "Bearer slb_member_write", "content-type": "application/json" }, '{"title":"x"}'));
      expect(written.status).toBe(200);
      expect((await server.fetch(get("/api/v1/bookmarks", { authorization: "Bearer slb_member_read" }))).status).toBe(200);
      expect(seen.map((entry) => entry.operationId)).toEqual(["createBookmark", "listBookmarks"]);
    });

    it("refuses a token on an operation that declares no scope with 403 forbidden", async () => {
      const { server, seen } = setup();
      for (const path of ["/api/v1/tokens", "/api/v1/instance/accounts"]) {
        const response = await server.fetch(get(path, { authorization: "Bearer slb_owner_write" }));
        expect(response.status, path).toBe(403);
        expect(await codeOf(response)).toBe("forbidden");
      }
      expect(seen).toEqual([]);
    });

    it("applies the role of the account in the bound workspace to a token", async () => {
      const { server } = setup();
      expect((await server.fetch(get("/api/v1/owner-check", { authorization: "Bearer slb_member_write" }))).status).toBe(403);
      expect((await server.fetch(get("/api/v1/owner-check", { authorization: "Bearer slb_owner_write" }))).status).toBe(200);
    });
  });

  it("refuses an operation that declares an entitlement when no entitlement source is configured", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(get("/api/v1/teams", cookieOf("owner")));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("entitlement_required");
    expect(seen).toEqual([]);
  });
});

describe("stage 9: declared re-authentication and completed second factor (T18)", () => {
  const sensitive = [
    ["changeTestPassword", "/api/v1/test/password", "member"],
    ["deleteWorkspace", "/api/v1/workspace/delete", "owner"],
  ] as const;
  const withState = (who: Who, state: string) => ({ cookie: `sid=${who}; state=${state}` });

  describe.each(sensitive)("%s, an operation that declares reauth", (operationId, path, who) => {
    it.each(["stale", "none", "future", "invalid"])("answers 401 reauth_required to a session whose re-authentication is %s, before the handler", async (state) => {
      const { server, seen } = setup();
      const response = await server.fetch(post(path, { ...BROWSER_MUTATION, ...withState(who, state) }));
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("reauth_required");
      expect(seen).toEqual([]);
    });

    it("lets a session re-authenticated within the window through", async () => {
      const { server, seen } = setup();
      const response = await server.fetch(post(path, { ...BROWSER_MUTATION, ...withState(who, "fresh") }));
      expect(response.status).toBe(200);
      expect(seen.map((entry) => entry.operationId)).toEqual([operationId]);
    });

    it("answers 401 mfa_required to a session whose second factor is pending, even one that re-authenticated", async () => {
      const { server, seen } = setup();
      const response = await server.fetch(post(path, { ...BROWSER_MUTATION, ...withState(who, "partial") }));
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("mfa_required");
      expect(seen).toEqual([]);
    });

    it("refuses an API token with 403 forbidden", async () => {
      const { server, seen } = setup();
      const response = await server.fetch(post(path, { ...BROWSER_MUTATION, authorization: "Bearer slb_owner_write" }));
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("forbidden");
      expect(seen).toEqual([]);
    });
  });

  it("refuses a role-less session with 403 forbidden rather than asking it to re-authenticate", async () => {
    const { server, seen } = setup();
    const response = await server.fetch(post("/api/v1/workspace/delete", { ...BROWSER_MUTATION, ...withState("member", "stale") }));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("forbidden");
    expect(seen).toEqual([]);
  });

  it("asks an instance admin to re-authenticate on an instanceAdmin operation that declares it, and refuses a stale non-admin as forbidden", async () => {
    const { server, seen } = setup();
    const stale = await server.fetch(post("/api/v1/instance/accounts/delete", { ...BROWSER_MUTATION, ...withState("instanceAdmin", "stale") }));
    expect(stale.status).toBe(401);
    expect(await codeOf(stale)).toBe("reauth_required");
    const outsider = await server.fetch(post("/api/v1/instance/accounts/delete", { ...BROWSER_MUTATION, ...withState("owner", "stale") }));
    expect(outsider.status).toBe(403);
    const fresh = await server.fetch(post("/api/v1/instance/accounts/delete", { ...BROWSER_MUTATION, ...withState("instanceAdmin", "fresh") }));
    expect(fresh.status).toBe(200);
    expect(seen.map((entry) => entry.operationId)).toEqual(["deleteAccountAsAdmin"]);
  });

  describe("under an injected clock", () => {
    const clock = new FixedClock(ANCHOR);
    const now = () => clock.now().getTime();

    it.each(sensitive)("%s is accepted 9 minutes after the re-authentication and refused 11 minutes after it, by the clock the server was given", async (operationId, path, who) => {
      const { server, seen } = setup({ now });
      clock.set(ANCHOR + 9 * MINUTE);
      const inside = await server.fetch(post(path, { ...BROWSER_MUTATION, ...withState(who, "anchored") }));
      expect(inside.status).toBe(200);
      expect(seen.map((entry) => entry.operationId)).toEqual([operationId]);

      clock.set(ANCHOR + 11 * MINUTE);
      const outside = await server.fetch(post(path, { ...BROWSER_MUTATION, ...withState(who, "anchored") }));
      expect(outside.status).toBe(401);
      expect(await codeOf(outside)).toBe("reauth_required");
      expect(seen).toHaveLength(1);
    });

    it("refuses a session whose re-authentication lies after the injected instant", async () => {
      const { server, seen } = setup({ now });
      clock.set(ANCHOR - MINUTE);
      const response = await server.fetch(post("/api/v1/test/password", { ...BROWSER_MUTATION, ...withState("member", "anchored") }));
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("reauth_required");
      expect(seen).toEqual([]);
    });

    it("accepts a re-authentication 2 seconds after the injected instant and refuses one 6 seconds after it", async () => {
      const { server, seen } = setup({ now });
      clock.set(ANCHOR - 2_000);
      const inside = await server.fetch(post("/api/v1/test/password", { ...BROWSER_MUTATION, ...withState("member", "anchored") }));
      expect(inside.status).toBe(200);
      expect(seen.map((entry) => entry.operationId)).toEqual(["changeTestPassword"]);

      clock.set(ANCHOR - 6_000);
      const outside = await server.fetch(post("/api/v1/test/password", { ...BROWSER_MUTATION, ...withState("member", "anchored") }));
      expect(outside.status).toBe(401);
      expect(await codeOf(outside)).toBe("reauth_required");
      expect(seen).toHaveLength(1);
    });
  });

  it("does not ask for re-authentication on an operation that does not declare it", async () => {
    const { server } = setup();
    expect((await server.fetch(get("/api/v1/bookmarks", withState("member", "stale")))).status).toBe(200);
    expect((await server.fetch(get("/api/v1/account-check", withState("member", "none")))).status).toBe(200);
  });

  describe("a session whose second factor is pending", () => {
    it.each([
      ["/api/v1/account-check", "member"],
      ["/api/v1/bookmarks", "member"],
      ["/api/v1/admin-check", "admin"],
      ["/api/v1/owner-check", "owner"],
      ["/api/v1/instance/accounts", "instanceAdmin"],
      ["/api/v1/tokens", "member"],
    ] as const)("answers 401 mfa_required on %s, before the handler", async (path, who) => {
      const { server, seen } = setup();
      const response = await server.fetch(get(path, withState(who, "partial")));
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("mfa_required");
      expect(seen).toEqual([]);
    });

    it("is admitted by an operation that declares the partial policy, and so is a completed session", async () => {
      const { server, seen } = setup();
      expect((await server.fetch(post("/api/v1/test/partial", { ...BROWSER_MUTATION, ...withState("member", "partial") }))).status).toBe(200);
      expect((await server.fetch(post("/api/v1/test/partial", { ...BROWSER_MUTATION, ...cookieOf("member") }))).status).toBe(200);
      expect(seen.map((entry) => entry.operationId)).toEqual(["checkPartial", "checkPartial"]);
    });

    it("is refused the partial operation without a credential, and an API token is refused it", async () => {
      const { server, seen } = setup();
      expect((await server.fetch(post("/api/v1/test/partial", BROWSER_MUTATION))).status).toBe(401);
      const response = await server.fetch(post("/api/v1/test/partial", { ...BROWSER_MUTATION, authorization: "Bearer slb_member_write" }));
      expect(response.status).toBe(403);
      expect(seen).toEqual([]);
    });
  });

  describe("on the chain with a principal set directly", () => {
    function chainWith(principal: SessionPrincipal | ApiTokenPrincipal, operation: OperationDefinition) {
      const app = new Hono<ChainEnv>();
      const handled: string[] = [];
      installChain(
        app,
        {
          logger: recordingLogger(),
          routes: new RouteTable([{ operation, handler: () => (handled.push("handler"), Response.json({})) }]),
          trustedProxyHops: 0,
          appOrigin: APP_ORIGIN,
          challenge: adapters().challenge,
          errors: adapters().errors,
          hooks: hookDispatcher(),
          responseValidation: "throw",
          ...tenantDependencies(),
          ...rateLimitDependencies(),
        },
        {
          authentication: async (context, next) => {
            context.set("principal", principal);
            await next();
          },
          "tenant-resolution": async (context, next) => {
            context.set("tenant", {
              accountId: ACCOUNTS.owner,
              workspaceId: WORKSPACE,
              memberId: MEMBER_ID,
              role: "owner",
              withTenant: (fn) => fn({ accountId: ACCOUNTS.owner, workspaceId: WORKSPACE, requestId: "r" }),
            });
            await next();
          },
        },
      );
      return { app, handled };
    }

    it("refuses an API token on an operation that declares reauth even when the operation also declares a scope", async () => {
      const { app, handled } = chainWith(token("owner", "read-write"), operationOf("/api/v1/tokens/new", "createToken", "account", { scope: "write", reauth: true }));
      const response = await app.request("http://localhost/api/v1/tokens/new");
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("forbidden");
      expect(handled).toEqual([]);
    });

    it("treats a session principal that reports no re-authentication as never re-authenticated", async () => {
      const { app, handled } = chainWith(session("owner"), operationOf("/api/v1/tokens/new", "createToken", "account", { reauth: true }));
      const response = await app.request("http://localhost/api/v1/tokens/new");
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe("reauth_required");
      expect(handled).toEqual([]);
    });
  });
});

describe("the order of the stages", () => {
  it("runs authentication before the cross-site check and the cross-site check before tenant resolution", async () => {
    const { server, seen, cookieCalls, resolved } = setup();
    const response = await server.fetch(
      post("/api/v1/bookmarks", { origin: "https://evil.example", "content-type": "application/json", ...cookieOf("member") }, '{"title":"x"}'),
    );
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site_request");
    expect(cookieCalls).toEqual(["sid=member"]);
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("runs tenant resolution before validation and validation before authorization", async () => {
    const { server, seen, resolved } = setup();
    // The member passes stages 4 to 7, fails validation (422), and would also fail authorization on an admin operation.
    const invalid = await server.fetch(post("/api/v1/bookmarks", { ...BROWSER_MUTATION, ...cookieOf("member") }, '{"unknown":1}'));
    expect(invalid.status).toBe(422);
    expect(resolved).toEqual([session("member")]);

    const anonymousInvalid = await server.fetch(post("/api/v1/bookmarks", BROWSER_MUTATION, '{"unknown":1}'));
    expect(anonymousInvalid.status).toBe(422);
    const anonymousValid = await server.fetch(post("/api/v1/bookmarks", BROWSER_MUTATION, '{"title":"x"}'));
    expect(anonymousValid.status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("an entitlement source", () => {
  function gated(check: EntitlementCheck) {
    const app = new Hono<ChainEnv>();
    const handled: string[] = [];
    const operation = operationOf("/api/v1/teams", "listTeams", "member", { scope: "read", entitlement: "teams.manage" });
    installChain(
      app,
      {
        logger: recordingLogger(),
        routes: new RouteTable([{ operation, handler: () => (handled.push("handler"), Response.json({})) }]),
        trustedProxyHops: 0,
        appOrigin: APP_ORIGIN,
        challenge: adapters().challenge,
        errors: adapters().errors,
        hooks: hookDispatcher(),
        responseValidation: "throw",
        entitlements: check,
        ...tenantDependencies(), ...rateLimitDependencies(),
      },
      {
        authentication: async (context, next) => {
          context.set("principal", session("owner"));
          await next();
        },
        "tenant-resolution": async (context, next) => {
          context.set("tenant", {
            accountId: ACCOUNTS.owner,
            workspaceId: WORKSPACE,
            memberId: MEMBER_ID,
            role: "owner",
            withTenant: (fn) => fn({ accountId: ACCOUNTS.owner, workspaceId: WORKSPACE, requestId: "r" }),
          });
          await next();
        },
      },
    );
    return { app, handled };
  }

  it("lets the request through when the source holds the entitlement, asking it for the account and workspace", async () => {
    const asked: [string, EntitlementSubject][] = [];
    const { app, handled } = gated((entitlement, subject) => (asked.push([entitlement, subject]), true));
    expect((await app.request("http://localhost/api/v1/teams")).status).toBe(200);
    expect(asked).toEqual([["teams.manage", { accountId: ACCOUNTS.owner, workspaceId: WORKSPACE }]]);
    expect(handled).toEqual(["handler"]);
  });

  it("answers 403 entitlement_required when the source does not hold it", async () => {
    const { app, handled } = gated(() => Promise.resolve(false));
    const response = await app.request("http://localhost/api/v1/teams");
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("entitlement_required");
    expect(handled).toEqual([]);
  });

  it("fails the request when the source cannot decide", async () => {
    const { app, handled } = gated(() => Promise.reject(new Error("source down")));
    expect((await app.request("http://localhost/api/v1/teams")).status).toBe(500);
    expect(handled).toEqual([]);
  });
});
