import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { route } from "../../src/routes/register.ts";
import { removeMembership, seedAccount, seedMembership, seedWorkspace, sessionRows, setLastActiveAt, storeFor, workspaceChecksum, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, documentFor, recordingLogger, serverConfig } from "../support.ts";

// PUT /api/v1/session/active-workspace through the whole chain over the migrated database (doc 04 section
// 10.4, doc 02 section 3.5, doc 01 sections 4 and 5.1, doc 10 T1). The failure scenarios: an account that
// names a workspace it does not belong to (or one being deleted, or one that does not exist) learns nothing
// and keeps its previous workspace, a token that moves a session's workspace, a session moved by another
// origin, and a removed member whose very next request still resolves the workspace it lost.

const SWITCH = "/api/v1/session/active-workspace";
const ME = "/api/v1/me";
const PROBE = "/api/v1/workspace-probe";
const SESSION_COOKIE = "__Host-slugbase_session";
const HOOK_TIMEOUT_MS = 300_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
});

/** A workspace operation, to see which workspace a request acts in, and that it is answered 404 where there is none. */
const probe = defineOperation({
  method: "get",
  path: PROBE,
  operationId: "probeActiveWorkspace",
  tag: "test",
  auth: "member",
  scope: "read",
  rate: "read",
  responses: { 200: jsonResponse("the workspace of the request", z.strictObject({ workspaceId: z.uuid() })), 404: problemResponse("no workspace") },
});

/** An API token for an account and a workspace: `Bearer token:<account>:<workspace>`. */
const bearer: Authenticator = {
  credential: "bearer",
  authenticate: (authorization) => {
    const [, accountId, workspaceId] = /^Bearer token:([^:]+):([^:]+)$/.exec(authorization) ?? [];
    return Promise.resolve(accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", tokenId: "stub-token", accountId, workspaceId, scope: "read-write" });
  },
};

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_WRITE_IP: "1000/min",
    RATE_LIMIT_WRITE_ACCOUNT: "1000/min",
    RATE_LIMIT_READ_IP: "1000/min",
    RATE_LIMIT_READ_ACCOUNT: "1000/min",
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [
      {
        name: "probe",
        register: () => ({
          routes: [
            route(probe).handle((_request, context) => {
              const tenant = context.get("tenant");
              if (tenant === undefined) {
                throw new Error("the authorization stage let a request without a workspace through");
              }
              return { status: 200, body: { workspaceId: tenant.workspaceId } };
            }),
          ],
          authenticators: [bearer],
        }),
      },
    ],
    openApiDocument: documentFor([probe]),
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
}

function send(world: World, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { origin: world.origin, "content-type": "application/json", ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), init));
}

interface Person {
  readonly account: SeededAccount;
  readonly cookie: string;
  readonly sessionId: string;
}

async function person(world: World): Promise<Person> {
  const account = await seedAccount(database(), { emailVerified: true });
  const response = await send(world, "POST", "/api/v1/auth/login", {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const sessionId = (await sessionRows(database(), account.id))[0]?.id;
  if (sessionId === undefined) {
    throw new Error("the account has no session");
  }
  return { account, cookie: `${SESSION_COOKIE}=${token}`, sessionId };
}

/** An account that is a member of the workspaces it is given, the first the most recently active. */
async function memberOf(world: World, count: number): Promise<{ readonly as: Person; readonly workspaces: string[] }> {
  const as = await person(world);
  const workspaces: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: as.account.id, role: "owner", lastActiveAt: new Date(Date.now() - index * 3_600_000) });
    workspaces.push(workspaceId);
  }
  return { as, workspaces };
}

const switchTo = (world: World, as: Person, workspaceId: unknown, headers: Record<string, string> = {}) =>
  send(world, "PUT", SWITCH, { cookie: as.cookie, ...headers }, { workspaceId });

async function activeOf(world: World, as: Person): Promise<string | null> {
  const response = await send(world, "GET", ME, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { activeWorkspaceId: string | null }).activeWorkspaceId;
}

async function storedActive(as: Person): Promise<string | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ active_workspace_id: string | null }[]>`SELECT active_workspace_id FROM sessions WHERE id = ${as.sessionId}`;
  });
  return rows[0]?.active_workspace_id ?? null;
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** The problem without the members that differ between two requests. */
function shape(body: Record<string, unknown>): string {
  return JSON.stringify({ ...body, instance: undefined, requestId: undefined });
}

describe("PUT /api/v1/session/active-workspace", () => {
  it("moves the session to a workspace the account is a member of, answers 204, and the next request acts in it", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);
    const [recent, other] = workspaces;
    expect(await activeOf(world, as)).toBe(recent);

    const response = await switchTo(world, as, other);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await storedActive(as)).toBe(other);
    expect(await activeOf(world, as)).toBe(other);
    const probed = await send(world, "GET", PROBE, { cookie: as.cookie });
    expect(await probed.json()).toEqual({ workspaceId: other });
  });

  it("moves only the session that asked", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);
    const second = await send(world, "POST", "/api/v1/auth/login", {}, { email: as.account.email, password: as.account.password, remember: false });
    const secondCookie = /^(__Host-slugbase_session=[A-Za-z0-9_-]{43});/.exec(second.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect(secondCookie).not.toBe("");

    expect((await switchTo(world, as, workspaces[1])).status).toBe(204);

    const rows = await sessionRows(database(), as.account.id);
    expect(rows).toHaveLength(2);
    expect(await activeOf(world, { ...as, cookie: secondCookie })).toBe(workspaces[0]);
  });

  it("answers 404 not_found, never 403, for a workspace the account is not a member of, and the session keeps its workspace", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);
    const stranger = await seedAccount(database(), { emailVerified: true });
    const theirs = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: theirs, accountId: stranger.id, role: "owner" });
    expect((await switchTo(world, as, workspaces[1])).status).toBe(204);
    const before = await workspaceChecksum(database(), theirs);

    const response = await switchTo(world, as, theirs);

    expect(response.status).toBe(404);
    expect(await problem(response)).toMatchObject({ code: "not_found", status: 404 });
    expect(await storedActive(as)).toBe(workspaces[1]);
    expect(await activeOf(world, as)).toBe(workspaces[1]);
    expect(await workspaceChecksum(database(), theirs)).toBe(before);
  });

  it("answers a workspace that exists, one that does not and one being deleted in the same way, so the answer says nothing about which exist", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 1);
    const stranger = await seedAccount(database(), { emailVerified: true });
    const theirs = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: theirs, accountId: stranger.id, role: "owner" });
    const dying = await seedWorkspace(database(), { deleting: true });
    await seedMembership(database(), { workspaceId: dying, accountId: as.account.id, role: "owner" });
    const unknown = "0192f3a0-cccc-7000-8000-00000000ffff";

    const answers: string[] = [];
    for (const workspaceId of [theirs, unknown, dying]) {
      const response = await switchTo(world, as, workspaceId);
      expect(response.status).toBe(404);
      answers.push(shape(await problem(response)));
    }

    expect(new Set(answers).size).toBe(1);
    expect(await storedActive(as)).toBeNull();
    expect(await activeOf(world, as)).toBe(workspaces[0]);
  });

  it("does not let a removed member switch to the workspace it left", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);
    await removeMembership(database(), workspaces[1] ?? "", as.account.id);

    expect((await switchTo(world, as, workspaces[1])).status).toBe(404);
    expect(await storedActive(as)).toBeNull();
  });

  it("refuses an API token, whose operation declares no scope, and moves no session", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);

    const response = await send(world, "PUT", SWITCH, { authorization: `Bearer token:${as.account.id}:${workspaces[0] ?? ""}` }, { workspaceId: workspaces[1] });

    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: "forbidden" });
    expect(await storedActive(as)).toBeNull();
  });

  it("answers 401 without a session, and 403 cross_site_request from another origin, and moves nothing", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);

    const anonymous = await send(world, "PUT", SWITCH, {}, { workspaceId: workspaces[1] });
    const elsewhere = await switchTo(world, as, workspaces[1], { origin: "https://elsewhere.example" });

    expect(anonymous.status).toBe(401);
    expect(elsewhere.status).toBe(403);
    expect(await problem(elsewhere)).toMatchObject({ code: "cross_site_request" });
    expect(await storedActive(as)).toBeNull();
  });

  it("refuses a body that is not a workspace identifier or names more than that with 422", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);

    for (const body of [{ workspaceId: "not-a-uuid" }, { workspaceId: 7 }, { workspaceId: null }, {}, { workspaceId: workspaces[1], sessionId: as.sessionId }]) {
      const response = await send(world, "PUT", SWITCH, { cookie: as.cookie }, body);
      expect(response.status).toBe(422);
      expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    }
    expect(await storedActive(as)).toBeNull();
  });
});

describe("a workspace the account can no longer reach", () => {
  it("is not resolved on the very next request after the member is removed: the most recently active remaining membership is, then none", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 3);
    const [newest, middle, oldest] = workspaces;
    expect((await switchTo(world, as, oldest)).status).toBe(204);
    expect((await send(world, "GET", PROBE, { cookie: as.cookie })).status).toBe(200);
    expect(await activeOf(world, as)).toBe(oldest);

    await removeMembership(database(), oldest ?? "", as.account.id);
    expect(await activeOf(world, as)).toBe(newest);
    expect(await (await send(world, "GET", PROBE, { cookie: as.cookie })).json()).toEqual({ workspaceId: newest });

    await setLastActiveAt(database(), middle ?? "", as.account.id, new Date(Date.now() + 3_600_000));
    await removeMembership(database(), newest ?? "", as.account.id);
    expect(await activeOf(world, as)).toBe(middle);

    await removeMembership(database(), middle ?? "", as.account.id);
    expect(await activeOf(world, as)).toBeNull();
    const none = await send(world, "GET", PROBE, { cookie: as.cookie });
    expect(none.status).toBe(404);
    expect(await problem(none)).toMatchObject({ code: "not_found" });
  });

  it("is not resolved once its workspace is being deleted, and operations in a workspace answer 404 until the account has one", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 1);
    expect((await switchTo(world, as, workspaces[0])).status).toBe(204);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspaces[0] ?? ""}`;
    });

    expect(await activeOf(world, as)).toBeNull();
    expect((await send(world, "GET", PROBE, { cookie: as.cookie })).status).toBe(404);

    const fresh = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: fresh, accountId: as.account.id, role: "owner" });
    expect(await activeOf(world, as)).toBe(fresh);
    expect((await send(world, "GET", PROBE, { cookie: as.cookie })).status).toBe(200);
  });

  it("answers 404 to a switch to a workspace the account was removed from, and the session stays where it was", async () => {
    const world = serve();
    const { as, workspaces } = await memberOf(world, 2);
    expect((await switchTo(world, as, workspaces[1])).status).toBe(204);
    await removeMembership(database(), workspaces[1] ?? "", as.account.id);

    expect((await switchTo(world, as, workspaces[1])).status).toBe(404);
    expect(await activeOf(world, as)).toBe(workspaces[0]);
  });
});
