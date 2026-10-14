import { createHash } from "node:crypto";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Authenticator, type Server } from "../../src/create-server.ts";
import { seedAccount, seedMembership, seedWorkspace, sessionRows, storeFor, type SeededAccount } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

// PATCH /api/v1/me through the whole chain over the migrated database (doc 04
// section 10.3, doc 02 section 15, doc 10 T1 and T3): the failure scenarios are
// a body that reaches a column the profile does not own (the email, the instance
// admin flag, the account id), a request that changes an account other than the
// caller's, and a request that is accepted without a session of the application
// itself.

const ME = "/api/v1/me";
const SESSION_COOKIE = "__Host-slugbase_session";
const BLANK_NAME_DETAIL = "The request did not pass validation.";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

/** An API token with the read-write scope for an account and a workspace: `Bearer token:<account>:<workspace>`. */
const bearer: Authenticator = {
  credential: "bearer",
  authenticate: (authorization) => {
    const [, accountId, workspaceId] = /^Bearer token:([^:]+):([^:]+)$/.exec(authorization) ?? [];
    return Promise.resolve(accountId === undefined || workspaceId === undefined ? undefined : { kind: "api-token", accountId, workspaceId, scope: "read-write" });
  },
};

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(): World {
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()) });
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [{ name: "tokens", register: () => ({ routes: [], authenticators: [bearer] }) }],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
}

interface Browser {
  readonly token: string;
  readonly sessionId: string;
}

async function signIn({ server, origin }: World, account: SeededAccount): Promise<Browser> {
  const response = await server.fetch(
    new Request(new URL("/api/v1/auth/login", origin), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password, remember: false }),
    }),
  );
  const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const hash = createHash("sha256").update(Buffer.from(token, "base64url")).digest();
  const row = (await sessionRows(database(), account.id)).find((candidate) => candidate.token_hash.equals(hash));
  if (row === undefined) {
    throw new Error("the session row is missing");
  }
  return { token, sessionId: row.id };
}

interface Patch {
  readonly body?: unknown;
  readonly as?: Browser | string | null;
  readonly origin?: string | null;
  readonly contentType?: string;
}

function patch({ server, origin }: World, { body = {}, as = null, origin: sent = origin, contentType = "application/json" }: Patch): Promise<Response> {
  const headers = new Headers({ "content-type": contentType });
  if (typeof as === "string") {
    headers.set("authorization", as);
  } else if (as !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${as.token}`);
  }
  if (sent !== null) {
    headers.set("origin", sent);
  }
  return server.fetch(new Request(new URL(ME, origin), { method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

async function me({ server, origin }: World, as: Browser): Promise<{ account: Record<string, unknown> }> {
  const response = await server.fetch(new Request(new URL(ME, origin), { headers: { cookie: `${SESSION_COOKIE}=${as.token}` } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { account: Record<string, unknown> };
}

/** Every column of the account's row but `updated_at`, which a change moves. */
async function snapshot(id: string): Promise<Record<string, unknown>> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Record<string, unknown>[]>`SELECT * FROM accounts WHERE id = ${id}`;
  });
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the account row is missing");
  }
  return row;
}

async function problem(response: Response): Promise<{ code: string; detail: string; errors?: { path: string; code: string }[] }> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as { code: string; detail: string; errors?: { path: string; code: string }[] };
}

describe("PATCH /api/v1/me", () => {
  it("changes the display name and the language, answers the account and shows them on the next read", async () => {
    const world = serve();
    const ada = await seedAccount(database(), { emailVerified: true });
    const browser = await signIn(world, ada);

    const response = await patch(world, { as: browser, body: { displayName: "Ada Lovelace", locale: "de" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      id: ada.id,
      email: ada.email,
      displayName: "Ada Lovelace",
      locale: "de",
      theme: "system",
      accent: null,
      defaultView: "grid",
      aiOptOut: false,
      emailVerified: true,
      hasPassword: true,
    });
    expect(text).not.toMatch(/argon2|password_hash|passwordHash|token_hash/i);
    expect((await me(world, browser)).account).toMatchObject({ displayName: "Ada Lovelace", locale: "de" });
  });

  it("keeps a field the body leaves out, and an empty body changes nothing", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada);

    expect((await (await patch(world, { as: browser, body: { locale: "de" } })).json()) as object).toMatchObject({ displayName: "Test account", locale: "de" });
    expect((await (await patch(world, { as: browser, body: { displayName: "Renamed" } })).json()) as object).toMatchObject({ displayName: "Renamed", locale: "de" });

    const before = await snapshot(ada.id);
    const empty = await patch(world, { as: browser, body: {} });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ displayName: "Renamed", locale: "de" });
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it("removes the whitespace around the name and accepts the longest name", async () => {
    const world = serve();
    const browser = await signIn(world, await seedAccount(database()));
    expect(await (await patch(world, { as: browser, body: { displayName: "  Ada  " } })).json()).toMatchObject({ displayName: "Ada" });
    const longest = "x".repeat(100);
    expect(await (await patch(world, { as: browser, body: { displayName: longest } })).json()).toMatchObject({ displayName: longest });
  });

  it.each([
    ["the email", { email: "taken@example.test" }],
    ["the instance admin flag", { isInstanceAdmin: true }],
    ["the account id", { id: "0192f3a0-0000-7000-8000-0000000000a1" }],
    ["the password hash", { passwordHash: "x" }],
    ["a column of the profile that has its own operation", { theme: "dark" }],
    ["an unknown field beside a valid one", { displayName: "Valid", unknown: 1 }],
  ])("refuses a body that names %s with 422 validation_failed and changes nothing", async (_name, body) => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada);
    const before = await snapshot(ada.id);

    const response = await patch(world, { as: browser, body });

    expect(response.status).toBe(422);
    expect((await problem(response)).code).toBe("validation_failed");
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it.each([
    ["an empty name", { displayName: "" }],
    ["a name of 101 characters", { displayName: "x".repeat(101) }],
    ["a null name", { displayName: null }],
    ["a language outside en and de", { locale: "fr" }],
    ["a null language", { locale: null }],
    ["a name that is not a string", { displayName: 7 }],
    ["an array", []],
    ["a string", '"text"'],
  ])("refuses %s with 422 validation_failed and changes nothing", async (_name, body) => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada);
    const before = await snapshot(ada.id);

    const response = await patch(world, { as: browser, body });

    expect(response.status).toBe(422);
    expect((await problem(response)).code).toBe("validation_failed");
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it("refuses a name that is blank once its whitespace is removed, with the field named", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada);
    const before = await snapshot(ada.id);

    const response = await patch(world, { as: browser, body: { displayName: "   ", locale: "de" } });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "displayName", code: "too_small" }] });
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it("refuses a body that is not JSON, and one sent as a form-submittable content type, and changes nothing", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada);
    const before = await snapshot(ada.id);

    expect((await patch(world, { as: browser, body: "{not json" })).status).toBe(400);
    const wrongType = await patch(world, { as: browser, body: JSON.stringify({ locale: "de" }), contentType: "text/plain" });
    expect(wrongType.status).toBe(403);
    expect((await problem(wrongType)).code).toBe("cross_site_request");
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it("words the problem in English whatever language the account chose", async () => {
    const world = serve();
    const grace = await seedAccount(database());
    const browser = await signIn(world, grace);
    expect((await patch(world, { as: browser, body: { locale: "de" } })).status).toBe(200);

    const refused = await problem(await patch(world, { as: browser, body: { displayName: "   " } }));
    expect(refused.detail).toBe(BLANK_NAME_DETAIL);
    const invalid = await problem(await patch(world, { as: browser, body: { locale: "fr" } }));
    expect(invalid.detail).toMatch(/^[\x20-\x7e]+$/);
    expect(invalid.detail).not.toMatch(/[äöüß]/i);
  });

  it("changes only the caller's account, even when the body names another account's id or email", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const adas = await signIn(world, ada);
    const before = await snapshot(grace.id);

    const named = await patch(world, { as: adas, body: { displayName: "Ada", id: grace.id, email: grace.email } });
    expect(named.status).toBe(422);
    expect(await snapshot(grace.id)).toEqual(before);

    const changed = await patch(world, { as: adas, body: { displayName: "Ada", locale: "de" } });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { id: string }).id).toBe(ada.id);
    expect(await snapshot(grace.id)).toEqual(before);
    expect(await snapshot(ada.id)).toMatchObject({ display_name: "Ada", locale: "de" });
  });

  it("answers 401 without a session and changes nothing", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const before = await snapshot(ada.id);
    const response = await patch(world, { body: { displayName: "Intruder" } });
    expect(response.status).toBe(401);
    expect((await problem(response)).code).toBe("unauthenticated");
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it("refuses a request that does not come from the application itself, and changes nothing", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada);
    const before = await snapshot(ada.id);

    for (const origin of ["https://evil.example", null]) {
      const response = await patch(world, { as: browser, origin, body: { displayName: "Intruder" } });
      expect(response.status, String(origin)).toBe(403);
      expect((await problem(response)).code, String(origin)).toBe("cross_site_request");
    }
    expect(await snapshot(ada.id)).toEqual(before);
  });

  it("refuses an API token, which holds no scope for this operation, and changes nothing", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const workspace = await seedWorkspace(database(), { name: "Bound" });
    await seedMembership(database(), { workspaceId: workspace, accountId: ada.id, role: "owner" });
    const before = await snapshot(ada.id);
    const response = await patch(world, { as: `Bearer token:${ada.id}:${workspace}`, body: { displayName: "By token" } });
    expect(response.status).toBe(403);
    expect(await snapshot(ada.id)).toEqual(before);
  });
});
