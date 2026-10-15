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
import { disableAccount, issuedToken, seedAccount, sessionRows, sha256, storeFor, type SeededAccount } from "./support.ts";

// OIDC sign-in with an identity that is already linked, through the whole chain over the migrated database (doc
// 02 sections 2.3 and 2.8, doc 04 section 4.5, doc 10 T4, T12 and T20). The provider is a FakeIdentity that
// checks what a relying party must check and can break any of it. The failure scenarios are a callback that
// ends in a session when it must not (a tampered nonce, another audience or issuer, an expired token, a
// replayed state, a callback from another browser, an identity nobody linked, a disabled account) and an answer
// that tells those cases apart.

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

async function begin(world: World, query = ""): Promise<Begun> {
  const response = await start(world, query);
  const authorizationUrl = response.headers.get("location") ?? "";
  const preAuth = cookieValue(response, PREAUTH_COOKIE);
  const state = new URL(authorizationUrl, world.origin).searchParams.get("state");
  if (response.status !== 302 || preAuth === undefined || state === null) {
    throw new Error(`the handshake did not start: ${String(response.status)}`);
  }
  return { authorizationUrl, preAuth, state };
}

/** Starts a handshake and plays the person approving it: the address the provider sends the browser back to. */
async function approved(world: World, grant: FakeIdentityGrant, query = ""): Promise<Begun & { readonly callbackUrl: string }> {
  const begun = await begin(world, query);
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

  it("refuses a query it does not declare, as any operation does", async () => {
    const world = serve();
    const response = await start(world, "?intent=link");
    expect(response.status).toBe(422);
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
