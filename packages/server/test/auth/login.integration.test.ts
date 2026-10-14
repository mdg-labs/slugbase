import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import type { AuthStore } from "@slugbase/db";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import {
  changePassword,
  disableAccount,
  expireSessions,
  seedAccount,
  sessionRows,
  sha256,
  storeFor,
  type SeededAccount,
} from "./support.ts";

// Password sign-in and sign-out through the whole chain over the migrated
// database (doc 02 sections 2.3 and 2.4, doc 04 sections 4.1 and 10.2, doc 10
// T4, T8 and T9): the failure scenarios are a session token that outlives its
// logout or its rotation, and an unknown email that can be told from a wrong
// password.

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGIN = "/api/v1/auth/login";
const LOGOUT = "/api/v1/auth/logout";
const SESSION_COOKIE = "__Host-slugbase_session";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  // useTestDatabase's own beforeAll has run by the time this one does.
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

interface Options {
  readonly env?: Record<string, string>;
}

function serve({ env = {} }: Options = {}): { server: Server; origin: string } {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    // The defaults are for production traffic; a test that is not about them signs in freely.
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    ...env,
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

interface Attempt {
  readonly email?: string;
  readonly password?: string;
  readonly remember?: boolean;
  readonly body?: unknown;
  readonly cookie?: string;
  readonly forwardedFor?: string;
  readonly userAgent?: string;
  readonly origin?: string | null;
  readonly contentType?: string;
}

function post(origin: string, path: string, attempt: Attempt = {}): Request {
  const headers = new Headers({ "content-type": attempt.contentType ?? "application/json" });
  if (attempt.origin !== null) {
    headers.set("origin", attempt.origin ?? origin);
  }
  if (attempt.cookie !== undefined) {
    headers.set("cookie", attempt.cookie);
  }
  if (attempt.forwardedFor !== undefined) {
    headers.set("x-forwarded-for", attempt.forwardedFor);
  }
  if (attempt.userAgent !== undefined) {
    headers.set("user-agent", attempt.userAgent);
  }
  const body =
    attempt.body ?? (attempt.email === undefined ? {} : { email: attempt.email, password: attempt.password ?? "", remember: attempt.remember ?? false });
  return new Request(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(body) });
}

function cookieOf(response: Response, name = SESSION_COOKIE): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`^${name}=([A-Za-z0-9_-]{43});`).exec(header);
  if (match?.[1] === undefined) {
    throw new Error(`no session cookie in: ${header}`);
  }
  return match[1];
}

async function signIn(
  { server, origin }: { server: Server; origin: string },
  account: SeededAccount,
  extra: Attempt = {},
): Promise<Response> {
  return server.fetch(post(origin, LOGIN, { email: account.email, password: account.password, ...extra }));
}

function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== "requestId"));
}

async function logout({ server, origin }: { server: Server; origin: string }, token: string, name = SESSION_COOKIE): Promise<Response> {
  return server.fetch(post(origin, LOGOUT, { body: {}, cookie: `${name}=${token}` }));
}

describe("POST /api/v1/auth/login", () => {
  it("signs in with the right password: 200 { next: 'done' } and a session cookie", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const response = await signIn(world, account);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "done" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const token = cookieOf(response);
    expect(response.headers.get("set-cookie")).toBe(
      `${SESSION_COOKIE}=${token}; Max-Age=15552000; Path=/; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(response.headers.get("set-cookie")).not.toMatch(/Domain/i);
  });

  it("stores only the SHA-256 of the 32-byte token, the coarse network and a truncated user agent, never the address", async () => {
    const world = serve({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const account = await seedAccount(database());
    const response = await signIn(world, account, { forwardedFor: "203.0.113.57", userAgent: "A".repeat(500) });
    const token = cookieOf(response);

    const rows = await sessionRows(database(), account.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.token_hash.equals(sha256(Buffer.from(token, "base64url")))).toBe(true);
    expect(row?.token_hash.equals(Buffer.from(token, "base64url"))).toBe(false);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(row?.ip_prefix).toBe("203.0.0.0/16");
    expect(JSON.stringify(row)).not.toContain("203.0.113");
    expect(row?.user_agent).toBe("A".repeat(256));
    expect(row?.level).toBe("full");
  });

  it("keeps an IPv6 client as its /48 and a client without an address as no prefix", async () => {
    const proxied = serve({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const account = await seedAccount(database());
    await signIn(proxied, account, { forwardedFor: "2001:db8:abcd:12:3456:789a:bcde:f012" });
    // An in-process request has no socket and, without a trusted proxy, no client address.
    await signIn(serve(), account);
    const prefixes = (await sessionRows(database(), account.id)).map((row) => row.ip_prefix);
    expect(new Set(prefixes)).toEqual(new Set(["2001:db8:abcd::/48", null]));
  });

  it("slides 30 days, or 90 with remember, under a 180-day cap", async () => {
    const world = serve();
    const plain = await seedAccount(database());
    const remembered = await seedAccount(database());
    await signIn(world, plain);
    await signIn(world, remembered, { remember: true });
    const [short] = await sessionRows(database(), plain.id);
    const [long] = await sessionRows(database(), remembered.id);
    expect((short?.expires_at.getTime() ?? 0) - (short?.created_at.getTime() ?? 0)).toBe(30 * DAY_MS);
    expect((long?.expires_at.getTime() ?? 0) - (long?.created_at.getTime() ?? 0)).toBe(90 * DAY_MS);
    expect((long?.absolute_expires_at.getTime() ?? 0) - (long?.created_at.getTime() ?? 0)).toBe(180 * DAY_MS);
    expect(long?.remember).toBe(true);
  });

  it("matches the email case-insensitively after trimming and NFKC normalisation", async () => {
    const world = serve();
    const account = await seedAccount(database(), { email: "Ada.Lovelace@Example.test" });
    for (const email of ["ada.lovelace@example.test", "  ADA.LOVELACE@EXAMPLE.TEST ", "ａｄａ.ｌｏｖｅｌａｃｅ＠example.test"]) {
      const response = await signIn(world, account, { email });
      expect(response.status, email).toBe(200);
    }
  });

  it("names the cookie plainly, without Secure, when the origin is http", async () => {
    const world = serve({ env: { APP_ORIGIN: "http://localhost:5173" } });
    const account = await seedAccount(database());
    const response = await signIn(world, account);
    expect(response.status).toBe(200);
    const token = cookieOf(response, "slugbase_session");
    expect(response.headers.get("set-cookie")).toBe(
      `slugbase_session=${token}; Max-Age=15552000; Path=/; HttpOnly; SameSite=Lax`,
    );
    expect((await logout(world, token, "slugbase_session")).status).toBe(204);
  });

  describe("one answer for every way to fail (T8)", () => {
    async function failures() {
      const world = serve();
      const known = await seedAccount(database());
      const disabled = await seedAccount(database(), { disabled: true });
      const passwordless = await seedAccount(database(), { password: null });
      const attempts: readonly [string, Attempt][] = [
        ["an unknown email", { email: "nobody@example.test", password: "some password" }],
        ["a wrong password", { email: known.email, password: "not the password" }],
        ["a disabled account with the right password", { email: disabled.email, password: disabled.password }],
        ["an account without a password", { email: passwordless.email, password: "some password" }],
      ];
      return { world, attempts };
    }

    it("is the same 401 unauthenticated, with the same body shape and headers, and no cookie", async () => {
      const { world, attempts } = await failures();
      const seen: { name: string; status: number; body: Record<string, unknown>; headers: string[]; type: string | null }[] = [];
      for (const [name, attempt] of attempts) {
        const response = await world.server.fetch(post(world.origin, LOGIN, attempt));
        const body = (await response.json()) as Record<string, unknown>;
        seen.push({
          name,
          status: response.status,
          body,
          headers: [...response.headers.keys()].filter((header) => header !== "x-request-id").sort(),
          type: response.headers.get("content-type"),
        });
        expect(response.headers.get("set-cookie"), name).toBeNull();
      }
      const [first, ...rest] = seen;
      expect(first?.status).toBe(401);
      expect(first?.body).toMatchObject({ code: "unauthenticated", status: 401 });
      for (const other of rest) {
        expect(other.status, other.name).toBe(first?.status);
        expect(other.type, other.name).toBe(first?.type);
        expect(other.headers, other.name).toEqual(first?.headers);
        expect(withoutRequestId(other.body), other.name).toEqual(withoutRequestId(first?.body ?? {}));
      }
    });

    it("falls in one latency class: an unknown email costs a password verification too", async () => {
      const { world } = await failures();
      const known = await seedAccount(database());
      const median = async (attempt: Attempt): Promise<number> => {
        const durations: number[] = [];
        for (let round = 0; round < 7; round += 1) {
          const started = performance.now();
          await world.server.fetch(post(world.origin, LOGIN, attempt));
          durations.push(performance.now() - started);
        }
        return durations.sort((a, b) => a - b)[3] ?? 0;
      };
      await median({ email: known.email, password: "warm up" });
      const wrong = await median({ email: known.email, password: "not the password" });
      const unknown = await median({ email: "nobody@example.test", password: "not the password" });
      // Without the dummy verification the unknown email would answer in a small fraction of the time.
      expect(unknown).toBeGreaterThan(wrong * 0.5);
      expect(unknown).toBeLessThan(wrong * 2);
    });

    it("creates no session and sets no sign-in time for any of them", async () => {
      const { world, attempts } = await failures();
      for (const [, attempt] of attempts) {
        await world.server.fetch(post(world.origin, LOGIN, attempt));
      }
      const disabled = await seedAccount(database(), { disabled: true });
      await signIn(world, disabled);
      expect(await sessionRows(database(), disabled.id)).toEqual([]);
    });
  });

  describe("rotation (T4)", () => {
    it("issues a new token and deletes the session of the cookie the request carried", async () => {
      const world = serve();
      const account = await seedAccount(database());
      const first = cookieOf(await signIn(world, account));
      const second = cookieOf(await signIn(world, account, { cookie: `${SESSION_COOKIE}=${first}` }));
      expect(second).not.toBe(first);

      expect((await sessionRows(database(), account.id)).map((row) => row.token_hash.toString("hex"))).toEqual([
        sha256(Buffer.from(second, "base64url")).toString("hex"),
      ]);
      // The token used after rotation is refused on the very next request.
      const stale = await logout(world, first);
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ code: "unauthenticated" });
      expect((await logout(world, second)).status).toBe(204);
    });

    it("deletes the session of another account that the carried cookie belonged to", async () => {
      const world = serve();
      const first = await seedAccount(database());
      const second = await seedAccount(database());
      const carried = cookieOf(await signIn(world, first));
      await signIn(world, second, { cookie: `${SESSION_COOKIE}=${carried}` });
      expect(await sessionRows(database(), first.id)).toEqual([]);
      expect(await sessionRows(database(), second.id)).toHaveLength(1);
    });

    it("leaves the carried session alone when the sign-in fails", async () => {
      const world = serve();
      const account = await seedAccount(database());
      const carried = cookieOf(await signIn(world, account));
      const refused = await signIn(world, account, { password: "not the password", cookie: `${SESSION_COOKIE}=${carried}` });
      expect(refused.status).toBe(401);
      expect(await sessionRows(database(), account.id)).toHaveLength(1);
      expect((await logout(world, carried)).status).toBe(204);
    });

    it("ignores a cookie that is not a token of this server", async () => {
      const world = serve();
      const account = await seedAccount(database());
      const response = await signIn(world, account, { cookie: `${SESSION_COOKIE}=not-a-token` });
      expect(response.status).toBe(200);
      expect(await sessionRows(database(), account.id)).toHaveLength(1);
    });
  });

  describe("limits (T9)", () => {
    it("allows 10 attempts a minute per IP and answers the 11th with 429 rate_limited and Retry-After", async () => {
      const world = serve({ env: { RATE_LIMIT_LOGIN_IP: "10/min", RATE_LIMIT_LOGIN_EMAIL: "1000/hour" } });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await world.server.fetch(post(world.origin, LOGIN, { email: `n${String(attempt)}@example.test`, password: "x" }));
        expect(response.status).toBe(401);
      }
      const denied = await world.server.fetch(post(world.origin, LOGIN, { email: "n11@example.test", password: "x" }));
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "rate_limited", status: 429 });
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(denied.headers.get("ratelimit-policy")).toContain('"login";q=10;w=60');
    });

    it("allows 20 attempts an hour per email, unknown emails included, whatever the IP and the case of the address", async () => {
      const world = serve({ env: { TRUSTED_PROXY_HOPS: "1", RATE_LIMIT_LOGIN_IP: "1000/min", RATE_LIMIT_LOGIN_EMAIL: "20/hour" } });
      const spellings = ["Victim@Example.test", "victim@example.TEST", " VICTIM@example.test ", "ＶＩＣＴＩＭ@example.test"];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const email = spellings[attempt % spellings.length] ?? "";
        const response = await world.server.fetch(post(world.origin, LOGIN, { email, password: "x", forwardedFor: `198.51.100.${String(attempt)}` }));
        expect(response.status, String(attempt)).toBe(401);
      }
      const denied = await world.server.fetch(post(world.origin, LOGIN, { email: "victim@example.test", password: "x", forwardedFor: "198.51.100.200" }));
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(denied.headers.get("ratelimit-policy")).toContain('"login:email";q=20;w=3600');
      // Another address is not affected.
      const other = await world.server.fetch(post(world.origin, LOGIN, { email: "someone-else@example.test", password: "x", forwardedFor: "198.51.100.201" }));
      expect(other.status).toBe(401);
    });

    it("counts the spellings the database treats as one account in one bucket, though JavaScript lower-cases them differently", async () => {
      const world = serve({ env: { RATE_LIMIT_LOGIN_EMAIL: "2/hour" } });
      const account = await seedAccount(database(), { email: "victim@example.test" });
      // U+0130 lower-cases to "i" in the database and to "i" plus a combining dot in JavaScript.
      const spellings = ["victim@example.test", "vİctim@example.test", "vİctİm@example.test"];
      expect("İ".toLowerCase()).not.toBe("i");
      await signIn(world, account, { password: "wrong one" });
      await signIn(world, account, { password: "wrong two" });
      for (const email of spellings) {
        const denied = await signIn(world, account, { email });
        expect(denied.status, email).toBe(429);
      }
      expect(await sessionRows(database(), account.id)).toEqual([]);
    });

    it("refuses the right password too once the address has used its limit, before it is checked", async () => {
      const world = serve({ env: { RATE_LIMIT_LOGIN_EMAIL: "2/hour" } });
      const account = await seedAccount(database());
      await signIn(world, account, { password: "wrong one" });
      await signIn(world, account, { password: "wrong two" });
      const denied = await signIn(world, account);
      expect(denied.status).toBe(429);
      expect(await sessionRows(database(), account.id)).toEqual([]);
    });
  });

  describe("the request", () => {
    it.each([
      ["a missing password", { email: "a@example.test" }],
      ["an unknown field", { email: "a@example.test", password: "x", extra: true }],
      ["an empty email", { email: "", password: "x" }],
      ["a password over 256 characters", { email: "a@example.test", password: "x".repeat(257) }],
      ["a non-boolean remember", { email: "a@example.test", password: "x", remember: "yes" }],
    ])("is 422 validation_failed for %s, without a session or a verification", async (_name, body) => {
      const world = serve();
      const response = await world.server.fetch(post(world.origin, LOGIN, { body }));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "validation_failed" });
    });

    it("takes remember as false when it is left out", async () => {
      const world = serve();
      const account = await seedAccount(database());
      const response = await world.server.fetch(post(world.origin, LOGIN, { body: { email: account.email, password: account.password } }));
      expect(response.status).toBe(200);
      const [row] = await sessionRows(database(), account.id);
      expect(row?.remember).toBe(false);
      expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBe(30 * DAY_MS);
    });

    it("is refused from another origin or as a form, like every browser mutation", async () => {
      const world = serve();
      const account = await seedAccount(database());
      const body = { email: account.email, password: account.password };
      expect((await world.server.fetch(post(world.origin, LOGIN, { body, origin: "https://evil.example" }))).status).toBe(403);
      expect((await world.server.fetch(post(world.origin, LOGIN, { body, origin: null }))).status).toBe(403);
      expect((await world.server.fetch(post(world.origin, LOGIN, { body, contentType: "application/x-www-form-urlencoded" }))).status).toBe(403);
      expect(await sessionRows(database(), account.id)).toEqual([]);
    });
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("deletes the session and clears the cookie, and the token is refused from the next request on (T4)", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = cookieOf(await signIn(world, account));

    const ended = await logout(world, token);
    expect(ended.status).toBe(204);
    expect(await ended.text()).toBe("");
    expect(ended.headers.get("set-cookie")).toBe(
      `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
    expect(await sessionRows(database(), account.id)).toEqual([]);

    const again = await logout(world, token);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("ends only the session it was called with", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const laptop = cookieOf(await signIn(world, account));
    const phone = cookieOf(await signIn(world, account));
    expect((await logout(world, laptop)).status).toBe(204);
    expect((await sessionRows(database(), account.id)).map((row) => row.token_hash.toString("hex"))).toEqual([
      sha256(Buffer.from(phone, "base64url")).toString("hex"),
    ]);
    expect((await logout(world, phone)).status).toBe(204);
  });

  it("is 401 without a session cookie and with a token the server never issued", async () => {
    const world = serve();
    expect((await world.server.fetch(post(world.origin, LOGOUT, { body: {} }))).status).toBe(401);
    expect((await logout(world, "A".repeat(43))).status).toBe(401);
  });

  it("is refused from another origin, without ending the session", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = cookieOf(await signIn(world, account));
    const response = await world.server.fetch(post(world.origin, LOGOUT, { body: {}, cookie: `${SESSION_COOKIE}=${token}`, origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(await sessionRows(database(), account.id)).toHaveLength(1);
  });

  it("is not callable with a bearer credential in place of the cookie", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = cookieOf(await signIn(world, account));
    const request = post(world.origin, LOGOUT, { body: {}, cookie: `${SESSION_COOKIE}=${token}` });
    request.headers.set("authorization", "Bearer slb_whatever");
    const response = await world.server.fetch(request);
    // The cookie is ignored on a request that carries an Authorization header.
    expect(response.status).toBe(401);
    expect(await sessionRows(database(), account.id)).toHaveLength(1);
  });
});

describe("the session cookie at stage 4 (T4)", () => {
  async function signedIn() {
    const world = serve();
    const account = await seedAccount(database());
    const token = cookieOf(await signIn(world, account));
    return { world, account, token };
  }

  it("is refused once its session has expired", async () => {
    const { world, account, token } = await signedIn();
    await expireSessions(database(), account.id);
    expect((await logout(world, token)).status).toBe(401);
  });

  it("is refused once its account is disabled", async () => {
    const { world, account, token } = await signedIn();
    await disableAccount(database(), account.id);
    expect((await logout(world, token)).status).toBe(401);
  });

  it("is refused once the password changed after the session was created", async () => {
    const { world, account, token } = await signedIn();
    await changePassword(database(), account.id);
    expect((await logout(world, token)).status).toBe(401);
  });

  it("is checked in the database on every request: a session deleted behind the server's back is refused at once", async () => {
    const { world, account, token } = await signedIn();
    const [row] = await sessionRows(database(), account.id);
    expect(await store.revokeSession(row?.id ?? "", account.id)).toBe(true);
    expect((await logout(world, token)).status).toBe(401);
  });
});
