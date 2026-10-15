import { createHash } from "node:crypto";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { removeMembership, seedAccount, seedMembership, seedWorkspace, storeFor, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// The three operations of the personal API tokens through the whole chain over
// the migrated database (doc 04 section 10.3, doc 02 section 2.9, doc 10 T1,
// T4, T7 and T18). The failure scenarios: the secret surviving anywhere but the
// 201 response (the database, a list, the logs), a token request without a fresh
// re-authentication or with a bearer credential, another account's token that
// can be listed or revoked by its id, a token bound to a workspace the account
// does not belong to, and more than ten active tokens or one name twice.

const TOKENS = "/api/v1/me/api-tokens";
const REAUTH = "/api/v1/me/reauth";
const SESSION_COOKIE = "__Host-slugbase_session";
const DAY_MS = 86_400_000;
const SECRET = /^slb_[A-Za-z0-9_-]{43}$/;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

/** An API token for an account and a workspace: `Bearer token:<account>:<workspace>`. */
const bearer: Authenticator = {
  credential: "bearer",
  authenticate: (authorization) => {
    const [, accountId, workspaceId] = /^Bearer token:([^:]+):([^:]+)$/.exec(authorization) ?? [];
    return Promise.resolve(accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", accountId, workspaceId, scope: "read" });
  },
};

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
}

function serve(overrides: Record<string, string> = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    RATE_LIMIT_TOKEN_CREATE_IP: "1000/hour",
    RATE_LIMIT_TOKEN_CREATE_ACCOUNT: "1000/hour",
    ...overrides,
  });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [{ name: "bearer", register: () => ({ routes: [], authenticators: [bearer] }) }],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, logs };
}

function send(world: World, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  // A request that changes state must come from the app's own origin and be JSON, with or without a body.
  const init: RequestInit = { method, headers: { origin: world.origin, "content-type": "application/json", ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), init));
}

interface Person {
  readonly account: SeededAccount;
  readonly workspaceId: string;
  /** The cookie header of a full session that has re-authenticated. */
  readonly cookie: string;
  /** The cookie header of a full session that has not. */
  readonly stale: string;
}

async function signIn(world: World, account: SeededAccount, reauthenticate: boolean): Promise<string> {
  const response = await send(world, "POST", "/api/v1/auth/login", {}, { email: account.email, password: account.password, remember: false });
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const cookie = `${SESSION_COOKIE}=${token}`;
  if (reauthenticate) {
    expect((await send(world, "POST", REAUTH, { cookie }, { password: account.password })).status).toBe(204);
  }
  return cookie;
}

/** An account that is the owner of a workspace of its own, signed in twice. */
async function person(world: World, options: { workspace?: boolean } = {}): Promise<Person> {
  const account = await seedAccount(database());
  const workspaceId = await seedWorkspace(database());
  if (options.workspace !== false) {
    await seedMembership(database(), { workspaceId, accountId: account.id, role: "owner" });
  }
  return { account, workspaceId, cookie: await signIn(world, account, true), stale: await signIn(world, account, false) };
}

const create = (world: World, as: Person, body: Record<string, unknown>, cookie = as.cookie) => send(world, "POST", TOKENS, { cookie }, body);
const list = (world: World, as: Person, query = "") => send(world, "GET", `${TOKENS}${query}`, { cookie: as.cookie });
const revoke = (world: World, as: Person, id: string) => send(world, "DELETE", `${TOKENS}/${id}`, { cookie: as.cookie });

interface Created {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  scope: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  token: string;
}

async function created(world: World, as: Person, body: Record<string, unknown>): Promise<Created> {
  const response = await create(world, as, body);
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

interface Stored {
  id: string;
  token_hash: Buffer;
  token_prefix: string;
  workspace_id: string;
  account_id: string;
  revoked_at: Date | null;
}

async function storedRows(accountId: string): Promise<Stored[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Stored[]>`SELECT * FROM api_tokens WHERE account_id = ${accountId} ORDER BY id`;
  });
  return [...rows];
}

describe("POST /api/v1/me/api-tokens", () => {
  it("answers 201 with the token in the active workspace, a slb_ secret of 43 characters, its 6-character prefix and a 90-day expiry by default", async () => {
    const world = serve();
    const alice = await person(world);
    const before = Date.now();
    const response = await create(world, alice, { name: "CI", scope: "read" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = (await response.json()) as Created;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "prefix", "scope", "token", "workspaceId", "workspaceName"]);
    expect(body.token).toMatch(SECRET);
    expect(body).toMatchObject({ name: "CI", scope: "read", workspaceId: alice.workspaceId, workspaceName: expect.stringMatching(/^Workspace \d+$/) as unknown, prefix: body.token.slice(4, 10), lastUsedAt: null });
    expect(Math.abs(Date.parse(body.expiresAt ?? "") - (before + 90 * DAY_MS))).toBeLessThan(60_000);
  });

  it("honours 30, 365 and null for the expiry, and a workspace of the account that is not the active one", async () => {
    const world = serve();
    const alice = await person(world);
    const second = await seedWorkspace(database(), { name: "Second" });
    await seedMembership(database(), { workspaceId: second, accountId: alice.account.id });
    const now = Date.now();
    const thirty = await created(world, alice, { name: "thirty", scope: "read-write", expiresInDays: 30 });
    expect(Math.abs(Date.parse(thirty.expiresAt ?? "") - (now + 30 * DAY_MS))).toBeLessThan(60_000);
    expect(thirty.scope).toBe("read-write");
    const year = await created(world, alice, { name: "year", scope: "read", expiresInDays: 365 });
    expect(Math.abs(Date.parse(year.expiresAt ?? "") - (now + 365 * DAY_MS))).toBeLessThan(60_000);
    expect((await created(world, alice, { name: "forever", scope: "read", expiresInDays: null })).expiresAt).toBeNull();
    const bound = await created(world, alice, { name: "bound", scope: "read", workspaceId: second });
    expect(bound).toMatchObject({ workspaceId: second, workspaceName: "Second" });
    expect((await storedRows(alice.account.id)).find((row) => row.id === bound.id)?.workspace_id).toBe(second);
  });

  it("stores only the SHA-256 of the secret and its prefix, and the secret exists in no row, no list, no log line and no later response", async () => {
    const world = serve();
    const alice = await person(world);
    const token = await created(world, alice, { name: "CI", scope: "read" });
    const rows = await storedRows(alice.account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toEqual(createHash("sha256").update(token.token, "utf8").digest());
    expect(rows[0]?.token_prefix).toBe(token.prefix);
    const hashHex = rows[0]?.token_hash.toString("hex") ?? "";
    const hashBase64 = rows[0]?.token_hash.toString("base64") ?? "";

    expect(JSON.stringify(rows)).not.toContain(token.token);
    expect(JSON.stringify(rows)).not.toContain(token.token.slice(4));

    const listed = await (await list(world, alice)).text();
    const everywhere = [listed, JSON.stringify(world.logs.entries), JSON.stringify(world.logs.requests)];
    for (const text of everywhere) {
      expect(text).not.toContain(token.token);
      expect(text).not.toContain(token.token.slice(4));
      expect(text).not.toContain(hashHex);
      expect(text).not.toContain(hashBase64);
    }
    expect(world.logs.requests.length).toBeGreaterThan(0);
    // The refusals of the same operation carry no secret either.
    const refused = await (await create(world, alice, { name: "CI", scope: "read" })).text();
    expect(refused).not.toContain(token.token);
    expect(refused).not.toMatch(/slb_/);
  });

  it("draws a different secret for every token", async () => {
    const world = serve();
    const alice = await person(world);
    const first = await created(world, alice, { name: "one", scope: "read" });
    const second = await created(world, alice, { name: "two", scope: "read" });
    expect(first.token).not.toBe(second.token);
    expect(new Set((await storedRows(alice.account.id)).map((row) => row.token_hash.toString("hex"))).size).toBe(2);
  });

  it("answers 401 reauth_required without a fresh re-authentication, and stores nothing", async () => {
    const world = serve();
    const alice = await person(world);
    const response = await create(world, alice, { name: "CI", scope: "read" }, alice.stale);
    expect(response.status).toBe(401);
    expect((await problem(response))["code"]).toBe("reauth_required");
    expect(await storedRows(alice.account.id)).toEqual([]);
  });

  it("answers 401 unauthenticated without a session", async () => {
    const world = serve();
    const response = await send(world, "POST", TOKENS, {}, { name: "CI", scope: "read" });
    expect(response.status).toBe(401);
    expect((await problem(response))["code"]).toBe("unauthenticated");
  });

  it("answers 403 forbidden to an API token: a token cannot create tokens, list them or revoke them", async () => {
    const world = serve();
    const alice = await person(world);
    const existing = await created(world, alice, { name: "CI", scope: "read" });
    const authorization = { authorization: `Bearer token:${alice.account.id}:${alice.workspaceId}` };
    const attempts = [
      await send(world, "POST", TOKENS, authorization, { name: "minted", scope: "read-write" }),
      await send(world, "GET", TOKENS, authorization),
      await send(world, "DELETE", `${TOKENS}/${existing.id}`, authorization),
    ];
    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect((await problem(response))["code"]).toBe("forbidden");
    }
    const rows = await storedRows(alice.account.id);
    expect(rows.map((row) => [row.id, row.revoked_at])).toEqual([[existing.id, null]]);
  });

  it("answers 404 for a workspace the account is not a member of, one that does not exist, and when the request names none and acts in none, and stores nothing", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await person(world);
    const nowhere = await person(world, { workspace: false });
    for (const [as, workspaceId] of [
      [alice, bob.workspaceId],
      [alice, "0192f3a0-ffff-7000-8000-000000000001"],
      [nowhere, undefined],
    ] as const) {
      const response = await create(world, as, { name: "CI", scope: "read", ...(workspaceId === undefined ? {} : { workspaceId }) });
      expect(response.status).toBe(404);
      expect((await problem(response))["code"]).toBe("not_found");
    }
    expect(await storedRows(alice.account.id)).toEqual([]);
    expect(await storedRows(nowhere.account.id)).toEqual([]);
  });

  it("answers 404 for a workspace that is being deleted, even one the account belongs to", async () => {
    const world = serve();
    const alice = await person(world);
    const dying = await seedWorkspace(database(), { deleting: true });
    await seedMembership(database(), { workspaceId: dying, accountId: alice.account.id });
    expect((await create(world, alice, { name: "CI", scope: "read", workspaceId: dying })).status).toBe(404);
    expect(await storedRows(alice.account.id)).toEqual([]);
  });

  it("answers 409 name_taken for a name the account already has, and lets another account and a revoked name through", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await person(world);
    const first = await created(world, alice, { name: "CI", scope: "read" });
    const again = await create(world, alice, { name: "CI", scope: "read-write" });
    expect(again.status).toBe(409);
    expect((await problem(again))["code"]).toBe("name_taken");
    expect((await create(world, bob, { name: "CI", scope: "read" })).status).toBe(201);
    expect((await revoke(world, alice, first.id)).status).toBe(204);
    expect((await create(world, alice, { name: "CI", scope: "read" })).status).toBe(201);
  });

  it("answers 422 validation_failed with the field code api_token_limit_reached for the eleventh active token, and counts neither a revoked nor an expired one", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await person(world);
    const tokens: Created[] = [];
    for (let index = 0; index < 10; index += 1) {
      tokens.push(await created(world, alice, { name: `token ${String(index)}`, scope: "read" }));
    }
    const refused = await create(world, alice, { name: "eleventh", scope: "read" });
    expect(refused.status).toBe(422);
    const body = await problem(refused);
    expect(body["code"]).toBe("validation_failed");
    expect(body["errors"]).toEqual([{ path: "name", code: "api_token_limit_reached" }]);
    expect(await storedRows(alice.account.id)).toHaveLength(10);
    // The limit is the account's own.
    expect((await create(world, bob, { name: "bob", scope: "read" })).status).toBe(201);

    const first = tokens[0];
    expect((await revoke(world, alice, first?.id ?? "")).status).toBe(204);
    expect((await create(world, alice, { name: "eleventh", scope: "read" })).status).toBe(201);
    expect((await create(world, alice, { name: "twelfth", scope: "read" })).status).toBe(422);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE account_id = ${alice.account.id} AND name = 'token 1'`;
    });
    expect((await create(world, alice, { name: "twelfth", scope: "read" })).status).toBe(201);
  });

  it("answers 422 for an expiry other than 30, 90, 365 or null, a scope other than the two, a name outside 1 to 64 characters and a field it does not declare", async () => {
    const world = serve();
    const alice = await person(world);
    for (const body of [
      { name: "CI", scope: "read", expiresInDays: 7 },
      { name: "CI", scope: "read", expiresInDays: "90" },
      { name: "CI", scope: "admin" },
      { name: "CI" },
      { name: "", scope: "read" },
      { name: "   ", scope: "read" },
      { name: "x".repeat(65), scope: "read" },
      { name: "CI", scope: "read", accountId: alice.account.id },
      { name: "CI", scope: "read", workspaceId: "not-a-uuid" },
    ]) {
      const response = await create(world, alice, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await problem(response))["code"]).toBe("validation_failed");
    }
    expect(await storedRows(alice.account.id)).toEqual([]);
  });

  it("is limited by the token_create bucket, which takes a token for each request", async () => {
    const world = serve({ RATE_LIMIT_TOKEN_CREATE_IP: "2/hour", RATE_LIMIT_TOKEN_CREATE_ACCOUNT: "2/hour" });
    const alice = await person(world);
    expect((await create(world, alice, { name: "one", scope: "read" })).status).toBe(201);
    expect((await create(world, alice, { name: "two", scope: "read" })).status).toBe(201);
    const limited = await create(world, alice, { name: "three", scope: "read" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await problem(limited))["code"]).toBe("rate_limited");
    expect(await storedRows(alice.account.id)).toHaveLength(2);
    // The other operations are not in that bucket.
    expect((await list(world, alice)).status).toBe(200);
  });
});

describe("GET /api/v1/me/api-tokens", () => {
  it("lists the account's tokens across its workspaces, newest first, with no hash and no secret, and never another account's", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await person(world);
    const second = await seedWorkspace(database(), { name: "Second" });
    await seedMembership(database(), { workspaceId: second, accountId: alice.account.id });
    const one = await created(world, alice, { name: "one", scope: "read" });
    const two = await created(world, alice, { name: "two", scope: "read-write", workspaceId: second, expiresInDays: null });
    const others = await created(world, bob, { name: "bobs", scope: "read" });

    const response = await list(world, alice);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { items: Omit<Created, "token">[]; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual([two.id, one.id]);
    expect(body.items.map((item) => item.workspaceName)).toEqual(["Second", one.workspaceName]);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "prefix", "scope", "workspaceId", "workspaceName"]);
    }
    expect(text).not.toContain(others.id);
    expect(text).not.toMatch(/slb_/);
    expect(text).not.toContain(one.token.slice(4));
    expect(text.toLowerCase()).not.toContain("hash");
    expect(body.items.find((item) => item.id === two.id)?.expiresAt).toBeNull();
  });

  it("leaves out a revoked token, and the tokens of a workspace the account has left", async () => {
    const world = serve();
    const alice = await person(world);
    const second = await seedWorkspace(database(), { name: "Second" });
    await seedMembership(database(), { workspaceId: second, accountId: alice.account.id });
    const revoked = await created(world, alice, { name: "revoked", scope: "read" });
    const left = await created(world, alice, { name: "left", scope: "read", workspaceId: second });
    const kept = await created(world, alice, { name: "kept", scope: "read" });
    expect((await revoke(world, alice, revoked.id)).status).toBe(204);
    await removeMembership(database(), second, alice.account.id);
    const body = (await (await list(world, alice)).json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual([kept.id]);
    expect(body.items.map((item) => item.id)).not.toContain(left.id);
    expect((await storedRows(alice.account.id)).map((row) => row.id)).not.toContain(left.id);
  });

  it("pages with a limit and a cursor, and refuses a cursor that another account was issued", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await person(world);
    const ids: string[] = [];
    for (const name of ["a", "b", "c"]) {
      ids.push((await created(world, alice, { name, scope: "read" })).id);
    }
    const first = (await (await list(world, alice, "?limit=2")).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const second = (await (await list(world, alice, `?limit=2&cursor=${cursor}`)).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    const stolen = await list(world, bob, `?limit=2&cursor=${cursor}`);
    expect(stolen.status).toBe(400);
    expect((await problem(stolen))["code"]).toBe("bad_request");
    expect((await list(world, alice, "?limit=0")).status).toBe(422);
  });

  it("answers 401 without a session, and needs no re-authentication", async () => {
    const world = serve();
    const alice = await person(world);
    expect((await send(world, "GET", TOKENS, {})).status).toBe(401);
    expect((await send(world, "GET", TOKENS, { cookie: alice.stale })).status).toBe(200);
  });
});

describe("DELETE /api/v1/me/api-tokens/{id}", () => {
  it("revokes the account's token with 204, keeps the row revoked, and answers 204 again for a repeat", async () => {
    const world = serve();
    const alice = await person(world);
    const token = await created(world, alice, { name: "CI", scope: "read" });
    const response = await revoke(world, alice, token.id);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const [row] = await storedRows(alice.account.id);
    expect(row?.revoked_at).toBeInstanceOf(Date);
    expect((await revoke(world, alice, token.id)).status).toBe(204);
    expect((await storedRows(alice.account.id))[0]?.revoked_at).toEqual(row?.revoked_at);
  });

  it("answers 404 for another account's token and for an unknown id, and leaves the token active and listed for its owner", async () => {
    const world = serve();
    const alice = await person(world);
    const bob = await person(world);
    const token = await created(world, alice, { name: "CI", scope: "read" });
    for (const id of [token.id, "0192f3a0-ffff-7000-8000-000000000002"]) {
      const response = await revoke(world, bob, id);
      expect(response.status).toBe(404);
      expect((await problem(response))["code"]).toBe("not_found");
    }
    expect((await storedRows(alice.account.id)).map((row) => row.revoked_at)).toEqual([null]);
    const body = (await (await list(world, alice)).json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual([token.id]);
    const unlisted = (await (await list(world, bob)).json()) as { items: unknown[] };
    expect(unlisted.items).toEqual([]);
  });

  it("answers 422 for an identifier that is not a UUID and 401 without a session, and needs no re-authentication", async () => {
    const world = serve();
    const alice = await person(world);
    const token = await created(world, alice, { name: "CI", scope: "read" });
    expect((await revoke(world, alice, "not-a-uuid")).status).toBe(422);
    expect((await send(world, "DELETE", `${TOKENS}/${token.id}`, {})).status).toBe(401);
    expect((await send(world, "DELETE", `${TOKENS}/${token.id}`, { cookie: alice.stale })).status).toBe(204);
  });
});
