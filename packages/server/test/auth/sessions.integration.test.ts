import { createHash } from "node:crypto";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// Listing and revoking the account's sessions through the whole chain over the
// migrated database (doc 04 section 10.3, doc 10 T1 and T4): the failure
// scenarios are an account that lists or revokes another account's session by
// id, a list that carries a token hash or a full address, and a revoked session
// that still answers.

const SESSIONS = "/api/v1/me/sessions";
const SESSION_COOKIE = "__Host-slugbase_session";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

interface World {
  readonly server: Server;
  readonly origin: string;
}

function serve(): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    TRUSTED_PROXY_HOPS: "1",
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
  });
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN };
}

/** A signed-in browser: its cookie value, and the session row it opened. */
interface Browser {
  readonly token: string;
  readonly sessionId: string;
}

async function signIn({ server, origin }: World, account: SeededAccount, userAgent: string, forwardedFor: string): Promise<Browser> {
  const response = await server.fetch(
    new Request(new URL("/api/v1/auth/login", origin), {
      method: "POST",
      headers: { origin, "content-type": "application/json", "user-agent": userAgent, "x-forwarded-for": forwardedFor },
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

interface Call {
  readonly method?: "GET" | "DELETE";
  readonly path?: string;
  readonly as?: Browser | null;
  readonly origin?: string | null;
}

function call({ server, origin }: World, { method = "GET", path = SESSIONS, as = null, origin: sent = origin }: Call): Promise<Response> {
  const headers = new Headers();
  if (as !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${as.token}`);
  }
  if (method !== "GET" && sent !== null) {
    headers.set("origin", sent);
    headers.set("content-type", "application/json");
  }
  return server.fetch(new Request(new URL(path, origin), { method, headers }));
}

interface ListedSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgentFamily: string | null;
  ipPrefix: string | null;
  current: boolean;
}

async function listed(world: World, as: Browser): Promise<ListedSession[]> {
  const response = await call(world, { as });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: ListedSession[] }).items;
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/v1/me/sessions", () => {
  it("lists the caller's own sessions with the coarse prefix and the family, marks the current one, and carries no hash or address", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const onDesktop = await signIn(world, ada, FIREFOX, "203.0.113.57");
    const onPhone = await signIn(world, ada, CHROME, "2001:db8:abcd:12:3456:789a:bcde:f012");
    const graces = await signIn(world, grace, CHROME, "198.51.100.9");

    const response = await call(world, { as: onDesktop });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const items = (JSON.parse(text) as { items: ListedSession[] }).items;

    expect(items.map((item) => item.id).sort()).toEqual([onDesktop.sessionId, onPhone.sessionId].sort());
    expect(items.find((item) => item.id === onDesktop.sessionId)).toMatchObject({
      userAgentFamily: "Firefox",
      ipPrefix: "203.0.0.0/16",
      current: true,
    });
    expect(items.find((item) => item.id === onPhone.sessionId)).toMatchObject({
      userAgentFamily: "Chrome",
      ipPrefix: "2001:db8:abcd::/48",
      current: false,
    });
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["createdAt", "current", "id", "ipPrefix", "lastSeenAt", "userAgentFamily"]);
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
    }

    expect(text).not.toContain(graces.sessionId);
    expect(text).not.toContain(onDesktop.token);
    expect(text).not.toContain(onPhone.token);
    expect(text).not.toMatch(/token_?hash/i);
    for (const address of ["203.0.113", "198.51.100", "2001:db8:abcd:12", "Gecko", "Windows"]) {
      expect(text, address).not.toContain(address);
    }
    expect(await listed(world, graces)).toEqual([expect.objectContaining({ id: graces.sessionId, current: true })]);
  });

  it("is refused without a session, and to a session whose second factor is pending", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account, FIREFOX, "203.0.113.57");

    const anonymous = await call(world, {});
    expect(anonymous.status).toBe(401);
    expect(await problem(anonymous)).toMatchObject({ code: "unauthenticated" });

    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE sessions SET level = 'partial' WHERE id = ${browser.sessionId}`;
    });
    const pending = await call(world, { as: browser });
    expect(pending.status).toBe(401);
    expect(await problem(pending)).toMatchObject({ code: "mfa_required" });
  });
});

interface Page {
  items: ListedSession[];
  nextCursor: string | null;
}

async function page(world: World, as: Browser, query: string): Promise<Page> {
  const response = await call(world, { as, path: `${SESSIONS}?${query}` });
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

describe("GET /api/v1/me/sessions pagination", () => {
  it("pages through more sessions than one page holds, newest first, each exactly once, with no cursor on the last page", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browsers: Browser[] = [];
    for (let at = 0; at < 5; at += 1) {
      browsers.push(await signIn(world, ada, FIREFOX, `203.0.113.${String(10 + at)}`));
    }
    const caller = browsers[2] as Browser;
    const expected = browsers.map((browser) => browser.sessionId).sort().reverse();

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const result: Page = await page(world, caller, cursor === null ? "limit=2" : `limit=2&cursor=${encodeURIComponent(cursor)}`);
      sizes.push(result.items.length);
      seen.push(...result.items.map((item) => item.id));
      expect(Object.keys(result).sort()).toEqual(["items", "nextCursor"]);
      cursor = result.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(5);
  });

  it("returns every session with no cursor when the page is not full, and uses a default page size", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const first = await signIn(world, ada, FIREFOX, "203.0.113.1");
    const second = await signIn(world, ada, CHROME, "203.0.113.2");
    expect((await page(world, first, "limit=2")).nextCursor).toBeNull();
    const defaulted = await page(world, first, "");
    expect(defaulted.nextCursor).toBeNull();
    expect(defaulted.items.map((item) => item.id).sort()).toEqual([first.sessionId, second.sessionId].sort());
  });

  it("answers 400 bad_request for a cursor that is malformed, altered or not signed by this server", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browsers = [await signIn(world, ada, FIREFOX, "203.0.113.1"), await signIn(world, ada, CHROME, "203.0.113.2"), await signIn(world, ada, CHROME, "203.0.113.3")];
    const caller = browsers[0] as Browser;
    const issued = (await page(world, caller, "limit=1")).nextCursor;
    expect(issued).not.toBeNull();
    const [payload = "", signature = ""] = (issued ?? "").split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ id: browsers[1]?.sessionId })).toString("base64url");

    for (const cursor of ["x", "not.a.cursor", ".", `${payload}.`, `.${signature}`, `${forgedPayload}.${signature}`, `${payload}.${signature.slice(1)}A`, `${issued ?? ""}A`]) {
      const response = await call(world, { as: caller, path: `${SESSIONS}?cursor=${encodeURIComponent(cursor)}` });
      expect(response.status, cursor).toBe(400);
      expect(await problem(response), cursor).toMatchObject({ code: "bad_request" });
    }
  });

  it("refuses a cursor issued to another account and shows none of that account's sessions", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const adas = [await signIn(world, ada, FIREFOX, "203.0.113.1"), await signIn(world, ada, CHROME, "203.0.113.2"), await signIn(world, ada, CHROME, "203.0.113.3")];
    const graces = await signIn(world, grace, CHROME, "198.51.100.9");
    const cursor = (await page(world, adas[0] as Browser, "limit=1")).nextCursor;
    expect(cursor).not.toBeNull();

    const response = await call(world, { as: graces, path: `${SESSIONS}?cursor=${encodeURIComponent(cursor ?? "")}` });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("bad_request");
    for (const browser of adas) {
      expect(text).not.toContain(browser.sessionId);
    }
    expect((await listed(world, graces)).map((item) => item.id)).toEqual([graces.sessionId]);
  });

  it("answers 422 for a limit that is not a whole number from 1 to 100 and for an unknown parameter", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const browser = await signIn(world, ada, FIREFOX, "203.0.113.1");
    for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=many", "cursor=", "offset=1"]) {
      const response = await call(world, { as: browser, path: `${SESSIONS}?${query}` });
      expect(response.status, query).toBe(422);
      expect(await problem(response), query).toMatchObject({ code: "validation_failed" });
    }
    expect((await page(world, browser, "limit=100")).items).toHaveLength(1);
  });
});

describe("DELETE /api/v1/me/sessions/{id}", () => {
  it("revokes one of the caller's other sessions, which is refused from its next request, and leaves the caller's own", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account, FIREFOX, "203.0.113.57");
    const there = await signIn(world, account, CHROME, "198.51.100.9");

    const response = await call(world, { method: "DELETE", path: `${SESSIONS}/${there.sessionId}`, as: here });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBeNull();

    const refused = await call(world, { as: there });
    expect(refused.status).toBe(401);
    expect((await sessionRows(database(), account.id)).map((row) => row.id)).toEqual([here.sessionId]);
    expect((await listed(world, here)).map((item) => item.id)).toEqual([here.sessionId]);
  });

  it("answers 404 not_found for another account's session id, lists nothing of it, and leaves that session working", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const adas = await signIn(world, ada, FIREFOX, "203.0.113.57");
    const graces = await signIn(world, grace, CHROME, "198.51.100.9");

    const response = await call(world, { method: "DELETE", path: `${SESSIONS}/${graces.sessionId}`, as: adas });
    expect(response.status).toBe(404);
    expect(await problem(response)).toMatchObject({ status: 404, code: "not_found" });
    expect(response.headers.get("set-cookie")).toBeNull();

    expect((await sessionRows(database(), grace.id)).map((row) => row.id)).toEqual([graces.sessionId]);
    expect((await call(world, { as: graces })).status).toBe(200);
    expect((await listed(world, adas)).map((item) => item.id)).toEqual([adas.sessionId]);

    const unknown = await call(world, { method: "DELETE", path: `${SESSIONS}/0192f3a0-dddd-7000-8000-000000000001`, as: adas });
    expect(unknown.status).toBe(404);
    expect(await problem(unknown)).toMatchObject({ code: "not_found" });
  });

  it("clears the cookie when it revokes the current session, and the session is gone from the next request", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account, FIREFOX, "203.0.113.57");
    const other = await signIn(world, account, CHROME, "198.51.100.9");

    const response = await call(world, { method: "DELETE", path: `${SESSIONS}/${here.sessionId}`, as: here });
    expect(response.status).toBe(204);
    const cleared = response.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure;`));

    expect((await call(world, { as: here })).status).toBe(401);
    expect((await listed(world, other)).map((item) => item.id)).toEqual([other.sessionId]);
  });

  it("answers 422 for an identifier that is not a UUID, 401 without a session and 403 for a request from another origin", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account, FIREFOX, "203.0.113.57");

    const malformed = await call(world, { method: "DELETE", path: `${SESSIONS}/not-an-id`, as: browser });
    expect(malformed.status).toBe(422);
    expect(await problem(malformed)).toMatchObject({ code: "validation_failed" });

    const anonymous = await call(world, { method: "DELETE", path: `${SESSIONS}/${browser.sessionId}` });
    expect(anonymous.status).toBe(401);

    const crossSite = await call(world, { method: "DELETE", path: `${SESSIONS}/${browser.sessionId}`, as: browser, origin: "https://elsewhere.example" });
    expect(crossSite.status).toBe(403);
    expect((await call(world, { as: browser })).status).toBe(200);
  });
});

describe("DELETE /api/v1/me/sessions", () => {
  it("revokes every other session of the caller, keeps the current one and touches no other account", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const here = await signIn(world, ada, FIREFOX, "203.0.113.57");
    const second = await signIn(world, ada, CHROME, "198.51.100.9");
    const third = await signIn(world, ada, CHROME, "192.0.2.4");
    const graces = await signIn(world, grace, CHROME, "198.51.100.9");

    const response = await call(world, { method: "DELETE", as: here });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBeNull();

    for (const revoked of [second, third]) {
      expect((await call(world, { as: revoked })).status).toBe(401);
    }
    expect((await listed(world, here)).map((item) => item.id)).toEqual([here.sessionId]);
    expect((await listed(world, graces)).map((item) => item.id)).toEqual([graces.sessionId]);
  });

  it("revokes the current session too with includeCurrent=true, and clears the cookie", async () => {
    const world = serve();
    const ada = await seedAccount(database());
    const grace = await seedAccount(database());
    const here = await signIn(world, ada, FIREFOX, "203.0.113.57");
    const second = await signIn(world, ada, CHROME, "198.51.100.9");
    const graces = await signIn(world, grace, CHROME, "198.51.100.9");

    const response = await call(world, { method: "DELETE", path: `${SESSIONS}?includeCurrent=true`, as: here });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie") ?? "").toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0;`));

    expect((await call(world, { as: here })).status).toBe(401);
    expect((await call(world, { as: second })).status).toBe(401);
    expect(await sessionRows(database(), ada.id)).toEqual([]);
    expect((await listed(world, graces)).map((item) => item.id)).toEqual([graces.sessionId]);
  });

  it("keeps the current session for includeCurrent=false, and answers 422 for any other value", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account, FIREFOX, "203.0.113.57");
    const second = await signIn(world, account, CHROME, "198.51.100.9");

    const odd = await call(world, { method: "DELETE", path: `${SESSIONS}?includeCurrent=yes`, as: here });
    expect(odd.status).toBe(422);
    expect((await sessionRows(database(), account.id)).map((row) => row.id).sort()).toEqual([here.sessionId, second.sessionId].sort());

    const kept = await call(world, { method: "DELETE", path: `${SESSIONS}?includeCurrent=false`, as: here });
    expect(kept.status).toBe(204);
    expect(kept.headers.get("set-cookie")).toBeNull();
    expect((await sessionRows(database(), account.id)).map((row) => row.id)).toEqual([here.sessionId]);
  });

  it("is refused without a session and from another origin, and deletes nothing then", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account, FIREFOX, "203.0.113.57");
    const second = await signIn(world, account, CHROME, "198.51.100.9");

    expect((await call(world, { method: "DELETE" })).status).toBe(401);
    expect((await call(world, { method: "DELETE", as: here, origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await call(world, { method: "DELETE", as: here, origin: null })).status).toBe(403);
    expect((await sessionRows(database(), account.id)).map((row) => row.id).sort()).toEqual([here.sessionId, second.sessionId].sort());
  });
});
