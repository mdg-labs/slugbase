import { randomBytes } from "node:crypto";
import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import type { Adapters } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { route } from "../../src/routes/register.ts";
import {
  lastActiveAt,
  removeMembership,
  seedAccount,
  seedMembership,
  seedWorkspace,
  setActiveWorkspace,
  setLastActiveAt,
  sha256,
  storeFor,
  workspaceChecksum,
  type SeededAccount,
} from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, documentFor, recordingLogger, serverConfig } from "../support.ts";

// GET /api/v1/me and the tenant resolution behind it, through the whole chain
// over the migrated database (doc 04 section 10.3, doc 01 sections 4 and 5.2,
// doc 10 T1): the failure scenarios are a session whose forged active workspace
// names a workspace the account is not a member of, a response that carries a
// hash or another workspace, and an account with no workspace that reaches a
// workspace operation.

const SESSION_COOKIE = "__Host-slugbase_session";
const MINUTE_MS = 60_000;
const DSN = "https://public-key@errors.example.com/7";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

const workspaceProbe = defineOperation({
  method: "get",
  path: "/api/v1/workspace-probe",
  operationId: "probeWorkspace",
  tag: "test",
  auth: "member",
  scope: "read",
  rate: "read",
  responses: {
    200: jsonResponse("the workspace of the request", z.strictObject({ workspaceId: z.uuid(), memberId: z.uuid(), role: z.string() })),
    404: problemResponse("no workspace"),
  },
});

const adminProbe = defineOperation({
  method: "get",
  path: "/api/v1/admin-probe",
  operationId: "probeAdmin",
  tag: "test",
  auth: "admin",
  rate: "read",
  responses: { 200: jsonResponse("ok", z.strictObject({})), 404: problemResponse("no workspace"), 403: problemResponse("too low") },
});

/** An API token for an account and a workspace: `Bearer token:<account>:<workspace>`. */
const bearer: Authenticator = {
  credential: "bearer",
  authenticate: (authorization) => {
    const [, accountId, workspaceId] = /^Bearer token:([^:]+):([^:]+)$/.exec(authorization) ?? [];
    return Promise.resolve(accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", accountId, workspaceId, scope: "read" });
  },
};

interface ServeOptions {
  readonly clientErrorReport?: boolean;
}

function serve({ clientErrorReport = false }: ServeOptions = {}): Server {
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()) });
  const withSource: Adapters = {
    ...adapters(config),
    // The composition root of the Community Edition passes this resolver; the server resolves memberships in its place.
    tenantResolver: createAccountOnlyTenantResolver(),
    ...(clientErrorReport ? { clientErrorReport: { available: true, dsn: () => Promise.resolve(DSN) } } : {}),
  };
  return createServer({
    config,
    adapters: withSource,
    modules: [
      {
        name: "probes",
        register: () => ({
          routes: [
            route(workspaceProbe).handle((_request, context) => {
              const tenant = context.get("tenant");
              if (tenant === undefined) {
                throw new Error("the authorization stage let a request without a workspace through");
              }
              return { status: 200, body: { workspaceId: tenant.workspaceId, memberId: tenant.memberId, role: tenant.role } };
            }),
            route(adminProbe).handle(() => ({ status: 200, body: {} })),
          ],
          authenticators: [bearer],
        }),
      },
    ],
    openApiDocument: documentFor([workspaceProbe, adminProbe]),
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
}

interface Browser {
  readonly cookie: string;
  readonly sessionId: string;
  readonly accountId: string;
}

async function signIn(account: SeededAccount): Promise<Browser> {
  const token = randomBytes(32);
  const sessionId = `0192f3a0-dddd-7000-8000-${randomBytes(6).toString("hex")}`;
  const created = await store.createSession({
    id: sessionId,
    accountId: account.id,
    remember: false,
    ipPrefix: null,
    userAgent: null,
    tokenHash: sha256(token),
    replacedTokenHash: null,
  });
  expect(created).toBe(true);
  return { cookie: `${SESSION_COOKIE}=${token.toString("base64url")}`, sessionId, accountId: account.id };
}

function call(server: Server, path: string, credential: Browser | string | null): Promise<Response> {
  const headers = new Headers();
  if (typeof credential === "string") {
    headers.set("authorization", credential);
  } else if (credential !== null) {
    headers.set("cookie", credential.cookie);
  }
  return server.fetch(new Request(new URL(path, serverConfig().APP_ORIGIN), { headers }));
}

interface Me {
  account: Record<string, unknown>;
  memberships: { workspaceId: string; name: string; role: string }[];
  activeWorkspaceId: string | null;
  clientErrorReportDsn?: string;
}

async function me(server: Server, credential: Browser | string): Promise<Me> {
  const response = await call(server, "/api/v1/me", credential);
  expect(response.status).toBe(200);
  return (await response.json()) as Me;
}

async function problemCode(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return ((await response.json()) as { code: string }).code;
}

describe("GET /api/v1/me", () => {
  it("returns the account with no membership and no active workspace, and nothing secret", async () => {
    const server = serve();
    const ada = await seedAccount(database(), { emailVerified: true });
    const response = await call(server, "/api/v1/me", await signIn(ada));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      account: {
        id: ada.id,
        email: ada.email,
        displayName: "Test account",
        locale: "en",
        theme: "system",
        accent: null,
        defaultView: "grid",
        aiOptOut: false,
        emailVerified: true,
        hasPassword: true,
      },
      memberships: [],
      activeWorkspaceId: null,
    });
    expect(text).not.toMatch(/argon2|password_hash|passwordHash|token_hash/i);
  });

  it("says an account without a password has none, and an unverified email is not verified", async () => {
    const server = serve();
    const federated = await seedAccount(database(), { password: null });
    const body = await me(server, await signIn(federated));
    expect(body.account).toMatchObject({ hasPassword: false, emailVerified: false });
  });

  it("lists the memberships with their roles and names the session's active workspace", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const first = await seedWorkspace(database(), { name: "Notes" });
    const second = await seedWorkspace(database(), { name: "Reading list" });
    await seedMembership(database(), { workspaceId: first, accountId: ada.id, role: "owner" });
    await seedMembership(database(), { workspaceId: second, accountId: ada.id, role: "member" });
    const browser = await signIn(ada);
    await setActiveWorkspace(database(), browser.sessionId, second);

    const body = await me(server, browser);
    expect(body.activeWorkspaceId).toBe(second);
    expect([...body.memberships].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { workspaceId: first, name: "Notes", role: "owner" },
      { workspaceId: second, name: "Reading list", role: "member" },
    ]);
  });

  it("re-derives the active workspace to the most recently active membership when the session has none", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const quiet = await seedWorkspace(database());
    const busy = await seedWorkspace(database());
    const neverUsed = await seedWorkspace(database());
    const now = Date.now();
    await seedMembership(database(), { workspaceId: quiet, accountId: ada.id, lastActiveAt: new Date(now - 30 * MINUTE_MS) });
    await seedMembership(database(), { workspaceId: busy, accountId: ada.id, lastActiveAt: new Date(now - 10 * MINUTE_MS) });
    await seedMembership(database(), { workspaceId: neverUsed, accountId: ada.id });

    expect((await me(server, await signIn(ada))).activeWorkspaceId).toBe(busy);
  });

  it("falls back to another membership when the account is no longer a member of the session's workspace, and to none when it has no other", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const kept = await seedWorkspace(database());
    const left = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: kept, accountId: ada.id });
    await seedMembership(database(), { workspaceId: left, accountId: ada.id });
    const browser = await signIn(ada);
    await setActiveWorkspace(database(), browser.sessionId, left);
    expect((await me(server, browser)).activeWorkspaceId).toBe(left);

    await removeMembership(database(), left, ada.id);
    expect((await me(server, browser)).activeWorkspaceId).toBe(kept);

    await removeMembership(database(), kept, ada.id);
    const body = await me(server, browser);
    expect(body.activeWorkspaceId).toBeNull();
    expect(body.memberships).toEqual([]);
  });

  it("treats a workspace being deleted as inaccessible: not listed, not active", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const live = await seedWorkspace(database());
    const dying = await seedWorkspace(database(), { deleting: true });
    await seedMembership(database(), { workspaceId: live, accountId: ada.id });
    await seedMembership(database(), { workspaceId: dying, accountId: ada.id, lastActiveAt: new Date() });
    const browser = await signIn(ada);
    await setActiveWorkspace(database(), browser.sessionId, dying);

    const body = await me(server, browser);
    expect(body.activeWorkspaceId).toBe(live);
    expect(body.memberships.map((membership) => membership.workspaceId)).toEqual([live]);
  });

  it("never makes a workspace the account is not a member of its active one, however the session names it (T1)", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const adas = await seedWorkspace(database(), { name: "Ada's" });
    const graces = await seedWorkspace(database(), { name: "Grace's secret" });
    await seedMembership(database(), { workspaceId: adas, accountId: ada.id, role: "owner" });
    await seedMembership(database(), { workspaceId: graces, accountId: grace.id, role: "owner" });
    const forged = await signIn(ada);
    await setActiveWorkspace(database(), forged.sessionId, graces);
    const before = await workspaceChecksum(database(), graces);

    const response = await call(server, "/api/v1/me", forged);
    const text = await response.text();
    expect((JSON.parse(text) as Me).activeWorkspaceId).toBe(adas);
    expect(text).not.toContain(graces);
    expect(text).not.toContain("Grace's secret");
    expect(text).not.toContain(grace.id);

    const probe = await call(server, "/api/v1/workspace-probe", forged);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ workspaceId: adas, memberId: ada.id, role: "owner" });

    const homeless = await seedAccount(database());
    const homelessForged = await signIn(homeless);
    await setActiveWorkspace(database(), homelessForged.sessionId, graces);
    expect((await me(server, homelessForged)).activeWorkspaceId).toBeNull();
    expect(await workspaceChecksum(database(), graces)).toBe(before);
  });

  it("includes the error-report DSN of the deployment's source for a session, and no field when there is none", async () => {
    const ada = await seedAccount(database());
    const browser = await signIn(ada);
    expect((await me(serve({ clientErrorReport: true }), browser)).clientErrorReportDsn).toBe(DSN);
    expect(Object.keys(await me(serve(), browser))).not.toContain("clientErrorReportDsn");
  });

  it("answers an API token with the workspace it is bound to and never with the error-report DSN", async () => {
    const server = serve({ clientErrorReport: true });
    const ada = await seedAccount(database());
    const bound = await seedWorkspace(database(), { name: "Bound" });
    const other = await seedWorkspace(database(), { name: "Other" });
    await seedMembership(database(), { workspaceId: bound, accountId: ada.id, role: "admin" });
    await seedMembership(database(), { workspaceId: other, accountId: ada.id, role: "owner", lastActiveAt: new Date() });

    const body = await me(server, `Bearer token:${ada.id}:${bound}`);
    expect(body.activeWorkspaceId).toBe(bound);
    expect(body.memberships).toHaveLength(2);
    expect(Object.keys(body)).not.toContain("clientErrorReportDsn");
    const probe = await call(server, "/api/v1/workspace-probe", `Bearer token:${ada.id}:${bound}`);
    expect(await probe.json()).toEqual({ workspaceId: bound, memberId: ada.id, role: "admin" });
  });

  it("refuses a token bound to a workspace its account is not a member of", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const graces = await seedWorkspace(database());
    const response = await call(server, "/api/v1/me", `Bearer token:${ada.id}:${graces}`);
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe("unauthenticated");
  });

  it("answers 401 without a session", async () => {
    const response = await call(serve(), "/api/v1/me", null);
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe("unauthenticated");
  });
});

describe("a workspace operation", () => {
  it("is answered 404 not_found for a principal with no workspace, for a member operation and an admin one", async () => {
    const server = serve();
    const homeless = await seedAccount(database());
    const browser = await signIn(homeless);
    for (const path of ["/api/v1/workspace-probe", "/api/v1/admin-probe"]) {
      const response = await call(server, path, browser);
      expect(response.status, path).toBe(404);
      expect(await problemCode(response), path).toBe("not_found");
    }
  });

  it("reaches the handler with the resolved workspace, member and role, and refuses a role below the policy with 403", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const workspace = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: workspace, accountId: ada.id, role: "member" });
    const browser = await signIn(ada);
    const probe = await call(server, "/api/v1/workspace-probe", browser);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ workspaceId: workspace, memberId: ada.id, role: "member" });
    const refused = await call(server, "/api/v1/admin-probe", browser);
    expect(refused.status).toBe(403);
    expect(await problemCode(refused)).toBe("forbidden");
  });
});

describe("last_active_at", () => {
  it("is written by a session's request, and again only after a minute", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const workspace = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: workspace, accountId: ada.id });
    const browser = await signIn(ada);

    expect(await lastActiveAt(database(), workspace, ada.id)).toBeNull();
    await me(server, browser);
    const first = await lastActiveAt(database(), workspace, ada.id);
    expect(first).toBeInstanceOf(Date);

    await me(server, browser);
    await call(server, "/api/v1/workspace-probe", browser);
    expect(await lastActiveAt(database(), workspace, ada.id)).toEqual(first);

    await setLastActiveAt(database(), workspace, ada.id, new Date(Date.now() - 2 * MINUTE_MS));
    await me(server, browser);
    const renewed = await lastActiveAt(database(), workspace, ada.id);
    expect(renewed?.getTime()).toBeGreaterThan(Date.now() - 30_000);
  });

  it("is moved for the workspace the request resolved to, and in no other workspace's row", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const adas = await seedWorkspace(database());
    const graces = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: adas, accountId: ada.id });
    await seedMembership(database(), { workspaceId: graces, accountId: grace.id });
    const forged = await signIn(ada);
    await setActiveWorkspace(database(), forged.sessionId, graces);
    const before = await workspaceChecksum(database(), graces);

    await me(server, forged);
    expect(await lastActiveAt(database(), adas, ada.id)).toBeInstanceOf(Date);
    expect(await workspaceChecksum(database(), graces)).toBe(before);
  });

  it("is not written by an API token's request", async () => {
    const server = serve();
    const ada = await seedAccount(database());
    const workspace = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: workspace, accountId: ada.id });
    await me(server, `Bearer token:${ada.id}:${workspace}`);
    expect(await lastActiveAt(database(), workspace, ada.id)).toBeNull();
  });
});
