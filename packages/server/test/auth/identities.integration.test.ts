import { createHash } from "node:crypto";
import { totpCode, totpStep } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FakeIdentity, FixedClock } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// The identities of an account and the passwordless account's path to sensitive operations, through the whole
// chain over the migrated database (doc 02 sections 2.5 and 2.8, doc 04 sections 4.4 and 10.3, doc 10 T4, T18
// and T20). The failure scenarios: an identity listed to, or unlinked by, another account; the last way to sign
// in removed, also by two unlinks that arrive together; an unlink, a first password or a turn-off of the second
// factor accepted without a re-authentication within ten minutes, or with one made by another account's
// identity; a first password that replaces one, or that is accepted for an account that has a password; and a
// response or log line that carries a subject of the provider.

const SESSION_COOKIE = "__Host-slugbase_session";
const START = "/api/v1/auth/oidc/idp/start";
const PREAUTH_COOKIE = "__Host-slugbase_oidc";
const IDENTITIES = "/api/v1/me/identities";
const PASSWORD = "/api/v1/me/password";
const REAUTH = "/api/v1/me/reauth";
const MFA = "/api/v1/me/mfa";
const MFA_START = "/api/v1/me/mfa/enrollment";
const MFA_CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const ISSUER = "https://idp.example.test";
const MINUTE = 60_000;
const STEP_MS = 30_000;
const KEY = testKey("identities-1");
const NEW_PASSWORD = "a first password for this account";

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
  readonly fake: FakeIdentity;
  readonly clock: FixedClock;
  readonly logs: ReturnType<typeof recordingLogger>;
}

function serve(): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    RATE_LIMIT_WRITE_ACCOUNT: "1000/min",
  });
  const fake = new FakeIdentity({ providers: [{ id: "idp", displayName: "Example IdP", issuer: ISSUER, clientId: "client-id-1" }] });
  const clock = new FixedClock(Date.now());
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
      tenantResolver: createAccountOnlyTenantResolver(),
      secretBox: testSecretBox(KEY),
      identity: { available: true, listProviders: () => fake.listProviders(), begin: (request) => fake.begin(request), complete: (request) => fake.complete(request) },
    },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, fake, clock, logs };
}

let number = 0;

async function link(accountId: string, subject: string, provider = "idp"): Promise<string> {
  number += 1;
  const id = `0192f3a0-dddd-7000-8000-${(0x100 + number).toString(16).padStart(12, "0")}`;
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${id}, ${accountId}, ${provider}, ${subject}, 'linked@example.test')`;
  });
  return id;
}

interface Person {
  readonly account: SeededAccount;
  readonly subject: string;
  readonly identityId: string;
}

/** An account with one identity of the provider; with `password: false` it has no password and the identity is its only way to sign in. */
async function person(options: { password?: boolean } = {}): Promise<Person> {
  number += 1;
  const account = await seedAccount(database(), { email: `identity-person${String(number)}@example.test`, password: options.password === false ? null : "the password of this person" });
  const subject = `subject-${String(number)}`;
  return { account, subject, identityId: await link(account.id, subject) };
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*);`).exec(header);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

/** The handshake of `intent` with the provider, ended the way the person would: the token of the session it leaves. */
async function throughProvider(world: World, intent: "login" | "reauth", subject: string, token: string | null): Promise<Response> {
  // The application's own page starts it, which a browser reports as same-origin.
  const cookie = { "sec-fetch-site": "same-origin", ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }) };
  const started = await world.server.fetch(new Request(new URL(`${START}?intent=${intent}`, world.origin), { headers: cookie }));
  const authorizationUrl = started.headers.get("location") ?? "";
  const preAuth = cookieValue(started, PREAUTH_COOKIE);
  const atIssuer = URL.canParse(authorizationUrl) && new URL(authorizationUrl).origin === new URL(ISSUER).origin;
  if (started.status !== 302 || !atIssuer || preAuth === undefined) {
    throw new Error(`the handshake did not start: ${authorizationUrl}`);
  }
  const callbackUrl = world.fake.approve(authorizationUrl, { subject });
  const cookies = [`${PREAUTH_COOKIE}=${preAuth}`, ...(token === null ? [] : [`${SESSION_COOKIE}=${token}`])].join("; ");
  return world.server.fetch(new Request(callbackUrl, { headers: { cookie: cookies } }));
}

async function signIn(world: World, who: Person): Promise<string> {
  const token = cookieValue(await throughProvider(world, "login", who.subject, null), SESSION_COOKIE);
  if (token === undefined) {
    throw new Error("the sign-in with the identity gave no session");
  }
  return token;
}

/** A complete session whose last re-authentication was the provider's, a moment ago. */
async function reauthenticatedSession(world: World, who: Person): Promise<string> {
  const token = await signIn(world, who);
  const response = await throughProvider(world, "reauth", who.subject, token);
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("location")).not.toContain("error");
  return token;
}

function send(world: World, method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin: world.origin, "content-type": "application/json" });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return world.server.fetch(new Request(new URL(path, world.origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

async function identityIds(accountId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM account_identities WHERE account_id = ${accountId} ORDER BY id`;
  });
  return rows.map((row) => row.id);
}

function hashOf(token: string): Buffer {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest();
}

describe("GET /api/v1/me/identities", () => {
  it("lists the account's identities, newest first, with no subject of the provider", async () => {
    const world = serve();
    const who = await person({ password: false });
    const second = await link(who.account.id, `${who.subject}-second`, "other");
    const token = await signIn(world, who);

    const response = await send(world, "GET", IDENTITIES, token);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[]; nextCursor: unknown };
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item["id"])).toEqual([second, who.identityId]);
    expect(body.items[0]).toEqual({ id: second, provider: "other", emailAtLink: "linked@example.test", createdAt: expect.any(String) as string, lastUsedAt: null });
    // The sign-in used the first identity.
    expect(body.items[1]?.["lastUsedAt"]).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain(who.subject);
  });

  it("lists the identities of the account of the session only: another account's are not there", async () => {
    const world = serve();
    const mine = await person();
    const theirs = await person();
    const token = await signIn(world, mine);

    const body = (await (await send(world, "GET", IDENTITIES, token)).json()) as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).toEqual([mine.identityId]);
    expect(JSON.stringify(body)).not.toContain(theirs.identityId);
  });

  it("pages with a cursor that is valid for the account it was issued to only", async () => {
    const world = serve();
    const who = await person();
    const other = await person();
    for (const subject of ["page-2", "page-3"]) {
      await link(who.account.id, `${who.subject}-${subject}`);
    }
    const token = await signIn(world, who);
    const otherToken = await signIn(world, other);

    const first = (await (await send(world, "GET", `${IDENTITIES}?limit=2`, token)).json()) as { items: { id: string }[]; nextCursor: string };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await (await send(world, "GET", `${IDENTITIES}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, token)).json()) as { items: { id: string }[]; nextCursor: null };
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.id).toSorted()).toEqual((await identityIds(who.account.id)).toSorted());

    const foreign = await send(world, "GET", `${IDENTITIES}?cursor=${encodeURIComponent(first.nextCursor)}`, otherToken);
    expect(foreign.status).toBe(400);
  });

  it("needs a session: 401 without one, 403 to an API token", async () => {
    const world = serve();
    const who = await person();
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: who.account.id });
    const apiToken = await seedApiToken(database(), { accountId: who.account.id, workspaceId, scope: "read-write" });

    expect((await send(world, "GET", IDENTITIES, null)).status).toBe(401);
    const bearer = await world.server.fetch(new Request(new URL(IDENTITIES, world.origin), { headers: { authorization: `Bearer ${apiToken.value}` } }));
    expect(bearer.status).toBe(403);
  });
});

describe("DELETE /api/v1/me/identities/{id}", () => {
  it("unlinks the identity of an account that has a password, and the identity signs in nothing afterwards", async () => {
    const world = serve();
    const who = await person();
    const token = await reauthenticatedSession(world, who);

    const response = await send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, token);

    expect(response.status).toBe(204);
    expect(await identityIds(who.account.id)).toEqual([]);
    const again = await throughProvider(world, "login", who.subject, null);
    expect(again.headers.get("location")).toBe("/login?error=oidc_failed");
    expect(cookieValue(again, SESSION_COOKIE)).toBeUndefined();
  });

  it("unlinks one of two identities of an account without a password", async () => {
    const world = serve();
    const who = await person({ password: false });
    const second = await link(who.account.id, `${who.subject}-second`);
    const token = await reauthenticatedSession(world, who);

    expect((await send(world, "DELETE", `${IDENTITIES}/${second}`, token)).status).toBe(204);

    expect(await identityIds(who.account.id)).toEqual([who.identityId]);
  });

  it("refuses to remove the only way to sign in with 422 validation_failed and the field code last_sign_in_method, and removes nothing", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await reauthenticatedSession(world, who);

    const response = await send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, token);

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "id", code: "last_sign_in_method" }] });
    expect(await identityIds(who.account.id)).toEqual([who.identityId]);
    // The account still signs in with the identity.
    expect(await signIn(world, who)).toEqual(expect.any(String));
  });

  it("leaves one identity when two unlinks of an account without a password arrive together", async () => {
    const world = serve();
    for (let round = 0; round < 3; round += 1) {
      const who = await person({ password: false });
      const second = await link(who.account.id, `${who.subject}-second`);
      const token = await reauthenticatedSession(world, who);

      const outcomes = await Promise.all([
        send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, token),
        send(world, "DELETE", `${IDENTITIES}/${second}`, token),
      ]);

      expect(outcomes.map((response) => response.status).toSorted(), `round ${String(round)}`).toEqual([204, 422]);
      expect(await identityIds(who.account.id), `round ${String(round)}`).toHaveLength(1);
    }
  });

  it("answers another account's identity like one that does not exist, and removes it from no one", async () => {
    const world = serve();
    const mine = await person();
    const theirs = await person({ password: false });
    const token = await reauthenticatedSession(world, mine);

    const foreign = await send(world, "DELETE", `${IDENTITIES}/${theirs.identityId}`, token);
    const unknown = await send(world, "DELETE", `${IDENTITIES}/0192f3a0-0000-7000-8000-00000000beef`, token);

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    const foreignProblem = await problem(foreign);
    expect(foreignProblem).toMatchObject({ code: "not_found" });
    expect((await problem(unknown))["detail"]).toBe(foreignProblem["detail"]);
    expect(await identityIds(theirs.account.id)).toEqual([theirs.identityId]);
    expect(await identityIds(mine.account.id)).toEqual([mine.identityId]);
  });

  it("needs a re-authentication within the last ten minutes: 401 reauth_required without one and after the window, and nothing is removed", async () => {
    const world = serve();
    const who = await person();
    const token = await signIn(world, who);

    const never = await send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, token);
    expect(never.status).toBe(401);
    expect(await problem(never)).toMatchObject({ code: "reauth_required" });

    expect((await throughProvider(world, "reauth", who.subject, token)).headers.get("location")).toBe("/");
    world.clock.advance(11 * MINUTE);
    const stale = await send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, token);
    expect(stale.status).toBe(401);
    expect(await problem(stale)).toMatchObject({ code: "reauth_required" });

    expect(await identityIds(who.account.id)).toEqual([who.identityId]);
  });

  it("is refused to an API token, and needs a session", async () => {
    const world = serve();
    const who = await person();
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: who.account.id });
    const apiToken = await seedApiToken(database(), { accountId: who.account.id, workspaceId, scope: "read-write" });

    expect((await send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, null)).status).toBe(401);
    const bearer = await world.server.fetch(new Request(new URL(`${IDENTITIES}/${who.identityId}`, world.origin), { method: "DELETE", headers: { authorization: `Bearer ${apiToken.value}` } }));
    expect(bearer.status).toBe(403);
    expect(await identityIds(who.account.id)).toEqual([who.identityId]);
  });
});

describe("POST /api/v1/me/password for an account without a password", () => {
  it("sets the first password after a re-authentication through the provider: the session continues under a new token and the others end", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await reauthenticatedSession(world, who);
    const otherDevice = await signIn(world, who);

    const response = await send(world, "POST", PASSWORD, token, { newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
    const next = /^__Host-slugbase_session=([A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    expect(next).toBeDefined();
    expect(next).not.toBe(token);
    const remaining = (await sessionRows(database(), who.account.id)).map((row) => row.token_hash.toString("hex"));
    expect(remaining).toEqual([hashOf(next ?? "").toString("hex")]);
    expect(remaining).not.toContain(hashOf(otherDevice).toString("hex"));
    expect((await send(world, "GET", "/api/v1/me", next ?? "")).status).toBe(200);
    expect(((await (await send(world, "GET", "/api/v1/me", next ?? "")).json()) as { account: { hasPassword: boolean } }).account.hasPassword).toBe(true);
    // The password works for a sign-in.
    const login = await send(world, "POST", "/api/v1/auth/login", null, { email: who.account.email, password: NEW_PASSWORD, remember: false });
    expect(login.status).toBe(200);
  });

  it("is refused without a re-authentication within ten minutes, and the account stays without a password", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await signIn(world, who);

    const never = await send(world, "POST", PASSWORD, token, { newPassword: NEW_PASSWORD });
    expect(never.status).toBe(401);
    expect(await problem(never)).toMatchObject({ code: "reauth_required" });

    expect((await throughProvider(world, "reauth", who.subject, token)).headers.get("location")).toBe("/");
    world.clock.advance(11 * MINUTE);
    const stale = await send(world, "POST", PASSWORD, token, { newPassword: NEW_PASSWORD });
    expect(stale.status).toBe(401);
    expect(await problem(stale)).toMatchObject({ code: "reauth_required" });

    expect(await store.passwordHashOf(who.account.id)).toBeNull();
  });

  it("is not satisfied by a handshake the provider answers with another account's identity", async () => {
    const world = serve();
    const who = await person({ password: false });
    const stranger = await person({ password: false });
    const token = await signIn(world, who);

    const refused = await throughProvider(world, "reauth", stranger.subject, token);
    expect(refused.headers.get("location")).toBe("/login?error=oidc_failed");

    const response = await send(world, "POST", PASSWORD, token, { newPassword: NEW_PASSWORD });
    expect(response.status).toBe(401);
    expect(await store.passwordHashOf(who.account.id)).toBeNull();
  });

  it("holds the new password to the policy: nothing is written, and the re-authentication stays", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await reauthenticatedSession(world, who);

    const response = await send(world, "POST", PASSWORD, token, { newPassword: "short" });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "weak_password" });
    expect(await store.passwordHashOf(who.account.id)).toBeNull();
  });

  it("refuses a current password the account cannot have, with the answer of a wrong one", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await reauthenticatedSession(world, who);

    const response = await send(world, "POST", PASSWORD, token, { currentPassword: "a password it never set", newPassword: NEW_PASSWORD });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed", errors: [{ path: "currentPassword", code: "invalid_password" }] });
    expect(await store.passwordHashOf(who.account.id)).toBeNull();
  });
});

describe("POST /api/v1/me/password for an account with a password", () => {
  it("is not changed without the current password, even by a session that re-authenticated through the provider, and still is with it", async () => {
    const world = serve();
    const who = await person();
    const before = await store.passwordHashOf(who.account.id);
    const token = await reauthenticatedSession(world, who);

    const without = await send(world, "POST", PASSWORD, token, { newPassword: NEW_PASSWORD });
    expect(without.status).toBe(422);
    const missing = await problem(without);
    expect(missing).toMatchObject({ code: "validation_failed", errors: [{ path: "currentPassword", code: "invalid_password" }] });
    const wrong = await send(world, "POST", PASSWORD, token, { currentPassword: "not the password", newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(422);
    expect((await problem(wrong))["detail"]).toBe(missing["detail"]);
    expect(await store.passwordHashOf(who.account.id)).toBe(before);

    const right = await send(world, "POST", PASSWORD, token, { currentPassword: who.account.password, newPassword: NEW_PASSWORD });
    expect(right.status).toBe(204);
    expect(await store.passwordHashOf(who.account.id)).not.toBe(before);
  });
});

describe("POST /api/v1/me/reauth for an account without a password", () => {
  it("is not satisfied by a password: the provider is the way, and the session is not marked", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await signIn(world, who);

    const response = await send(world, "POST", REAUTH, token, { password: "any password at all" });

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect((await store.lookupSession(hashOf(token)))?.reauthAt).toBeNull();
  });
});

describe("DELETE /api/v1/me/mfa for an account without a password", () => {
  async function codeAt(world: World, accountId: string): Promise<string> {
    const state = await store.mfaStateOf(accountId);
    if (state === undefined) {
      throw new Error("the account has no secret");
    }
    const secret = await testSecretBox(KEY).open(state.secret, mfaSecretOptions(accountId));
    return totpCode(secret, totpStep(world.clock.now().getTime()));
  }

  /** The account enrols the authenticator after a re-authentication through its provider; its session is the one the enrolment left. */
  async function withSecondFactor(world: World, who: Person): Promise<string> {
    const token = await reauthenticatedSession(world, who);
    expect((await send(world, "POST", MFA_START, token)).status).toBe(200);
    const confirmed = await send(world, "POST", MFA_CONFIRM, token, { code: await codeAt(world, who.account.id) });
    expect(confirmed.status).toBe(200);
    world.clock.advance(STEP_MS);
    return /^__Host-slugbase_session=([A-Za-z0-9_-]{43});/.exec(confirmed.headers.get("set-cookie") ?? "")?.[1] ?? "";
  }

  it("turns the factor off with a code and the re-authentication through the provider in place of a password", async () => {
    const world = serve();
    const who = await person({ password: false });
    const enrolled = await withSecondFactor(world, who);
    expect((await throughProvider(world, "reauth", who.subject, enrolled)).headers.get("location")).toBe("/");

    const response = await send(world, "DELETE", MFA, enrolled, { code: await codeAt(world, who.account.id) });

    expect(response.status).toBe(204);
    expect(await store.mfaStateOf(who.account.id)).toBeUndefined();
  });

  it("still needs a code, and a password given by an account that has none is refused, nothing turned off", async () => {
    const world = serve();
    const who = await person({ password: false });
    const enrolled = await withSecondFactor(world, who);
    expect((await throughProvider(world, "reauth", who.subject, enrolled)).headers.get("location")).toBe("/");

    const noCode = await send(world, "DELETE", MFA, enrolled, {});
    expect(noCode.status).toBe(422);
    const withPassword = await send(world, "DELETE", MFA, enrolled, { password: "any password at all", code: await codeAt(world, who.account.id) });
    expect(withPassword.status).toBe(422);
    expect(await problem(withPassword)).toMatchObject({ code: "validation_failed", errors: [{ path: "password", code: "invalid_password" }] });
    const wrongCode = await send(world, "DELETE", MFA, enrolled, { code: "000000" });
    expect(wrongCode.status).toBe(422);

    expect((await store.mfaStateOf(who.account.id))?.enabledAt).not.toBeNull();
  });

  it("is not done without the re-authentication: 401 reauth_required, and the factor stays on", async () => {
    const world = serve();
    const who = await person({ password: false });
    const enrolled = await withSecondFactor(world, who);
    world.clock.advance(11 * MINUTE);

    const response = await send(world, "DELETE", MFA, enrolled, { code: await codeAt(world, who.account.id) });

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect((await store.mfaStateOf(who.account.id))?.enabledAt).not.toBeNull();
  });
});

describe("the identity routes and the log", () => {
  it("never put the subject of a provider in a response or a log line", async () => {
    const world = serve();
    const who = await person({ password: false });
    const token = await reauthenticatedSession(world, who);
    const responses = [
      await send(world, "GET", IDENTITIES, token),
      await send(world, "DELETE", `${IDENTITIES}/${who.identityId}`, token),
    ];
    const texts = await Promise.all(responses.map((response) => response.text()));
    expect(JSON.stringify([texts, world.logs.entries, world.logs.requests])).not.toContain(who.subject);
  });
});
