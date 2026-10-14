import { createHash } from "node:crypto";
import { FixedClock } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// Re-authentication and the password change through the whole chain over the
// migrated database (doc 04 sections 4.4 and 10.3, doc 10 T4 and T18). The
// failure scenarios: an operation that declares re-authentication accepted
// without a fresh one, or after the window; another device's cookie that still
// works after the password changed (T4); a password change that signs the
// device it was made from out, or is applied in part; a wrong password that
// clears or sets the re-authentication or ends the session; and a response or
// log line that carries a password, a hash or a token.

const REAUTH = "/api/v1/me/reauth";
const PASSWORD = "/api/v1/me/password";
const ME = "/api/v1/me";
const SESSION_COOKIE = "__Host-slugbase_session";
const MINUTE = 60_000;
const NEW_PASSWORD = "a brand new password for this account";

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
  readonly logs: ReturnType<typeof recordingLogger>;
}

/** `clock`, when given, is the instant the server measures the re-authentication window against; otherwise the system clock is. */
function serve(overrides: Record<string, string> = {}, clock?: FixedClock): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    ...overrides,
  });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver() },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
    ...(clock === undefined ? {} : { now: () => clock.now().getTime() }),
  });
  return { server, origin: config.APP_ORIGIN, logs };
}

interface Browser {
  readonly token: string;
  readonly sessionId: string;
}

async function signInWith({ server, origin }: World, email: string, password: string): Promise<Response> {
  return server.fetch(
    new Request(new URL("/api/v1/auth/login", origin), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, password, remember: false }),
    }),
  );
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

async function sessionIdOf(accountId: string, token: string): Promise<string> {
  const hash = createHash("sha256").update(Buffer.from(token, "base64url")).digest();
  const row = (await sessionRows(database(), accountId)).find((candidate) => candidate.token_hash.equals(hash));
  if (row === undefined) {
    throw new Error("the session row is missing");
  }
  return row.id;
}

async function signIn(world: World, account: SeededAccount): Promise<Browser> {
  const response = await signInWith(world, account.email, account.password);
  const token = tokenOf(response);
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  return { token, sessionId: await sessionIdOf(account.id, token) };
}

function post({ server, origin }: World, path: string, as: Browser | null, body: unknown): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (as !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${as.token}`);
  }
  return server.fetch(new Request(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(body) }));
}

function getMe({ server, origin }: World, as: Browser): Promise<Response> {
  return server.fetch(new Request(new URL(ME, origin), { headers: { cookie: `${SESSION_COOKIE}=${as.token}` } }));
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** The problem of a refusal without the request identifier, which differs by request. */
async function shape(response: Response): Promise<Record<string, unknown>> {
  const body = await problem(response);
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));
}

async function reauthAtOf(sessionId: string): Promise<Date | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ reauth_at: Date | null }[]>`SELECT reauth_at FROM sessions WHERE id = ${sessionId}`;
  });
  return rows[0]?.reauth_at ?? null;
}

async function passwordHashOf(accountId: string): Promise<string | null> {
  return store.passwordHashOf(accountId);
}

async function changeAndExpectAccepted(world: World, as: Browser, currentPassword: string): Promise<Response> {
  const response = await post(world, PASSWORD, as, { currentPassword, newPassword: NEW_PASSWORD });
  expect(response.status).toBe(204);
  return response;
}

describe("POST /api/v1/me/reauth", () => {
  it("sets reauth_at of the session and answers 204 with no body and no new cookie", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    expect(await reauthAtOf(browser.sessionId)).toBeNull();

    const before = Date.now();
    const response = await post(world, REAUTH, browser, { password: account.password });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toBeNull();
    const reauthAt = await reauthAtOf(browser.sessionId);
    expect(reauthAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(reauthAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await getMe(world, browser)).status).toBe(200);
  });

  it("answers 401 reauth_required with the field named for a wrong password, and neither sets nor clears reauth_at nor ends the session", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const never = await signIn(world, account);
    const already = await signIn(world, account);
    expect((await post(world, REAUTH, already, { password: account.password })).status).toBe(204);
    const kept = await reauthAtOf(already.sessionId);
    expect(kept).not.toBeNull();

    for (const browser of [never, already]) {
      const response = await post(world, REAUTH, browser, { password: "not the password" });
      expect(response.status).toBe(401);
      expect(await problem(response)).toMatchObject({ code: "reauth_required", errors: [{ path: "password", code: "invalid_password" }] });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await getMe(world, browser)).status).toBe(200);
    }
    expect(await reauthAtOf(never.sessionId)).toBeNull();
    expect(await reauthAtOf(already.sessionId)).toEqual(kept);
  });

  it("answers an account without a password exactly as it answers a wrong password", async () => {
    const world = serve();
    const withPassword = await seedAccount(database());
    const without = await seedAccount(database(), { password: null });
    const wrong = await signIn(world, withPassword);
    // An account without a password cannot sign in with one: its session is made by hand.
    const sessionToken = Buffer.alloc(32, 7);
    const sessionId = "0192f3a0-dddd-7000-8000-000000000001";
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
        VALUES (${sessionId}, ${createHash("sha256").update(sessionToken).digest()}, ${without.id}, 'full', false, now() + interval '1 day', now() + interval '2 days')`;
    });
    const passwordless: Browser = { token: sessionToken.toString("base64url"), sessionId };

    const first = await post(world, REAUTH, wrong, { password: "not the password" });
    const second = await post(world, REAUTH, passwordless, { password: "not the password" });
    expect(second.status).toBe(first.status);
    expect(await shape(second)).toEqual(await shape(first));
    expect(await reauthAtOf(sessionId)).toBeNull();
  });

  it("is refused without a session, to a session whose second factor is pending, and for a body that is not a closed password object", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);

    const anonymous = await post(world, REAUTH, null, { password: account.password });
    expect(anonymous.status).toBe(401);
    expect(await problem(anonymous)).toMatchObject({ code: "unauthenticated" });

    expect((await post(world, REAUTH, browser, { password: account.password, sessionId: "x" })).status).toBe(422);
    expect((await post(world, REAUTH, browser, {})).status).toBe(422);
    expect(await reauthAtOf(browser.sessionId)).toBeNull();

    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE sessions SET level = 'partial' WHERE id = ${browser.sessionId}`;
    });
    const pending = await post(world, REAUTH, browser, { password: account.password });
    expect(pending.status).toBe(401);
    expect(await problem(pending)).toMatchObject({ code: "mfa_required" });
    expect(await reauthAtOf(browser.sessionId)).toBeNull();
  });

  it("is limited by the mfa bucket: the attempt over the account's limit is 429 with Retry-After and changes nothing", async () => {
    const world = serve({ RATE_LIMIT_MFA_ACCOUNT: "2/hour" });
    const account = await seedAccount(database());
    const browser = await signIn(world, account);

    expect((await post(world, REAUTH, browser, { password: "wrong one" })).status).toBe(401);
    expect((await post(world, REAUTH, browser, { password: "wrong two" })).status).toBe(401);
    const limited = await post(world, REAUTH, browser, { password: account.password });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await reauthAtOf(browser.sessionId)).toBeNull();
  });
});

describe("POST /api/v1/me/password", () => {
  it("is refused with 401 reauth_required to a session that has not re-authenticated, and changes nothing", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    const before = await passwordHashOf(account.id);

    const response = await post(world, PASSWORD, browser, { currentPassword: account.password, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect(await passwordHashOf(account.id)).toBe(before);
    expect((await getMe(world, browser)).status).toBe(200);
  });

  it("is accepted 9 minutes after the re-authentication and refused 11 minutes after it, by the clock the server was given (T18)", async () => {
    const clock = new FixedClock(Date.now());
    const world = serve({}, clock);
    const account = await seedAccount(database());
    const late = await signIn(world, account);
    const inTime = await signIn(world, account);
    const before = await passwordHashOf(account.id);
    expect((await post(world, REAUTH, late, { password: account.password })).status).toBe(204);
    expect((await post(world, REAUTH, inTime, { password: account.password })).status).toBe(204);
    // The re-authentication was stamped by the database a moment before this instant.
    clock.set(Date.now());
    const reauthenticatedAt = clock.now().getTime();

    clock.set(reauthenticatedAt + 11 * MINUTE);
    const refused = await post(world, PASSWORD, late, { currentPassword: account.password, newPassword: NEW_PASSWORD });
    expect(refused.status).toBe(401);
    expect(await problem(refused)).toMatchObject({ code: "reauth_required" });
    expect(await passwordHashOf(account.id)).toBe(before);
    expect((await getMe(world, late)).status).toBe(200);

    clock.set(reauthenticatedAt + 9 * MINUTE);
    await changeAndExpectAccepted(world, inTime, account.password);
  });

  it("changes the password, keeps this device signed in under a rotated cookie, and refuses the old cookie of this device and every other device on their next request (T4)", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account);
    const phone = await signIn(world, account);
    const laptop = await signIn(world, account);
    const before = await passwordHashOf(account.id);
    expect((await post(world, REAUTH, here, { password: account.password })).status).toBe(204);
    const reauthAt = await reauthAtOf(here.sessionId);

    const response = await changeAndExpectAccepted(world, here, account.password);

    expect(await response.text()).toBe("");
    const rotated = tokenOf(response);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(here.token);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const now: Browser = { token: rotated ?? "", sessionId: here.sessionId };
    // The stored hash is a new argon2id hash, not the password.
    const after = await passwordHashOf(account.id);
    expect(after).toMatch(/^\$argon2id\$/);
    expect(after).not.toBe(before);
    expect(after).not.toContain(NEW_PASSWORD);
    // This device continues under the new token; its old one and the other devices' are refused.
    expect((await getMe(world, now)).status).toBe(200);
    for (const stale of [here, phone, laptop]) {
      const refused = await getMe(world, stale);
      expect(refused.status, stale.sessionId).toBe(401);
      expect(await problem(refused)).toMatchObject({ code: "unauthenticated" });
    }
    expect((await sessionRows(database(), account.id)).map((row) => row.id)).toEqual([here.sessionId]);
    // The session keeps its re-authentication, so a second sensitive call inside the window needs no new one.
    expect(await reauthAtOf(here.sessionId)).toEqual(reauthAt);
    // The old password no longer signs in; the new one does.
    expect((await signInWith(world, account.email, account.password)).status).toBe(401);
    expect((await signInWith(world, account.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("leaves another account's sessions alone", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const bystander = await seedAccount(database());
    const here = await signIn(world, account);
    const theirs = await signIn(world, bystander);
    expect((await post(world, REAUTH, here, { password: account.password })).status).toBe(204);
    await changeAndExpectAccepted(world, here, account.password);
    expect((await getMe(world, theirs)).status).toBe(200);
    expect(await passwordHashOf(bystander.id)).not.toBeNull();
  });

  it("answers 422 validation_failed naming currentPassword for a wrong current password, changing nothing and ending no session", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account);
    const phone = await signIn(world, account);
    expect((await post(world, REAUTH, here, { password: account.password })).status).toBe(204);
    const before = await passwordHashOf(account.id);

    const response = await post(world, PASSWORD, here, { currentPassword: "not the password", newPassword: NEW_PASSWORD });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "currentPassword", code: "invalid_password" }] });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await passwordHashOf(account.id)).toBe(before);
    expect((await getMe(world, here)).status).toBe(200);
    expect((await getMe(world, phone)).status).toBe(200);
  });

  it("answers an account without a password exactly as it answers a wrong current password", async () => {
    const world = serve();
    const withPassword = await seedAccount(database());
    const without = await seedAccount(database(), { password: null });
    const here = await signIn(world, withPassword);
    expect((await post(world, REAUTH, here, { password: withPassword.password })).status).toBe(204);
    const sessionToken = Buffer.alloc(32, 9);
    const sessionId = "0192f3a0-dddd-7000-8000-000000000002";
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, reauth_at, expires_at, absolute_expires_at)
        VALUES (${sessionId}, ${createHash("sha256").update(sessionToken).digest()}, ${without.id}, 'full', false, now(), now() + interval '1 day', now() + interval '2 days')`;
    });
    const passwordless: Browser = { token: sessionToken.toString("base64url"), sessionId };

    const first = await post(world, PASSWORD, here, { currentPassword: "not the password", newPassword: NEW_PASSWORD });
    const second = await post(world, PASSWORD, passwordless, { currentPassword: "not the password", newPassword: NEW_PASSWORD });

    expect(second.status).toBe(first.status);
    expect(await shape(second)).toEqual(await shape(first));
    expect(await passwordHashOf(without.id)).toBeNull();
  });

  it("answers 422 weak_password naming why for a password the policy refuses, changing nothing", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account);
    const phone = await signIn(world, account);
    expect((await post(world, REAUTH, here, { password: account.password })).status).toBe(204);
    const before = await passwordHashOf(account.id);

    const response = await post(world, PASSWORD, here, { currentPassword: account.password, newPassword: "short" });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "weak_password", errors: [{ path: "newPassword", code: "too_short" }] });
    expect(await passwordHashOf(account.id)).toBe(before);
    expect((await getMe(world, phone)).status).toBe(200);
  });

  it("is refused without a session and for a body that is not the closed pair of passwords", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account);
    expect((await post(world, REAUTH, here, { password: account.password })).status).toBe(204);

    expect((await post(world, PASSWORD, null, { currentPassword: account.password, newPassword: NEW_PASSWORD })).status).toBe(401);
    for (const body of [{}, { newPassword: NEW_PASSWORD }, { currentPassword: account.password, newPassword: NEW_PASSWORD, accountId: account.id }]) {
      expect((await post(world, PASSWORD, here, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await getMe(world, here)).status).toBe(200);
  });

  it("puts no password, hash or session token in any response body or log line", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const here = await signIn(world, account);
    const bodies: string[] = [];
    const record = async (response: Response): Promise<void> => {
      bodies.push(await response.clone().text());
    };

    await record(await post(world, REAUTH, here, { password: "not the password" }));
    await record(await post(world, REAUTH, here, { password: account.password }));
    await record(await post(world, PASSWORD, here, { currentPassword: "another wrong one", newPassword: "short" }));
    await record(await post(world, PASSWORD, here, { currentPassword: "another wrong one", newPassword: NEW_PASSWORD }));
    const hashBefore = (await passwordHashOf(account.id)) ?? "";
    const changed = await post(world, PASSWORD, here, { currentPassword: account.password, newPassword: NEW_PASSWORD });
    await record(changed);
    const rotated = tokenOf(changed) ?? "";
    const hashAfter = (await passwordHashOf(account.id)) ?? "";

    const secrets = [account.password, "not the password", "another wrong one", NEW_PASSWORD, hashBefore, hashAfter, here.token, rotated];
    expect(secrets.every((secret) => secret.length >= 16)).toBe(true);
    const output = JSON.stringify([bodies, world.logs.entries, world.logs.requests]);
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
    }
  });
});
