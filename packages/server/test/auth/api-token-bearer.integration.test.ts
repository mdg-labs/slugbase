import { randomBytes } from "node:crypto";
import { defineOperation, jsonResponse, operations, problemResponse } from "@slugbase/contracts";
import { generateApiToken } from "@slugbase/core";
import { apiTokenRepository, type AuthStore } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { route } from "../../src/routes/register.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter, type MemoryRateLimiter } from "../http/rate-limit-support.ts";
import { adapters, documentFor, recordingLogger, serverConfig } from "../support.ts";
import { disableAccount, LOGIN, removeMembership, seedAccount, seedMembership, seedWorkspace, serveAuth, sha256, storeFor, workspaceChecksum, type SeededAccount } from "./support.ts";

// The bearer credential through the whole chain over the migrated database (doc
// 04 sections 4.1 and 4.2, doc 01 section 4 stages 4 and 7, doc 05 section 3.3,
// doc 10 T3, T4, T18 and 2.12). The failure scenarios: a leaked token that keeps
// working after revocation, expiry, a disabled account or the end of its
// membership; one that acts in a workspace other than its own or with a role the
// account no longer has; one that reaches token management, the password, the
// email, MFA or the sessions; a cookie that decides a request which carries a
// bearer header; and a refusal that tells the reason a token was refused.

const SESSION_COOKIE = "__Host-slugbase_session";
const MINUTE_MS = 60_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

const readProbe = defineOperation({
  method: "get",
  path: "/api/v1/workspace-probe",
  operationId: "probeWorkspace",
  tag: "test",
  auth: "member",
  scope: "read",
  rate: "read",
  responses: {
    200: jsonResponse("the workspace of the request", z.strictObject({ workspaceId: z.uuid(), accountId: z.uuid(), role: z.string() })),
    404: problemResponse("no workspace"),
  },
});

const writeProbe = defineOperation({
  method: "post",
  path: "/api/v1/workspace-probe",
  operationId: "writeWorkspaceProbe",
  tag: "test",
  auth: "member",
  scope: "write",
  rate: "write",
  request: { body: z.strictObject({}) },
  responses: { 200: jsonResponse("done", z.strictObject({})), 404: problemResponse("no workspace") },
});

const adminProbe = defineOperation({
  method: "get",
  path: "/api/v1/admin-probe",
  operationId: "probeAdmin",
  tag: "test",
  auth: "admin",
  scope: "read",
  rate: "read",
  responses: { 200: jsonResponse("ok", z.strictObject({})), 404: problemResponse("no workspace"), 403: problemResponse("too low") },
});

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
  readonly limiter: MemoryRateLimiter;
}

function serve(env: Record<string, string> = {}): World {
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), TRUSTED_PROXY_HOPS: "1", ...env });
  const limiter = memoryRateLimiter(createRateLimitRegistry(config));
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), rateLimit: limiter, tenantResolver: createAccountOnlyTenantResolver() },
    modules: [
      {
        name: "probes",
        register: () => ({
          routes: [
            route(readProbe).handle((_request, context) => {
              const tenant = context.get("tenant");
              if (tenant === undefined) {
                throw new Error("the authorization stage let a request without a workspace through");
              }
              return { status: 200, body: { workspaceId: tenant.workspaceId, accountId: tenant.accountId, role: tenant.role } };
            }),
            route(writeProbe).handle(() => ({ status: 200, body: {} })),
            route(adminProbe).handle(() => ({ status: 200, body: {} })),
          ],
        }),
      },
    ],
    openApiDocument: documentFor([readProbe, writeProbe, adminProbe]),
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, logs, limiter };
}

interface Issued {
  readonly value: string;
  readonly id: string;
}

interface Holder {
  readonly account: SeededAccount;
  readonly workspaceId: string;
}

/** An account that owns a workspace of its own. */
async function holder(role: "owner" | "admin" | "member" = "owner"): Promise<Holder> {
  const account = await seedAccount(database());
  const workspaceId = await seedWorkspace(database());
  await seedMembership(database(), { workspaceId, accountId: account.id, role });
  return { account, workspaceId };
}

let tokenNumber = 0;

async function issue(as: Holder, options: { scope?: "read" | "read-write"; workspaceId?: string; expiresInDays?: number | null } = {}): Promise<Issued> {
  tokenNumber += 1;
  const token = generateApiToken();
  const id = `0192f3a0-eeee-7000-8000-${tokenNumber.toString(16).padStart(12, "0")}`;
  const outcome = await tenantDatabase(database()).withTenant({ accountId: as.account.id, requestId: "bearer-test" }, (tx) =>
    apiTokenRepository(tx).create({
      id,
      workspaceId: options.workspaceId ?? as.workspaceId,
      name: `token ${String(tokenNumber)}`,
      scope: options.scope ?? "read",
      tokenHash: token.hash,
      tokenPrefix: token.displayPrefix,
      expiresInDays: options.expiresInDays === undefined ? 90 : options.expiresInDays,
      limit: 10,
    }),
  );
  expect(outcome.kind).toBe("created");
  return { value: token.value, id };
}

async function signIn(as: Holder): Promise<{ cookie: string; sessionId: string }> {
  const token = randomBytes(32);
  const sessionId = `0192f3a0-dddd-7000-8000-${randomBytes(6).toString("hex")}`;
  const created = await store.createSession({
    id: sessionId,
    accountId: as.account.id,
    level: "full",
    remember: false,
    ipPrefix: null,
    userAgent: null,
    tokenHash: sha256(token),
    replacedTokenHash: null,
  });
  expect(created).toBe(true);
  return { cookie: `${SESSION_COOKIE}=${token.toString("base64url")}`, sessionId };
}

function call(world: World, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const merged = { "x-forwarded-for": "198.51.100.7", ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) };
  return world.server.fetch(new Request(new URL(path, world.origin), { method, headers: merged, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

const bearer = (token: string | Issued) => ({ authorization: `Bearer ${typeof token === "string" ? token : token.value}` });

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: unknown;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

async function tokenRows(accountId: string): Promise<{ id: string; revoked_at: Date | null; last_used_at: Date | null; last_used_ip_prefix: string | null }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string; revoked_at: Date | null; last_used_at: Date | null; last_used_ip_prefix: string | null }[]>`
      SELECT id, revoked_at, last_used_at, last_used_ip_prefix::text AS last_used_ip_prefix FROM api_tokens WHERE account_id = ${accountId} ORDER BY id`;
  });
  return [...rows];
}

// Each runs as slugbase_system, which stands for the system operation that would make the change.
async function expireToken(id: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${id}`;
  });
}

async function startDeleting(workspaceId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspaceId}`;
  });
}

async function setRole(workspaceId: string, accountId: string, role: "owner" | "admin" | "member"): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_members SET role = ${role} WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
}

async function ageLastUse(id: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE api_tokens SET last_used_at = last_used_at - interval '2 minutes' WHERE id = ${id}`;
  });
}

describe("GET /api/v1/me with Authorization: Bearer", () => {
  it("acts as the account in the workspace the token is bound to", async () => {
    const world = serve();
    const alice = await holder();
    const token = await issue(alice);
    const response = await call(world, "GET", "/api/v1/me", bearer(token));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { account: { id: string; email: string }; activeWorkspaceId: string | null; memberships: { workspaceId: string }[]; clientErrorReportDsn?: string };
    expect(body.account).toMatchObject({ id: alice.account.id, email: alice.account.email });
    expect(body.activeWorkspaceId).toBe(alice.workspaceId);
    expect(body.memberships.map((membership) => membership.workspaceId)).toEqual([alice.workspaceId]);
    expect(body).not.toHaveProperty("clientErrorReportDsn");
  });

  it("is declared token-callable with the read scope in the contract the server publishes", () => {
    const declared = operations.find((operation) => operation.operationId === "getMe");
    expect(declared?.scope).toBe("read");
  });

  it("logs the request as an API-token request and never the token or its hash", async () => {
    const world = serve();
    const alice = await holder();
    const token = await issue(alice);
    expect((await call(world, "GET", "/api/v1/me", bearer(token))).status).toBe(200);
    expect((await call(world, "GET", "/api/v1/me", bearer(`${token.value.slice(0, -1)}${token.value.endsWith("A") ? "B" : "A"}`))).status).toBe(401);
    expect(world.logs.requests.map((line) => line.fields["principalType"])).toContain("api-token");
    const everything = JSON.stringify([world.logs.entries, world.logs.requests]);
    expect(everything).not.toContain(token.value);
    expect(everything).not.toContain(token.value.slice(4));
    expect(everything).not.toContain(sha256(Buffer.from(token.value, "utf8")).toString("hex"));
  });
});

describe("an Authorization header and the cookies", () => {
  it("ignores a valid session cookie entirely: an invalid bearer is 401 unauthenticated", async () => {
    const world = serve();
    const alice = await holder();
    const { cookie } = await signIn(alice);
    expect((await call(world, "GET", "/api/v1/me", { cookie })).status).toBe(200);
    const never = generateApiToken().value;
    for (const authorization of [`Bearer ${never}`, "Bearer ", "Bearer x", "Basic YWxpY2U6c2VjcmV0", "Token abc"]) {
      const response = await call(world, "GET", "/api/v1/me", { cookie, authorization });
      expect(response.status).toBe(401);
      expect((await problemOf(response)).code).toBe("unauthenticated");
    }
  });

  it("acts as the token's account when the cookie belongs to another account", async () => {
    const world = serve();
    const alice = await holder();
    const bob = await holder();
    const { cookie } = await signIn(bob);
    const token = await issue(alice);
    const body = (await (await call(world, "GET", "/api/v1/me", { cookie, ...bearer(token) })).json()) as { account: { id: string }; activeWorkspaceId: string };
    expect(body.account.id).toBe(alice.account.id);
    expect(body.activeWorkspaceId).toBe(alice.workspaceId);
  });
});

describe("a token that is not accepted", () => {
  it("answers the same 401 unauthenticated for an unknown, revoked, expired and disabled-account token, and one of the wrong shape", async () => {
    const world = serve();
    const alice = await holder();
    const bob = await holder();
    const revoked = await issue(alice);
    const expired = await issue(alice);
    const disabled = await issue(bob);
    const live = await issue(alice);
    expect((await call(world, "GET", "/api/v1/me", bearer(live))).status).toBe(200);

    await tenantDatabase(database()).withTenant({ accountId: alice.account.id, requestId: "bearer-test" }, (tx) => apiTokenRepository(tx).revoke(revoked.id));
    await expireToken(expired.id);
    await disableAccount(database(), bob.account.id);

    const refusals: Problem[] = [];
    for (const credential of [generateApiToken().value, revoked.value, expired.value, disabled.value, "slb_short", `slb_${"A".repeat(44)}`, "nonsense"]) {
      const response = await call(world, "GET", "/api/v1/me", bearer(credential));
      expect(response.status).toBe(401);
      refusals.push(await problemOf(response));
    }
    expect(refusals.every((problem) => problem.code === "unauthenticated")).toBe(true);
    expect(new Set(refusals.map((problem) => JSON.stringify({ ...problem, instance: undefined, requestId: undefined }))).size).toBe(1);
    // A token that was not accepted records no use.
    for (const id of [revoked.id, expired.id]) {
      expect((await tokenRows(alice.account.id)).find((row) => row.id === id)?.last_used_at).toBeNull();
    }
    expect((await call(world, "GET", "/api/v1/me", bearer(live))).status).toBe(200);
  });

  it("stops a token on its next request when it is revoked, expires, its account is disabled or its membership ends", async () => {
    const world = serve();
    const carol = await holder();
    const dave = await holder();
    const erin = await holder();
    const frank = await holder();
    const revoked = await issue(carol);
    const expiring = await issue(dave);
    const disabled = await issue(erin);
    const leaving = await issue(frank);
    for (const token of [revoked, expiring, disabled, leaving]) {
      expect((await call(world, "GET", "/api/v1/me", bearer(token))).status).toBe(200);
    }

    await tenantDatabase(database()).withTenant({ accountId: carol.account.id, requestId: "bearer-test" }, (tx) => apiTokenRepository(tx).revoke(revoked.id));
    await expireToken(expiring.id);
    await disableAccount(database(), erin.account.id);
    await removeMembership(database(), frank.workspaceId, frank.account.id);

    for (const token of [revoked, expiring, disabled, leaving]) {
      const response = await call(world, "GET", "/api/v1/me", bearer(token));
      expect(response.status).toBe(401);
      expect((await problemOf(response)).code).toBe("unauthenticated");
    }
    // Losing the membership deleted the token with it; revocation keeps the row.
    expect(await tokenRows(frank.account.id)).toEqual([]);
    expect((await tokenRows(carol.account.id)).map((row) => row.revoked_at !== null)).toEqual([true]);
  });

  it("stops the tokens of a workspace that is being deleted", async () => {
    const world = serve();
    const alice = await holder();
    const token = await issue(alice);
    expect((await call(world, "GET", "/api/v1/me", bearer(token))).status).toBe(200);
    await startDeleting(alice.workspaceId);
    expect((await call(world, "GET", "/api/v1/me", bearer(token))).status).toBe(401);
  });

  it("keeps the token of another workspace working when the membership of one ends", async () => {
    const world = serve();
    const alice = await holder();
    const second = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: second, accountId: alice.account.id, role: "member" });
    const first = await issue(alice);
    const other = await issue(alice, { workspaceId: second });
    await removeMembership(database(), second, alice.account.id);
    expect((await call(world, "GET", "/api/v1/me", bearer(other))).status).toBe(401);
    expect((await call(world, "GET", "/api/v1/me", bearer(first))).status).toBe(200);
  });
});

describe("the workspace and the role of a token", () => {
  it("acts only in the bound workspace, whatever the account's other workspaces, its session's active workspace and an X-Slugbase-Workspace header say", async () => {
    const world = serve();
    const alice = await holder();
    const second = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: second, accountId: alice.account.id, role: "owner" });
    const before = await workspaceChecksum(database(), second);
    const token = await issue(alice);
    const { cookie } = await signIn(alice);

    const plain = await call(world, "GET", "/api/v1/workspace-probe", bearer(token));
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ workspaceId: alice.workspaceId, accountId: alice.account.id });
    const extras: Record<string, string>[] = [{ "x-slugbase-workspace": second }, { "X-Slugbase-Workspace": second.toUpperCase() }, { cookie }];
    for (const headers of extras) {
      const response = await call(world, "GET", "/api/v1/workspace-probe", { ...bearer(token), ...headers });
      expect(await response.json()).toMatchObject({ workspaceId: alice.workspaceId });
    }
    const otherToken = await issue(alice, { workspaceId: second });
    expect(await (await call(world, "GET", "/api/v1/workspace-probe", bearer(otherToken))).json()).toMatchObject({ workspaceId: second });
    expect(await workspaceChecksum(database(), second)).toBe(before);
  });

  it("uses the account's current role in the workspace, read again on each request", async () => {
    const world = serve();
    const alice = await holder("member");
    const token = await issue(alice);
    const role = async (): Promise<string> => ((await (await call(world, "GET", "/api/v1/workspace-probe", bearer(token))).json()) as { role: string }).role;

    expect(await role()).toBe("member");
    expect((await call(world, "GET", "/api/v1/admin-probe", bearer(token))).status).toBe(403);
    await setRole(alice.workspaceId, alice.account.id, "admin");
    expect(await role()).toBe("admin");
    expect((await call(world, "GET", "/api/v1/admin-probe", bearer(token))).status).toBe(200);
    await setRole(alice.workspaceId, alice.account.id, "member");
    expect(await role()).toBe("member");
    expect((await call(world, "GET", "/api/v1/admin-probe", bearer(token))).status).toBe(403);
  });
});

describe("the scope of a token", () => {
  it("answers 403 token_scope to a read token on a mutating operation and lets a read-write token through", async () => {
    const world = serve();
    const alice = await holder();
    const read = await issue(alice, { scope: "read" });
    const write = await issue(alice, { scope: "read-write" });
    const refused = await call(world, "POST", "/api/v1/workspace-probe", bearer(read), {});
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("token_scope");
    expect((await call(world, "POST", "/api/v1/workspace-probe", bearer(write), {})).status).toBe(200);
    expect((await call(world, "GET", "/api/v1/workspace-probe", bearer(read))).status).toBe(200);
  });

  it("answers 415 unsupported_media_type to a bearer mutation whose body is not application/json", async () => {
    const world = serve();
    const alice = await holder();
    const write = await issue(alice, { scope: "read-write" });
    const response = await world.server.fetch(
      new Request(new URL("/api/v1/workspace-probe", world.origin), { method: "POST", headers: { ...bearer(write), "content-type": "text/plain" }, body: "{}" }),
    );
    expect(response.status).toBe(415);
    expect((await problemOf(response)).code).toBe("unsupported_media_type");
  });

  it("validates the body of a bearer mutation against the operation's schema", async () => {
    const world = serve();
    const alice = await holder();
    const write = await issue(alice, { scope: "read-write" });
    const response = await call(world, "POST", "/api/v1/workspace-probe", bearer(write), { unexpected: true });
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe("validation_failed");
  });
});

describe("what a leaked token cannot do", () => {
  // The operations of doc 02 section 2.9 and doc 10 T18: each declares no token scope, so a bearer
  // request is refused as forbidden before its handler runs. The bodies are valid, so it is the policy that answers.
  const REFUSED: readonly { readonly id: string; readonly method: string; readonly path: string; readonly body?: unknown }[] = [
    { id: "createApiToken", method: "POST", path: "/api/v1/me/api-tokens", body: { name: "minted", scope: "read-write" } },
    { id: "listApiTokens", method: "GET", path: "/api/v1/me/api-tokens" },
    { id: "revokeApiToken", method: "DELETE", path: "/api/v1/me/api-tokens/0192f3a0-ffff-7000-8000-000000000001" },
    { id: "changePassword", method: "POST", path: "/api/v1/me/password", body: { currentPassword: "a long password number 1", newPassword: "another long password 2026" } },
    { id: "reauthenticate", method: "POST", path: "/api/v1/me/reauth", body: { password: "a long password number 1" } },
    { id: "startMfaEnrollment", method: "POST", path: "/api/v1/me/mfa/enrollment" },
    { id: "confirmMfaEnrollment", method: "POST", path: "/api/v1/me/mfa/enrollment/confirm", body: { code: "123456" } },
    { id: "regenerateMfaBackupCodes", method: "POST", path: "/api/v1/me/mfa/backup-codes", body: { code: "123456" } },
    { id: "disableMfa", method: "DELETE", path: "/api/v1/me/mfa", body: { password: "a long password number 1", code: "123456" } },
    { id: "listSessions", method: "GET", path: "/api/v1/me/sessions" },
    { id: "revokeSession", method: "DELETE", path: "/api/v1/me/sessions/0192f3a0-ffff-7000-8000-000000000002" },
    { id: "revokeSessions", method: "DELETE", path: "/api/v1/me/sessions?includeCurrent=true" },
    { id: "updateMe", method: "PATCH", path: "/api/v1/me", body: { displayName: "Taken over" } },
    { id: "logout", method: "POST", path: "/api/v1/auth/logout" },
    { id: "verifyMfa", method: "POST", path: "/api/v1/auth/mfa/verify", body: { code: "123456" } },
  ];

  it("declares none of them token-callable", () => {
    for (const { id } of REFUSED) {
      const declared = operations.find((operation) => operation.operationId === id);
      expect(declared, id).toBeDefined();
      expect(declared?.scope, id).toBeUndefined();
    }
  });

  it("answers each 403 forbidden with a read-write token and changes nothing", async () => {
    const world = serve();
    const alice = await holder();
    const { cookie, sessionId } = await signIn(alice);
    const existing = await issue(alice, { scope: "read" });
    const leaked = await issue(alice, { scope: "read-write" });
    const sessionsBefore = await store.listSessions(alice.account.id, null, 50);
    const hashBefore = await store.passwordHashOf(alice.account.id);
    const tokensBefore = await tokenRows(alice.account.id);

    for (const { id, method, path, body } of REFUSED) {
      const response = await call(world, method, path, { ...bearer(leaked), origin: world.origin }, body);
      expect(response.status, id).toBe(403);
      expect((await problemOf(response)).code, id).toBe("forbidden");
      expect(response.headers.get("set-cookie"), id).toBeNull();
    }

    expect((await store.listSessions(alice.account.id, null, 50)).map((session) => session.id)).toEqual(sessionsBefore.map((session) => session.id));
    expect(sessionsBefore.map((session) => session.id)).toContain(sessionId);
    expect(await store.passwordHashOf(alice.account.id)).toBe(hashBefore);
    expect((await tokenRows(alice.account.id)).map((row) => [row.id, row.revoked_at])).toEqual(tokensBefore.map((row) => [row.id, row.revoked_at]));
    expect(tokensBefore.map((row) => row.id).sort()).toEqual([existing.id, leaked.id].sort());
    // The browser session of the account is untouched and still works.
    expect((await call(world, "GET", "/api/v1/me", { cookie })).status).toBe(200);
  });

  it("answers 403 forbidden, not 422, to a token request with an empty or invalid body on an operation it may not call", async () => {
    const world = serve();
    const alice = await holder();
    const leaked = await issue(alice, { scope: "read-write" });
    const attempts: readonly { readonly path: string; readonly body: unknown }[] = [
      { path: "/api/v1/me/password", body: {} },
      { path: "/api/v1/me/password", body: { unexpected: true } },
      { path: "/api/v1/me/api-tokens", body: {} },
      { path: "/api/v1/me/api-tokens", body: { name: "", scope: "root" } },
    ];
    for (const { path, body } of attempts) {
      const response = await call(world, "POST", path, { ...bearer(leaked), origin: world.origin }, body);
      expect(response.status, path).toBe(403);
      expect((await problemOf(response)).code, path).toBe("forbidden");
    }
    // Without a body at all the answer is the same.
    const bodiless = await call(world, "POST", "/api/v1/me/password", { ...bearer(leaked), origin: world.origin });
    expect(bodiless.status).toBe(403);
    expect((await problemOf(bodiless)).code).toBe("forbidden");
    // The same invalid body on a session is still a validation failure: the session path is unchanged.
    const { cookie } = await signIn(alice);
    const session = await call(world, "POST", "/api/v1/me/password", { cookie, origin: world.origin }, {});
    expect(session.status).toBe(422);
    expect((await problemOf(session)).code).toBe("validation_failed");
  });

  it("answers a read token the same 403 forbidden on token management", async () => {
    const world = serve();
    const alice = await holder();
    const read = await issue(alice, { scope: "read" });
    const response = await call(world, "POST", "/api/v1/me/api-tokens", { ...bearer(read), origin: world.origin }, { name: "minted", scope: "read" });
    expect(response.status).toBe(403);
    expect((await problemOf(response)).code).toBe("forbidden");
  });

  it("cannot act in another account's workspace", async () => {
    const world = serve();
    const alice = await holder();
    const bob = await holder();
    const bobBefore = await workspaceChecksum(database(), bob.workspaceId);
    const token = await issue(alice, { scope: "read-write" });
    const probe = (await (await call(world, "GET", "/api/v1/workspace-probe", { ...bearer(token), "x-slugbase-workspace": bob.workspaceId })).json()) as { workspaceId: string };
    expect(probe.workspaceId).toBe(alice.workspaceId);
    expect((await call(world, "POST", "/api/v1/workspace-probe", { ...bearer(token), "x-slugbase-workspace": bob.workspaceId }, {})).status).toBe(200);
    expect(await workspaceChecksum(database(), bob.workspaceId)).toBe(bobBefore);
  });

});

describe("an anonymous operation reached with a bearer token", () => {
  // On an `anonymous` or `machine` operation the token checks of stages 8 and 9 do not apply and the handler
  // does not read the principal (doc 04 section 1.2); the request is still a bearer request for the earlier
  // stages, and an unrecognised Authorization header is still refused by authentication.
  it("answers GET /api/config with the same document as without a token, not 403 forbidden", async () => {
    const world = serveAuth(database(), store);
    const alice = await holder();
    const leaked = await issue(alice, { scope: "read-write" });
    const anonymous = await call(world, "GET", "/api/config", {});
    const withToken = await call(world, "GET", "/api/config", bearer(leaked));
    expect(anonymous.status).toBe(200);
    expect(withToken.status).toBe(200);
    expect(await withToken.json()).toEqual(await anonymous.json());
  });

  it("signs in on POST /api/v1/auth/login as the credentials say, never as the token's account", async () => {
    const world = serveAuth(database(), store);
    const alice = await holder();
    const leaked = await issue(alice, { scope: "read-write" });
    const wrong = { email: alice.account.email, password: "not the password of this account", remember: false };
    const withoutToken = await call(world, "POST", LOGIN, { origin: world.origin }, wrong);
    const withToken = await call(world, "POST", LOGIN, { ...bearer(leaked), origin: world.origin }, wrong);
    expect(withoutToken.status).toBe(401);
    expect(withToken.status).toBe(401);
    expect((await problemOf(withToken)).code).toBe("unauthenticated");
    expect(withToken.headers.get("set-cookie")).toBeNull();
    // A sign-in for another account with the right password is that account's, whatever the token's account is.
    const bob = await holder();
    const signedIn = await call(world, "POST", LOGIN, { ...bearer(leaked), origin: world.origin }, { email: bob.account.email, password: bob.account.password, remember: false });
    expect(signedIn.status).toBe(200);
    const sessions = await store.listSessions(alice.account.id, null, 50);
    expect(sessions).toEqual([]);
    expect((await store.listSessions(bob.account.id, null, 50)).length).toBe(1);
  });

  it("skips the cross-site check on POST /api/v1/auth/login for a valid token, which an anonymous request does not", async () => {
    const world = serveAuth(database(), store);
    const alice = await holder();
    const leaked = await issue(alice, { scope: "read-write" });
    const wrong = { email: alice.account.email, password: "not the password of this account", remember: false };
    const origins: Record<string, string>[] = [{}, { origin: "https://elsewhere.example" }];
    for (const headers of origins) {
      const withoutToken = await call(world, "POST", LOGIN, headers, wrong);
      expect(withoutToken.status).toBe(403);
      expect((await problemOf(withoutToken)).code).toBe("cross_site_request");
      const withToken = await call(world, "POST", LOGIN, { ...bearer(leaked), ...headers }, wrong);
      expect(withToken.status).toBe(401);
      expect((await problemOf(withToken)).code).toBe("unauthenticated");
    }
  });

  it("still answers 401 unauthenticated to an unrecognised Authorization header", async () => {
    const world = serveAuth(database(), store);
    const response = await call(world, "GET", "/api/config", bearer(generateApiToken().value));
    expect(response.status).toBe(401);
    expect((await problemOf(response)).code).toBe("unauthenticated");
  });
});

describe("a request with a bearer token and the cross-site check", () => {
  it("is not asked for an Origin, while the same request on a session is", async () => {
    const world = serve();
    const alice = await holder();
    const write = await issue(alice, { scope: "read-write" });
    const { cookie } = await signIn(alice);
    expect((await call(world, "POST", "/api/v1/workspace-probe", bearer(write), {})).status).toBe(200);
    expect((await call(world, "POST", "/api/v1/workspace-probe", { ...bearer(write), origin: "https://elsewhere.example" }, {})).status).toBe(200);
    const withSession = await call(world, "POST", "/api/v1/workspace-probe", { cookie }, {});
    expect(withSession.status).toBe(403);
    expect((await problemOf(withSession)).code).toBe("cross_site_request");
  });
});

describe("the rate limits of a token request", () => {
  it("are counted per account, shared with the account's other credentials and not with another account's", async () => {
    const world = serve({ RATE_LIMIT_READ_ACCOUNT: "3/hour", RATE_LIMIT_READ_IP: "1000/hour" });
    const alice = await holder();
    const bob = await holder();
    const first = await issue(alice);
    const second = await issue(alice);
    const other = await issue(bob);
    const { cookie } = await signIn(alice);

    expect((await call(world, "GET", "/api/v1/me", bearer(first))).status).toBe(200);
    expect((await call(world, "GET", "/api/v1/me", bearer(second))).status).toBe(200);
    expect((await call(world, "GET", "/api/v1/me", { cookie })).status).toBe(200);
    const limited = await call(world, "GET", "/api/v1/me", bearer(first));
    expect(limited.status).toBe(429);
    expect((await problemOf(limited)).code).toBe("rate_limited");
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect((await call(world, "GET", "/api/v1/me", { cookie })).status).toBe(429);
    expect((await call(world, "GET", "/api/v1/me", bearer(other))).status).toBe(200);

    const accountTakes = world.limiter.takes.filter((take) => take.key === alice.account.id);
    expect(accountTakes.length).toBeGreaterThanOrEqual(4);
    expect(world.limiter.takes.some((take) => take.key.includes(first.value) || take.key.includes(second.value))).toBe(false);
  });

  it("take the per-IP bucket before the token is looked up, so a flood of bad tokens is throttled", async () => {
    const world = serve({ RATE_LIMIT_READ_ACCOUNT: "10/hour", RATE_LIMIT_READ_IP: "10/hour" });
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await call(world, "GET", "/api/v1/me", bearer(generateApiToken().value))).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("the last use of a token", () => {
  it("is written with the coarse network of the client, at most once a minute", async () => {
    const world = serve();
    const alice = await holder();
    const token = await issue(alice);
    expect((await tokenRows(alice.account.id))[0]?.last_used_at).toBeNull();

    const before = Date.now();
    expect((await call(world, "GET", "/api/v1/me", { ...bearer(token), "x-forwarded-for": "198.51.100.7" })).status).toBe(200);
    const first = (await tokenRows(alice.account.id))[0];
    expect(first?.last_used_ip_prefix).toBe("198.51.0.0/16");
    expect(Math.abs((first?.last_used_at?.getTime() ?? 0) - before)).toBeLessThan(MINUTE_MS);

    expect((await call(world, "GET", "/api/v1/me", { ...bearer(token), "x-forwarded-for": "203.0.113.9" })).status).toBe(200);
    expect((await tokenRows(alice.account.id))[0]).toEqual(first);

    await ageLastUse(token.id);
    expect((await call(world, "GET", "/api/v1/me", { ...bearer(token), "x-forwarded-for": "2001:db8:aa:bb::1" })).status).toBe(200);
    const again = (await tokenRows(alice.account.id))[0];
    expect(again?.last_used_ip_prefix).toBe("2001:db8:aa::/48");
    expect((again?.last_used_at?.getTime() ?? 0) - (first?.last_used_at?.getTime() ?? 0)).toBeGreaterThan(0);
  });

  it("is listed with the account's tokens", async () => {
    const world = serve();
    const alice = await holder();
    const token = await issue(alice);
    expect((await call(world, "GET", "/api/v1/me", bearer(token))).status).toBe(200);
    const { cookie } = await signIn(alice);
    const listed = (await (await call(world, "GET", "/api/v1/me/api-tokens", { cookie })).json()) as { items: { id: string; lastUsedAt: string | null }[] };
    expect(listed.items.find((item) => item.id === token.id)?.lastUsedAt).not.toBeNull();
  });
});
