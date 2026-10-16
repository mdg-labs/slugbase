import { randomBytes } from "node:crypto";
import { FakeIdentity, type FakeIdentityGrant } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthStore } from "@slugbase/db";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { disableAccount, issuedToken, seedAccount, seedApiToken, seedMembership, seedWorkspace, sessionRows, sha256, storeFor, type SeededAccount } from "./support.ts";

// OIDC sign-in with an identity that is already linked, through the whole chain over the migrated database (doc
// 02 sections 2.3 and 2.8, doc 04 section 4.5, doc 10 T4, T12 and T20). The provider is a FakeIdentity that
// checks what a relying party must check and can break any of it. The failure scenarios are a callback that
// ends in a session when it must not (a tampered nonce, another audience or issuer, an expired token, a
// replayed state, a callback from another browser, an identity nobody linked, a disabled account) and an answer
// that tells those cases apart.
// The link and reauth intents add: an identity linked to, or accepted as proof for, an account that did not
// start the handshake (another account's browser session, no session, an identity another account holds), a
// link or re-authentication started by a page of another site or by a session still waiting for its second
// factor, and a re-authentication that counts without the account's own identity.

const SESSION_COOKIE = "__Host-slugbase_session";
const PREAUTH_COOKIE = "__Host-slugbase_oidc";
const ISSUER = "https://idp.example.test";
const CLIENT_ID = "client-id-1";
const START = "/api/v1/auth/oidc/idp/start";
const CALLBACK = "/api/v1/auth/oidc/idp/callback";
const FAILED = "/login?error=oidc_failed";
const SUBJECT = "subject-linked";

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
  readonly logs: ReturnType<typeof recordingLogger>;
}

function serve(env: Record<string, string> = {}, identity?: FakeIdentity): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    ...env,
  });
  const fake = identity ?? new FakeIdentity({ providers: [{ id: "idp", displayName: "Example IdP", issuer: ISSUER, clientId: CLIENT_ID }] });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
      tenantResolver: createAccountOnlyTenantResolver(),
      secretBox: testSecretBox(testKey("oidc-1")),
      identity: { available: true, listProviders: () => fake.listProviders(), begin: (request) => fake.begin(request), complete: (request) => fake.complete(request) },
    },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
  });
  return { server, origin: config.APP_ORIGIN, fake, logs };
}

let linkedNumber = 0;

/** An account with its OIDC identity linked; linking is the work of later operations, so the fixture writes the row as the table owner. */
async function linkedAccount(options: { subject?: string; disabled?: boolean; mfa?: boolean } = {}): Promise<{ account: SeededAccount; subject: string }> {
  linkedNumber += 1;
  const account = await seedAccount(database(), { email: `oidc-person${String(linkedNumber)}@example.test`, password: null });
  const subject = options.subject ?? `${SUBJECT}-${String(linkedNumber)}`;
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${account.id}, true)`;
    await tx`
      INSERT INTO account_identities (id, account_id, provider, subject, email_at_link)
      VALUES (${`0192f3a0-dddd-7000-8000-${linkedNumber.toString(16).padStart(12, "0")}`}, ${account.id}, 'idp', ${subject}, ${account.email})`;
  });
  if (options.mfa === true) {
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.alloc(40, 3)}, mfa_secret_key_id = 'oidc-1', mfa_enabled_at = now() WHERE id = ${account.id}`;
    });
  }
  if (options.disabled === true) {
    await disableAccount(database(), account.id);
  }
  return { account, subject };
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

function start(world: World, query = "", cookie?: string): Promise<Response> {
  return world.server.fetch(new Request(new URL(`${START}${query}`, world.origin), { headers: cookie === undefined ? {} : { cookie } }));
}

function callback(world: World, url: string, preAuth: string | undefined, extra: Record<string, string> = {}): Promise<Response> {
  const headers = new Headers(extra);
  if (preAuth !== undefined) {
    headers.set("cookie", [headers.get("cookie"), `${PREAUTH_COOKIE}=${preAuth}`].filter((part) => part !== null).join("; "));
  }
  return world.server.fetch(new Request(url, { headers }));
}

interface Begun {
  readonly authorizationUrl: string;
  readonly preAuth: string;
  readonly state: string;
}

async function begin(world: World, query = "", headers: Record<string, string> = {}): Promise<Begun> {
  const response = await startWith(world, query, headers);
  const authorizationUrl = response.headers.get("location") ?? "";
  const preAuth = cookieValue(response, PREAUTH_COOKIE);
  const state = new URL(authorizationUrl, world.origin).searchParams.get("state");
  if (response.status !== 302 || preAuth === undefined || state === null) {
    throw new Error(`the handshake did not start: ${String(response.status)}`);
  }
  return { authorizationUrl, preAuth, state };
}

/** Starts a handshake and plays the person approving it: the address the provider sends the browser back to. */
async function approved(world: World, grant: FakeIdentityGrant, query = "", headers: Record<string, string> = {}): Promise<Begun & { readonly callbackUrl: string }> {
  const begun = await begin(world, query, headers);
  return { ...begun, callbackUrl: world.fake.approve(begun.authorizationUrl, grant) };
}

async function sessionCount(accountId: string): Promise<number> {
  return (await sessionRows(database(), accountId)).length;
}

async function stateCount(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: string }[]>`SELECT count(*)::text AS n FROM oidc_login_states`;
  });
  return Number(rows[0]?.n);
}

function expectFailed(response: Response): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(FAILED);
  expect(cookieValue(response, SESSION_COOKIE)).toBeUndefined();
  expect(response.headers.getSetCookie().filter((header) => header.startsWith(`${PREAUTH_COOKIE}=;`))).toHaveLength(1);
}

describe("GET /api/v1/auth/oidc/{provider}/start", () => {
  it("stores the handshake and sends the browser to the provider with PKCE (S256), a state and a nonce, binding it to the browser with a pre-auth cookie", async () => {
    const world = serve();
    const before = await stateCount();
    const response = await start(world);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    const params = Object.fromEntries(location.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${world.origin}${CALLBACK}`,
      code_challenge_method: "S256",
    });
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(params[name], name).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith(`${PREAUTH_COOKIE}=`)) ?? "";
    expect(cookie).toMatch(new RegExp(`^${PREAUTH_COOKIE}=[A-Za-z0-9_-]{43}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax; Secure$`));
    expect(await stateCount()).toBe(before + 1);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("stores the state as a hash, the nonce, the validated return path and the PKCE verifier sealed by the secret box, for ten minutes", async () => {
    const world = serve();
    const { state } = await begin(world, "?returnTo=/go/docs%3Fa%3Db");
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ provider: string; intent: string; nonce: string; code_verifier: Buffer; code_verifier_key_id: string; return_to: string; link_account_id: string | null; minutes: string }[]>`
        SELECT provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id, extract(epoch FROM expires_at - now()) / 60 AS minutes
        FROM oidc_login_states WHERE state_hash = ${sha256(Buffer.from(state))}`;
    });
    const row = rows[0];
    expect(row).toMatchObject({ provider: "idp", intent: "login", code_verifier_key_id: "oidc-1", return_to: "/go/docs?a=b", link_account_id: null });
    expect(row?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A sealed 43-character verifier is the IV, the encrypted bytes and the tag.
    expect(row?.code_verifier).toHaveLength(12 + 43 + 16);
    expect(Number(row?.minutes)).toBeGreaterThan(9.5);
    expect(Number(row?.minutes)).toBeLessThanOrEqual(10);
  });

  it("accepts a returnTo that is a path of this application and keeps the root for every other, whatever it looks like (T12)", async () => {
    const world = serve();
    const cases: [string, string][] = [
      ["/go/docs", "/go/docs"],
      ["https://evil.example/", "/"],
      ["//evil.example", "/"],
      ["/\\evil.example", "/"],
      ["/.//evil.example", "/"],
      ["javascript:alert(1)", "/"],
      ["", "/"],
    ];
    for (const [given, stored] of cases) {
      const { state } = await begin(world, `?returnTo=${encodeURIComponent(given)}`);
      const rows = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ return_to: string }[]>`SELECT return_to FROM oidc_login_states WHERE state_hash = ${sha256(Buffer.from(state))}`;
      });
      expect(rows[0]?.return_to, given).toBe(stored);
    }
  });

  it("names the pre-auth cookie plainly and without Secure when the deployment is served over http", async () => {
    const world = serve({ APP_ORIGIN: "http://localhost:3000" });
    const response = await start(world);
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith("slugbase_oidc=")) ?? "";
    expect(cookie).toMatch(/^slugbase_oidc=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/);
  });

  it("sends the browser to /login with the generic failure code, storing nothing, for a provider the server does not have", async () => {
    const world = serve();
    const before = await stateCount();
    const response = await world.server.fetch(new Request(new URL("/api/v1/auth/oidc/unknown/start", world.origin)));
    expectFailed(response);
    expect(await stateCount()).toBe(before);
  });

  it("does the same when no provider is configured at all", async () => {
    const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), RATE_LIMIT_LOGIN_IP: "1000/min" });
    const server = createServer({
      config,
      adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver(), secretBox: testSecretBox(testKey("oidc-1")) },
      modules: [],
      migrations: [],
      logger: recordingLogger(),
      database: tenantDatabase(database()),
      authStore: store,
    });
    expectFailed(await server.fetch(new Request(new URL(START, config.APP_ORIGIN))));
  });

  it("is limited per address in the login bucket", async () => {
    const world = serve({ RATE_LIMIT_LOGIN_IP: "2/min" });
    expect((await start(world)).status).toBe(302);
    expect((await start(world)).status).toBe(302);
    const limited = await start(world);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
  });

  it("refuses a query it does not declare, and an intent it does not know, as any operation does", async () => {
    const world = serve();
    expect((await start(world, "?unknown=1")).status).toBe(422);
    expect((await start(world, "?intent=delete")).status).toBe(422);
    expect((await start(world, "?intent=invite")).status).toBe(422);
  });

  it("starts a sign-in for the explicit login intent, as it does without one", async () => {
    const world = serve();
    const { state } = await begin(world, "?intent=login");
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ intent: string; link_account_id: string | null }[]>`SELECT intent, link_account_id FROM oidc_login_states WHERE state_hash = ${sha256(Buffer.from(state))}`;
    });
    expect(rows[0]).toEqual({ intent: "login", link_account_id: null });
  });
});

describe("GET /api/v1/auth/oidc/{provider}/callback", () => {
  it("signs in the account the identity is linked to with a new full session, records the sign-in, and sends the browser to the returnTo", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const flow = await approved(world, { subject, email: account.email, emailVerified: true }, "?returnTo=/go/docs");

    const response = await callback(world, flow.callbackUrl, flow.preAuth, { "user-agent": "oidc test agent", "x-forwarded-for": "203.0.113.9" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/go/docs");
    const token = issuedToken(response);
    expect(token).toBeDefined();
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.find((header) => header.startsWith(`${SESSION_COOKIE}=`))).toMatch(/; Max-Age=15552000; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    expect(cookies.find((header) => header.startsWith(`${PREAUTH_COOKIE}=`))).toMatch(/^__Host-slugbase_oidc=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax; Secure; Expires=/);
    const sessions = await sessionRows(database(), account.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ level: "full", remember: false, user_agent: "oidc test agent" });
    expect(sessions[0]?.token_hash.equals(sha256(Buffer.from(token ?? "", "base64url")))).toBe(true);
    expect(await store.lookupSession(sha256(Buffer.from(token ?? "", "base64url")))).toMatchObject({ accountId: account.id, level: "full" });
    const recorded = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ last_used_at: Date | null; last_sign_in_at: Date | null }[]>`
        SELECT i.last_used_at, a.last_sign_in_at FROM account_identities i JOIN accounts a ON a.id = i.account_id WHERE a.id = ${account.id}`;
    });
    expect(recorded[0]?.last_used_at).toBeInstanceOf(Date);
    expect(recorded[0]?.last_sign_in_at).toBeInstanceOf(Date);

    const signedIn = await world.server.fetch(new Request(new URL("/api/v1/me/sessions", world.origin), { headers: { cookie: `${SESSION_COOKIE}=${token ?? ""}` } }));
    expect(signedIn.status).toBe(200);
  });

  it("never asks for a SlugBase code: an account with a second factor gets a full session", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount({ mfa: true });
    const flow = await approved(world, { subject });

    const response = await callback(world, flow.callbackUrl, flow.preAuth);

    expect(response.headers.get("location")).toBe("/");
    expect((await sessionRows(database(), account.id)).map((row) => row.level)).toEqual(["full"]);
    const token = issuedToken(response) ?? "";
    expect((await world.server.fetch(new Request(new URL("/api/v1/me/sessions", world.origin), { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))).status).toBe(200);
  });

  it("replaces the session of the cookie the request carried and gives every sign-in a token of its own", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const one = await approved(world, { subject });
    const signedIn = await callback(world, one.callbackUrl, one.preAuth);
    const token = issuedToken(signedIn) ?? "";
    expect(token).not.toBe("");

    const two = await approved(world, { subject });
    const again = await callback(world, two.callbackUrl, two.preAuth, { cookie: `${SESSION_COOKIE}=${token}` });
    const next = issuedToken(again) ?? "";

    expect(next).not.toBe(token);
    const hashes = (await sessionRows(database(), account.id)).map((row) => row.token_hash.toString("hex"));
    expect(hashes).toEqual([sha256(Buffer.from(next, "base64url")).toString("hex")]);
  });

  it("tolerates the parameters a provider adds to its redirect", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const flow = await approved(world, { subject });
    const response = await callback(world, `${flow.callbackUrl}&iss=${encodeURIComponent(ISSUER)}&scope=openid+email&authuser=0&prompt=consent&session_state=abc`, flow.preAuth);
    expect(response.headers.get("location")).toBe("/");
    expect(await sessionCount(account.id)).toBe(1);
  });

  describe("ends without a session, on /login with one generic failure code", () => {
    it.each<[string, FakeIdentityGrant]>([
      ["a tampered nonce", { subject: "x", nonce: "the-nonce-of-another-request" }],
      ["another audience", { subject: "x", audience: "another-client" }],
      ["another issuer", { subject: "x", issuer: "https://evil.example.test" }],
      ["an expired token", { subject: "x", expiresInSeconds: -5 }],
    ])("for %s", async (_name, fault) => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { ...fault, subject });

      expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));

      expect(await sessionCount(account.id)).toBe(0);
      expect(world.logs.entries.at(-1)).toMatchObject({ message: "An OIDC sign-in ended without a session", fields: { provider: "idp", reason: "invalid_token" } });
    });

    it("for a replayed state: the first callback signs in, the same address and cookie again does not", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });

      expect((await callback(world, flow.callbackUrl, flow.preAuth)).headers.get("location")).toBe("/");
      expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));

      expect(await sessionCount(account.id)).toBe(1);
    });

    it("for a callback from another browser, which holds no pre-auth cookie, and leaves the state to the browser that started it", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });
      const before = await stateCount();

      expectFailed(await callback(world, flow.callbackUrl, undefined));
      expect(await sessionCount(account.id)).toBe(0);
      expect(await stateCount()).toBe(before);

      expect((await callback(world, flow.callbackUrl, flow.preAuth)).headers.get("location")).toBe("/");
      expect(await sessionCount(account.id)).toBe(1);
    });

    it("for a pre-auth cookie of another handshake, a cookie that is not a binding and one that is empty", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });
      const other = await begin(world);

      for (const preAuth of [other.preAuth, flow.state, "x".repeat(43), ""]) {
        expectFailed(await callback(world, flow.callbackUrl, preAuth));
      }
      expect(await sessionCount(account.id)).toBe(0);
    });

    it("for a state that expired", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE oidc_login_states SET expires_at = now() - interval '1 second' WHERE state_hash = ${sha256(Buffer.from(flow.state))}`;
      });

      expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));
      expect(await sessionCount(account.id)).toBe(0);
    });

    it("for a state of another provider's callback, which leaves the state to its own", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });

      const wrong = await callback(world, flow.callbackUrl.replace(CALLBACK, "/api/v1/auth/oidc/other/callback"), flow.preAuth);
      expectFailed(wrong);
      expect((await callback(world, flow.callbackUrl, flow.preAuth)).headers.get("location")).toBe("/");
      expect(await sessionCount(account.id)).toBe(1);
    });

    it("for an identity nobody linked, and answers it as it answers a failed validation", async () => {
      const world = serve();
      const { account } = await linkedAccount();
      const unknown = await approved(world, { subject: "nobody-linked-this", email: account.email, emailVerified: true });
      const failedUnknown = await callback(world, unknown.callbackUrl, unknown.preAuth);
      const forged = await approved(world, { subject: "nobody-linked-this", nonce: "other" });
      const failedForged = await callback(world, forged.callbackUrl, forged.preAuth);

      expectFailed(failedUnknown);
      expectFailed(failedForged);
      expect(await sessionCount(account.id)).toBe(0);
      expect(failedUnknown.headers.getSetCookie().map((header) => header.split("=")[0])).toEqual(failedForged.headers.getSetCookie().map((header) => header.split("=")[0]));
      expect(await failedUnknown.text()).toBe(await failedForged.text());
    });

    it("for a disabled account, as for an identity nobody linked", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount({ disabled: true });
      const flow = await approved(world, { subject });

      expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));
      expect(await sessionCount(account.id)).toBe(0);
    });

    it("for a refusal by the provider, using up the state", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });
      const refusal = `${world.origin}${CALLBACK}?error=access_denied&state=${flow.state}`;

      expectFailed(await callback(world, refusal, flow.preAuth));
      expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));
      expect(await sessionCount(account.id)).toBe(0);
    });

    it("for a callback without a code, a code that is repeated, a state that is not one and a state that is repeated", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });
      const code = new URL(flow.callbackUrl).searchParams.get("code") ?? "";
      const base = `${world.origin}${CALLBACK}`;

      expectFailed(await callback(world, `${base}?state=${flow.state}`, flow.preAuth));
      const fresh = await approved(world, { subject });
      const freshCode = new URL(fresh.callbackUrl).searchParams.get("code") ?? "";
      expectFailed(await callback(world, `${base}?state=${fresh.state}&code=${freshCode}&code=${freshCode}`, fresh.preAuth));
      expectFailed(await callback(world, `${base}?code=${code}`, flow.preAuth));
      expectFailed(await callback(world, `${base}?code=${code}&state=not-a-state`, flow.preAuth));
      expectFailed(await callback(world, `${base}?code=${code}&state=${flow.state}&state=${flow.state}`, flow.preAuth));
      expectFailed(await callback(world, base, undefined));
      expect(await sessionCount(account.id)).toBe(0);
    });

    it("for a code the provider refuses", async () => {
      const world = serve();
      const { account, subject } = await linkedAccount();
      const flow = await approved(world, { subject });

      expectFailed(await callback(world, flow.callbackUrl.replace(/code=[^&]+/, "code=forged-code"), flow.preAuth));
      expect(await sessionCount(account.id)).toBe(0);
      expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "exchange_failed" } });
    });

    it("for a provider the server does not have, and when none is configured", async () => {
      const world = serve();
      expectFailed(await callback(world, `${world.origin}/api/v1/auth/oidc/unknown/callback?code=c&state=${"A".repeat(43)}`, "x".repeat(43)));
    });
  });

  it("does not put a state, a code, a subject or a token in the log", async () => {
    const world = serve();
    const { subject } = await linkedAccount();
    const flow = await approved(world, { subject, nonce: "tampered" });
    const code = new URL(flow.callbackUrl).searchParams.get("code") ?? "";
    await callback(world, flow.callbackUrl, flow.preAuth);
    const logged = JSON.stringify([...world.logs.entries, ...world.logs.requests]);
    for (const secret of [flow.state, flow.preAuth, code, subject]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("is limited per address in the login bucket", async () => {
    const world = serve({ RATE_LIMIT_LOGIN_IP: "2/min" });
    const url = `${world.origin}${CALLBACK}?code=c&state=${"A".repeat(43)}`;
    expect((await callback(world, url, undefined)).status).toBe(302);
    expect((await callback(world, url, undefined)).status).toBe(302);
    expect((await callback(world, url, undefined)).status).toBe(429);
  });
});

/** The whole sign-in with an identity, to hold a complete session of a passwordless account: its token. */
async function signedInToken(world: World, account: SeededAccount, subject: string): Promise<string> {
  const flow = await approved(world, { subject, email: account.email, emailVerified: true });
  const response = await callback(world, flow.callbackUrl, flow.preAuth);
  const token = issuedToken(response);
  if (token === undefined) {
    throw new Error("the sign-in did not give a session");
  }
  return token;
}

/** A complete session that has just re-authenticated through its provider, as linking an identity needs. */
async function freshToken(world: World, account: SeededAccount, subject: string): Promise<string> {
  const token = await signedInToken(world, account, subject);
  const flow = await approved(world, { subject }, "?intent=reauth", { cookie: sessionCookie(token) });
  expect((await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) })).headers.get("location")).not.toBe(FAILED);
  expect((await reauthAtOf(token))?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  return token;
}

/** Moves the re-authentication of a session back in time, as the minutes passing would. */
async function ageReauth(token: string, minutes: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE sessions SET reauth_at = now() - make_interval(mins => ${minutes}) WHERE token_hash = ${sha256(Buffer.from(token, "base64url"))}`;
  });
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

async function storedState(state: string): Promise<{ intent: string; link_account_id: string | null; return_to: string } | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ intent: string; link_account_id: string | null; return_to: string }[]>`
      SELECT intent, link_account_id, return_to FROM oidc_login_states WHERE state_hash = ${sha256(Buffer.from(state))}`;
  });
  return rows[0];
}

async function identitiesOf(accountId: string): Promise<{ provider: string; subject: string; email_at_link: string }[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ provider: string; subject: string; email_at_link: string }[]>`
      SELECT provider, subject, email_at_link FROM account_identities WHERE account_id = ${accountId} ORDER BY created_at, id`;
  });
}

async function reauthAtOf(token: string): Promise<Date | null | undefined> {
  return (await store.lookupSession(sha256(Buffer.from(token, "base64url"))))?.reauthAt;
}

// A browser following a link inside the application says so with Sec-Fetch-Site: same-origin; a test that means
// another origin, the address bar or no header at all sets (or clears) it itself.
function startWith(world: World, query: string, headers: Record<string, string>): Promise<Response> {
  return world.server.fetch(new Request(new URL(`${START}${query}`, world.origin), { headers: { "sec-fetch-site": "same-origin", ...headers } }));
}

describe("GET /api/v1/auth/oidc/{provider}/start with the link and reauth intents", () => {
  it.each(["link", "reauth"] as const)("stores a %s handshake for the account of the complete session that started it", async (intent) => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);

    const response = await startWith(world, `?intent=${intent}&returnTo=/settings/security`, { cookie: sessionCookie(token) });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    // Only a re-authentication asks the provider for the credentials again.
    expect(location.searchParams.get("prompt")).toBe(intent === "reauth" ? "login" : null);
    expect(cookieValue(response, PREAUTH_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = location.searchParams.get("state") ?? "";
    expect(await storedState(state)).toEqual({ intent, link_account_id: account.id, return_to: "/settings/security" });
  });

  it.each(["link", "reauth"] as const)("sends a request without a session to the generic failure and stores nothing for %s", async (intent) => {
    const world = serve();
    const before = await stateCount();

    expectFailed(await start(world, `?intent=${intent}`));
    expectFailed(await startWith(world, `?intent=${intent}`, { cookie: sessionCookie("A".repeat(43)) }));

    expect(await stateCount()).toBe(before);
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "no_session" } });
  });

  it.each(["link", "reauth"] as const)("refuses a %s from a page of another site, a sibling subdomain included, or without Sec-Fetch-Site, and starts one from the application or the address bar", async (intent) => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const before = await stateCount();

    for (const site of ["cross-site", "same-site"]) {
      expectFailed(await startWith(world, `?intent=${intent}`, { cookie: sessionCookie(token), "sec-fetch-site": site }));
    }
    // A browser that sends no Sec-Fetch-Site cannot show the request came from the application.
    expectFailed(await world.server.fetch(new Request(new URL(`${START}?intent=${intent}`, world.origin), { headers: { cookie: sessionCookie(token) } })));
    expect(await stateCount()).toBe(before);
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "cross_site_start" } });

    for (const site of ["same-origin", "none"]) {
      expect((await startWith(world, `?intent=${intent}`, { cookie: sessionCookie(token), "sec-fetch-site": site })).headers.get("location")).toContain(ISSUER);
    }
  });

  it("refuses a session that is still waiting for its second factor", async () => {
    const world = serve();
    const { account } = await linkedAccount({ mfa: true });
    const secret = randomBytes(32);
    expect(await store.createSession({ id: "0192f3a0-eeee-7000-8000-000000000001", accountId: account.id, level: "partial", remember: false, ipPrefix: null, userAgent: null, tokenHash: sha256(secret), replacedTokenHash: null })).toBe(true);
    const before = await stateCount();

    expectFailed(await startWith(world, "?intent=link", { cookie: sessionCookie(secret.toString("base64url")) }));

    expect(await stateCount()).toBe(before);
  });

  it("refuses an API token, whatever its scope", async () => {
    const world = serve();
    const { account } = await linkedAccount();
    const workspaceId = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId, accountId: account.id });
    const apiToken = await seedApiToken(database(), { accountId: account.id, workspaceId, scope: "read-write" });
    const before = await stateCount();

    expectFailed(await startWith(world, "?intent=link", { authorization: `Bearer ${apiToken.value}` }));

    expect(await stateCount()).toBe(before);
  });
});

describe("linking an identity needs a fresh re-authentication (T18)", () => {
  async function expectReauthRequired(response: Response): Promise<void> {
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 401, code: "reauth_required" });
    expect(response.headers.get("location")).toBeNull();
    expect(cookieValue(response, PREAUTH_COOKIE)).toBeUndefined();
  }

  it("answers 401 reauth_required to a start of the link intent from a session that has never re-authenticated, storing nothing", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);
    const before = await stateCount();

    await expectReauthRequired(await startWith(world, "?intent=link&returnTo=/settings/security", { cookie: sessionCookie(token) }));

    expect(await stateCount()).toBe(before);
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "reauth_required" } });
  });

  it("answers it as well once the ten minutes have passed, and starts a link inside the window", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);

    await ageReauth(token, 9);
    expect((await startWith(world, "?intent=link", { cookie: sessionCookie(token) })).headers.get("location")).toContain(ISSUER);
    await ageReauth(token, 11);
    await expectReauthRequired(await startWith(world, "?intent=link", { cookie: sessionCookie(token) }));
  });

  it("lets the same session start a link after it re-authenticates, with the provider's reauth intent", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);
    await expectReauthRequired(await startWith(world, "?intent=link", { cookie: sessionCookie(token) }));

    const flow = await approved(world, { subject }, "?intent=reauth", { cookie: sessionCookie(token) });
    expect((await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) })).headers.get("location")).toBe("/");

    const linking = await approved(world, { subject: "after-reauth" }, "?intent=link", { cookie: sessionCookie(token) });
    expect((await callback(world, linking.callbackUrl, linking.preAuth, { cookie: sessionCookie(token) })).headers.get("location")).toBe("/");
    expect(await identitiesOf(account.id)).toMatchObject([{ subject }, { subject: "after-reauth" }]);
  });

  it("starts the reauth and login intents without a fresh re-authentication", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);
    await ageReauth(token, 60);

    for (const query of ["?intent=reauth", "?intent=login", ""]) {
      const response = await startWith(world, query, { cookie: sessionCookie(token) });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(ISSUER);
    }
  });

  it("keeps the generic failure for a request without a session or from another site, whatever the re-authentication", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);

    expectFailed(await start(world, "?intent=link"));
    expectFailed(await startWith(world, "?intent=link", { cookie: sessionCookie(token), "sec-fetch-site": "cross-site" }));
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "cross_site_start" } });
  });

  it("links nothing when the window lapses between the start and the callback, and links through a new handshake after a re-authentication", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const flow = await approved(world, { subject: "lapsed" }, "?intent=link", { cookie: sessionCookie(token) });
    await ageReauth(token, 11);

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) }));

    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "reauth_required" } });
    expect(await identitiesOf(account.id)).toMatchObject([{ subject }]);
    // The state is used up, so the same address does not work after the member re-authenticates either.
    const reauthFlow = await approved(world, { subject }, "?intent=reauth", { cookie: sessionCookie(token) });
    await callback(world, reauthFlow.callbackUrl, reauthFlow.preAuth, { cookie: sessionCookie(token) });
    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) }));
    expect(await identitiesOf(account.id)).toHaveLength(1);
    const again = await approved(world, { subject: "lapsed" }, "?intent=link", { cookie: sessionCookie(token) });
    expect((await callback(world, again.callbackUrl, again.preAuth, { cookie: sessionCookie(token) })).headers.get("location")).toBe("/");
    expect(await identitiesOf(account.id)).toMatchObject([{ subject }, { subject: "lapsed" }]);
  });

  it("does not link for a reauth handshake whose session never re-authenticated, only counting it as a re-authentication", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);
    const flow = await approved(world, { subject: "not-a-link" }, "?intent=reauth", { cookie: sessionCookie(token) });

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) }));

    expect(await identitiesOf(account.id)).toHaveLength(1);
    expect(await reauthAtOf(token)).toBeNull();
  });
});

describe("GET /api/v1/auth/oidc/{provider}/callback with the link intent", () => {
  it("adds the identity to the account of the browser's session, with the address the provider asserted, and changes no session", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const flow = await approved(world, { subject: "second-identity", email: "second@idp.example.test", emailVerified: true }, "?intent=link&returnTo=/settings/security", { cookie: sessionCookie(token) });

    const response = await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/settings/security");
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.getSetCookie()[0]).toMatch(new RegExp(`^${PREAUTH_COOKIE}=; Max-Age=0;`));
    expect(await identitiesOf(account.id)).toMatchObject([{ subject }, { provider: "idp", subject: "second-identity", email_at_link: "second@idp.example.test" }]);
    expect(await store.lookupSession(sha256(Buffer.from(token, "base64url")))).toMatchObject({ accountId: account.id });
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("takes the identity from no one: an identity another account holds is refused with the generic failure, and stays where it is", async () => {
    const world = serve();
    const mine = await linkedAccount();
    const theirs = await linkedAccount({ subject: "held-by-the-other-account" });
    const token = await freshToken(world, mine.account, mine.subject);
    const flow = await approved(world, { subject: "held-by-the-other-account" }, "?intent=link", { cookie: sessionCookie(token) });

    const response = await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) });

    expectFailed(response);
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "identity_in_use" } });
    expect((await identitiesOf(mine.account.id)).map((row) => row.subject)).toEqual([mine.subject]);
    expect((await identitiesOf(theirs.account.id)).map((row) => row.subject)).toEqual(["held-by-the-other-account"]);
  });

  it("answers the refusal for an identity another account holds as it answers a failed validation", async () => {
    const world = serve();
    const mine = await linkedAccount();
    await linkedAccount({ subject: "held-too" });
    const token = await freshToken(world, mine.account, mine.subject);
    const taken = await approved(world, { subject: "held-too" }, "?intent=link", { cookie: sessionCookie(token) });
    const forged = await approved(world, { subject: "held-too", nonce: "other" }, "?intent=link", { cookie: sessionCookie(token) });

    const refused = await callback(world, taken.callbackUrl, taken.preAuth, { cookie: sessionCookie(token) });
    const invalid = await callback(world, forged.callbackUrl, forged.preAuth, { cookie: sessionCookie(token) });

    expectFailed(refused);
    expectFailed(invalid);
    expect(refused.headers.getSetCookie()).toEqual(invalid.headers.getSetCookie());
    expect(await refused.text()).toBe(await invalid.text());
  });

  it("adds the identity to the account that started the handshake and no other: the browser of another account's session is refused, the state used up", async () => {
    const world = serve();
    const starter = await linkedAccount();
    const other = await linkedAccount();
    const starterToken = await freshToken(world, starter.account, starter.subject);
    const otherToken = await freshToken(world, other.account, other.subject);
    const flow = await approved(world, { subject: "carried-over" }, "?intent=link", { cookie: sessionCookie(starterToken) });

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(otherToken) }));
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "session_mismatch" } });
    // The right browser cannot use it afterwards either.
    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(starterToken) }));

    expect(await identitiesOf(starter.account.id)).toHaveLength(1);
    expect(await identitiesOf(other.account.id)).toHaveLength(1);
  });

  it("refuses a browser with no session at all, and a signed-out one that ends the handshake", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const flow = await approved(world, { subject: "signed-out-link" }, "?intent=link", { cookie: sessionCookie(token) });

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));

    expect(await identitiesOf(account.id)).toHaveLength(1);
  });

  it("refuses the callback of a handshake started by a session that has since ended", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const flow = await approved(world, { subject: "ended-session" }, "?intent=link", { cookie: sessionCookie(token) });
    expect((await world.server.fetch(new Request(new URL("/api/v1/auth/logout", world.origin), { method: "POST", headers: { origin: world.origin, "content-type": "application/json", cookie: sessionCookie(token) } }))).status).toBe(204);

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) }));

    expect(await identitiesOf(account.id)).toHaveLength(1);
  });

  it("keeps the guards of the sign-in: no cookie of the handshake, a replayed state and a token that fails validation link nothing", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const headers = { cookie: sessionCookie(token) };
    const flow = await approved(world, { subject: "guarded-link" }, "?intent=link", headers);

    expectFailed(await callback(world, flow.callbackUrl, undefined, headers));
    expectFailed(await callback(world, flow.callbackUrl, "x".repeat(43), headers));
    expect(await identitiesOf(account.id)).toHaveLength(1);

    expect((await callback(world, flow.callbackUrl, flow.preAuth, headers)).status).toBe(302);
    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, headers));
    expect(await identitiesOf(account.id)).toHaveLength(2);

    for (const fault of [{ nonce: "other" }, { audience: "another-client" }, { issuer: "https://evil.example.test" }, { expiresInSeconds: -5 }]) {
      const bad = await approved(world, { subject: "never-linked", ...fault }, "?intent=link", headers);
      expectFailed(await callback(world, bad.callbackUrl, bad.preAuth, headers));
    }
    expect(await identitiesOf(account.id)).toHaveLength(2);
  });

  it("leaves an identity the account holds alone: linking it again is no error and no second row", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await freshToken(world, account, subject);
    const flow = await approved(world, { subject, email: "changed@idp.example.test", emailVerified: true }, "?intent=link", { cookie: sessionCookie(token) });

    expect((await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) })).headers.get("location")).toBe("/");

    expect(await identitiesOf(account.id)).toMatchObject([{ subject, email_at_link: account.email }]);
  });
});

describe("GET /api/v1/auth/oidc/{provider}/callback with the reauth intent", () => {
  it("counts the browser's session as re-authenticated when the provider asserts an identity of its account", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);
    expect(await reauthAtOf(token)).toBeNull();
    const flow = await approved(world, { subject }, "?intent=reauth&returnTo=/settings/security", { cookie: sessionCookie(token) });

    const response = await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/settings/security");
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect((await reauthAtOf(token))?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("is no proof when the provider asserts an identity the account does not hold, however valid the token", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const stranger = await linkedAccount({ subject: "a-stranger" });
    const token = await signedInToken(world, account, subject);

    for (const asserted of ["a-stranger", "nobody-linked-this"]) {
      const flow = await approved(world, { subject: asserted, email: account.email, emailVerified: true }, "?intent=reauth", { cookie: sessionCookie(token) });
      expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(token) }));
    }

    expect(await reauthAtOf(token)).toBeNull();
    expect(world.logs.entries.at(-1)).toMatchObject({ fields: { reason: "unknown_identity" } });
    expect(stranger.subject).toBe("a-stranger");
  });

  it("re-authenticates the session of the account that started the handshake and no other", async () => {
    const world = serve();
    const starter = await linkedAccount();
    const other = await linkedAccount();
    const starterToken = await signedInToken(world, starter.account, starter.subject);
    const otherToken = await signedInToken(world, other.account, other.subject);
    const flow = await approved(world, { subject: other.subject }, "?intent=reauth", { cookie: sessionCookie(starterToken) });

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(otherToken) }));
    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth, { cookie: sessionCookie(starterToken) }));

    expect(await reauthAtOf(starterToken)).toBeNull();
    expect(await reauthAtOf(otherToken)).toBeNull();
  });

  it("re-authenticates nothing for a browser with no session, a replayed state or a token that fails validation", async () => {
    const world = serve();
    const { account, subject } = await linkedAccount();
    const token = await signedInToken(world, account, subject);
    const headers = { cookie: sessionCookie(token) };
    const flow = await approved(world, { subject }, "?intent=reauth", headers);

    expectFailed(await callback(world, flow.callbackUrl, flow.preAuth));
    expect(await reauthAtOf(token)).toBeNull();
    const bad = await approved(world, { subject, nonce: "other" }, "?intent=reauth", headers);
    expectFailed(await callback(world, bad.callbackUrl, bad.preAuth, headers));
    expect(await reauthAtOf(token)).toBeNull();
  });
});
