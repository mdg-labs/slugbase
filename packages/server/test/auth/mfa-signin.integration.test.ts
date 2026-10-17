import { defineOperation, jsonResponse, problemResponse } from "@slugbase/contracts";
import { totpCode, totpStep } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FixedClock } from "@slugbase/testing";
import { loadOpenApiDocument } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createRateLimitRegistry } from "../../src/config/index.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { route } from "../../src/routes/register.ts";
import { buildDocument, type TestDocument } from "../contract/build-document.ts";
import { readOperations } from "../contract/document.ts";
import { FIXTURES } from "../contract/fixtures.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { buildRequest } from "../contract/walker.ts";
import { memoryRateLimiter } from "../http/rate-limit-support.ts";
import { testKey, testSecretBox, type TestKey } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// Completing a password sign-in with a TOTP or a backup code, through the whole
// chain over the migrated database (doc 02 section 2.3, doc 04 sections 4.3 and
// 10.2, doc 10 T4, T9 and T17). The failure scenarios: a correct password alone
// that yields a full session for an account whose second factor is on; a partial
// session that reaches any operation but the three it may call; a code that is
// accepted twice, in a replay or in parallel; a backup code that is not consumed
// or is consumed twice; a pending session that survives five wrong codes; and an
// answer that says whether a TOTP or a backup code was wrong.

const LOGIN = "/api/v1/auth/login";
const VERIFY = "/api/v1/auth/mfa/verify";
const LOGOUT = "/api/v1/auth/logout";
const ME = "/api/v1/me";
const CONFIG = "/api/config";
const START = "/api/v1/me/mfa/enrollment";
const CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const REAUTH = "/api/v1/me/reauth";
const WORKSPACE_PROBE = "/api/v1/mfa-signin-probe";
const SESSION_COOKIE = "__Host-slugbase_session";
const DAY_MS = 86_400_000;

const database = useTestDatabase();
let store: AuthStore;

beforeAll(() => {
  store = storeFor(database());
});

afterAll(async () => {
  await store.close();
});

const probeOperation = defineOperation({
  method: "get",
  path: WORKSPACE_PROBE,
  operationId: "getMfaSigninProbe",
  tag: "probe",
  auth: "member",
  rate: "read",
  scope: "read",
  responses: { 200: jsonResponse("The probe", z.strictObject({ ok: z.literal(true) })), 401: problemResponse("No credential"), 403: problemResponse("Forbidden"), 404: problemResponse("Not found") },
});

const committed = loadOpenApiDocument();
const base = committed as TestDocument;
/** The committed document with one workspace operation more, which a test module serves. */
const document: TestDocument = { ...base, paths: { ...base.paths, ...buildDocument([probeOperation], committed).paths } };

interface World {
  readonly server: Server;
  readonly origin: string;
  readonly logs: ReturnType<typeof recordingLogger>;
  readonly clock: FixedClock;
  readonly keys: readonly [TestKey, ...TestKey[]];
  readonly reached: string[];
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly keys?: readonly [TestKey, ...TestKey[]];
}

function serve({ env = {}, keys = [testKey("key-1")] }: ServeOptions = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    ...env,
  });
  const clock = new FixedClock(Date.now());
  const logs = recordingLogger();
  const reached: string[] = [];
  const server = createServer({
    config,
    adapters: {
      ...adapters(config),
      rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
      tenantResolver: createAccountOnlyTenantResolver(),
      secretBox: testSecretBox(...keys),
    },
    modules: [
      {
        name: "mfa-signin-probe",
        register: () => ({
          routes: [
            route(probeOperation).handle(() => {
              reached.push(probeOperation.operationId);
              return { status: 200, body: { ok: true } };
            }),
          ],
        }),
      },
    ],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
    openApiDocument: document,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, logs, clock, keys, reached };
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

function post({ server, origin }: World, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return server.fetch(new Request(new URL(path, origin), { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

function get({ server, origin }: World, path: string, token: string | null): Promise<Response> {
  return server.fetch(new Request(new URL(path, origin), { headers: token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` } }));
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** A problem document without its request id, which differs by request. */
function strip(document: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document).filter(([key]) => key !== "requestId"));
}

interface Enrolled {
  readonly account: SeededAccount;
  readonly backupCodes: readonly string[];
}

/** An account whose second factor is on, enrolled through the product's own two operations. */
async function enrol(world: World, options: { readonly email?: string } = {}): Promise<Enrolled> {
  const account = await seedAccount(database(), options.email === undefined ? {} : { email: options.email });
  const signedIn = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
  const token = tokenOf(signedIn);
  if (signedIn.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(signedIn.status)}`);
  }
  expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);
  expect((await post(world, START, token)).status).toBe(200);
  const confirmed = await post(world, CONFIRM, token, { code: await codeAt(world, account.id, 0) });
  expect(confirmed.status).toBe(200);
  const { backupCodes } = (await confirmed.json()) as { backupCodes: string[] };
  // The enrolment used the current time step; the next code the account gives is one later.
  world.clock.advance(30_000);
  return { account, backupCodes };
}

/** The code of the step `offset` steps from the server's current one, from the secret the account has stored. */
async function codeAt(world: World, accountId: string, offset: number): Promise<string> {
  const state = await store.mfaStateOf(accountId);
  if (state === undefined) {
    throw new Error("the account has no secret");
  }
  const secret = await testSecretBox(...world.keys).open(state.secret, mfaSecretOptions(accountId));
  return totpCode(secret, totpStep(world.clock.now().getTime()) + offset);
}

interface Pending {
  readonly token: string;
}

/** A correct password for an enrolled account: the partial session it gives. */
async function startSignIn(world: World, account: SeededAccount, remember = false): Promise<Pending> {
  const response = await post(world, LOGIN, null, { email: account.email, password: account.password, remember });
  const token = tokenOf(response);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ next: "mfa" });
  if (token === undefined) {
    throw new Error("the sign-in set no cookie");
  }
  return { token };
}

async function levels(accountId: string): Promise<string[]> {
  return (await sessionRows(database(), accountId)).map((row) => row.level);
}

describe("POST /api/v1/auth/login for an account whose second factor is on", () => {
  it("answers { next: 'mfa' } after a correct password and issues a partial session that expires after 5 minutes and keeps remember", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const before = (await sessionRows(database(), account.id)).length;

    const { token } = await startSignIn(world, account, true);

    const rows = await sessionRows(database(), account.id);
    expect(rows).toHaveLength(before + 1);
    const partial = rows.find((row) => row.level === "partial");
    expect(partial?.remember).toBe(true);
    expect(partial?.expires_at.getTime()).toBe((partial?.created_at.getTime() ?? 0) + 5 * 60_000);
    expect(partial?.absolute_expires_at.getTime()).toBe((partial?.created_at.getTime() ?? 0) + 5 * 60_000);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never yields a full session from the password alone: the new session is partial and the account's last sign-in is unchanged", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const lastSignIn = async () =>
      (await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ at: Date | null }[]>`SELECT last_sign_in_at AS at FROM accounts WHERE id = ${account.id}`;
      }))[0]?.at;
    const before = await lastSignIn();
    const fullBefore = (await levels(account.id)).filter((level) => level === "full").length;

    await startSignIn(world, account);

    expect((await levels(account.id)).filter((level) => level === "full")).toHaveLength(fullBefore);
    expect(await lastSignIn()).toEqual(before);
  });

  it("answers { next: 'done' } and a full session for an account without a second factor, and while an enrolment is only pending", async () => {
    const world = serve();
    const plain = await seedAccount(database());
    const response = await post(world, LOGIN, null, { email: plain.email, password: plain.password, remember: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "done" });
    expect(await levels(plain.id)).toEqual(["full"]);

    const started = await seedAccount(database());
    const token = tokenOf(await post(world, LOGIN, null, { email: started.email, password: started.password, remember: false }));
    expect((await post(world, REAUTH, token ?? "", { password: started.password })).status).toBe(204);
    expect((await post(world, START, token ?? "")).status).toBe(200);
    const again = await post(world, LOGIN, null, { email: started.email, password: started.password, remember: false });
    expect(await again.json()).toEqual({ next: "done" });
  });

  it("refuses a wrong password alike for an enrolled account, with no session and no sign of the second factor", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const before = (await sessionRows(database(), account.id)).length;
    const wrong = await post(world, LOGIN, null, { email: account.email, password: "not the password at all", remember: false });
    const unknown = await post(world, LOGIN, null, { email: "nobody@example.test", password: "not the password at all", remember: false });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(strip(await problem(wrong))).toEqual(strip(await problem(unknown)));
    expect(tokenOf(wrong)).toBeUndefined();
    expect(await sessionRows(database(), account.id)).toHaveLength(before);
  });
});

describe("what a partial session may call", () => {
  it("is refused with 401 mfa_required by every operation of openapi.json but the three it may call, and by a workspace operation", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };

    const operations = readOperations(document).operations;
    const allowed = new Set(["verifyMfa", "logout"]);
    // An anonymous operation never looks at the session, so it answers whoever holds a cookie.
    const anonymous = operations.filter((operation) => operation.auth === "anonymous" || operation.auth === "machine").map((operation) => operation.operationId).sort();
    expect(anonymous).toEqual(["completeOidcSignIn", "completeSetup", "getApiConfig", "getHealth", "getOpenApiDocument", "getReady", "getSetupStatus", "getVersion", "login", "register", "resendVerifyEmail", "startOidcSignIn", "verifyEmail"]);
    expect(operations.filter((operation) => operation.auth === "partial").map((operation) => operation.operationId).sort()).toEqual(["logout", "verifyMfa"]);

    const refused: string[] = [];
    for (const operation of operations) {
      if (allowed.has(operation.operationId) || anonymous.includes(operation.operationId)) {
        continue;
      }
      const fixture = operation.operationId === "getMfaSigninProbe" ? {} : FIXTURES[operation.operationId];
      expect(fixture, operation.operationId).toBeDefined();
      const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(fixture?.path?.[name] ?? "x"));
      const response = await world.server.fetch(
        buildRequest({ method: operation.method, url: path, body: fixture?.body, credentials: { headers }, origin: world.origin }),
      );
      expect(response.status, `${operation.method} ${operation.path}`).toBe(401);
      expect(await problem(response), `${operation.method} ${operation.path}`).toMatchObject({ code: "mfa_required" });
      refused.push(operation.operationId);
    }
    expect(refused).toContain("getMfaSigninProbe");
    expect(refused).toContain("getMe");
    expect(refused).toContain("changePassword");
    expect(refused).toContain("startMfaEnrollment");
    expect(world.reached).toEqual([]);
    // No refusal ended the session or counted as a failed code.
    expect(await levels(account.id)).toContain("partial");
  });

  it("may call GET /api/config and POST /auth/logout, and logout ends the pending session", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);

    expect((await get(world, CONFIG, token)).status).toBe(200);
    expect((await get(world, ME, token)).status).toBe(401);
    expect((await post(world, LOGOUT, token)).status).toBe(204);
    const after = await get(world, ME, token);
    expect(after.status).toBe(401);
    expect(await problem(after)).toMatchObject({ code: "unauthenticated" });
  });

  it("is refused once its five minutes are over", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    const [row] = (await sessionRows(database(), account.id)).filter((candidate) => candidate.level === "partial");
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${row?.id ?? ""}`;
    });

    const response = await post(world, VERIFY, token, { code: await codeAt(world, account.id, 0) });
    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "unauthenticated" });
  });
});

describe("POST /api/v1/auth/mfa/verify with a code", () => {
  it("completes the sign-in: a new full token, the partial one deleted, the remember choice kept", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account, true);
    const partialId = (await sessionRows(database(), account.id)).find((row) => row.level === "partial")?.id;

    const response = await post(world, VERIFY, token, { code: await codeAt(world, account.id, 0) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "done" });
    const next = tokenOf(response);
    expect(next).toBeDefined();
    expect(next).not.toBe(token);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    // The old token is refused, the new one is a complete session.
    expect((await get(world, ME, token)).status).toBe(401);
    expect((await get(world, ME, next ?? "")).status).toBe(200);
    expect(await levels(account.id)).not.toContain("partial");
    const completed = (await sessionRows(database(), account.id)).find((row) => row.id === partialId);
    expect(completed?.level).toBe("full");
    expect(completed?.remember).toBe(true);
    expect(Math.round(((completed?.expires_at.getTime() ?? 0) - (completed?.created_at.getTime() ?? 0)) / DAY_MS)).toBe(90);
  });

  it("refuses a code from an already accepted step with 422 invalid_code, and the session stays partial and refused", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const first = await startSignIn(world, account);
    const code = await codeAt(world, account.id, 0);
    expect((await post(world, VERIFY, first.token, { code })).status).toBe(200);

    // Signing in again with the password and presenting the same code: the failure scenario of T17.
    const second = await startSignIn(world, account);
    const replay = await post(world, VERIFY, second.token, { code });
    expect(replay.status).toBe(422);
    expect(await problem(replay)).toMatchObject({ code: "invalid_code" });
    expect(tokenOf(replay)).toBeUndefined();
    const refused = await get(world, ME, second.token);
    expect(refused.status).toBe(401);
    expect(await problem(refused)).toMatchObject({ code: "mfa_required" });
    expect(await levels(account.id)).toContain("partial");
  });

  it("refuses an older step as well, and accepts the next one", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const older = await codeAt(world, account.id, -1);
    const { token } = await startSignIn(world, account);
    expect((await post(world, VERIFY, token, { code: older })).status).toBe(422);
    expect((await post(world, VERIFY, token, { code: await codeAt(world, account.id, 0) })).status).toBe(200);
  });

  it("accepts one of two sign-ins made at once with the same code", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const first = await startSignIn(world, account);
    const second = await startSignIn(world, account);
    const code = await codeAt(world, account.id, 0);

    const responses = await Promise.all([post(world, VERIFY, first.token, { code }), post(world, VERIFY, second.token, { code })]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
  });

  it("accepts a code grouped by a space and refuses a malformed one without a different answer", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    const malformed = await post(world, VERIFY, token, { code: "abcdef" });
    expect(malformed.status).toBe(422);
    expect(await problem(malformed)).toMatchObject({ code: "invalid_code" });
    const code = await codeAt(world, account.id, 0);
    expect((await post(world, VERIFY, token, { code: `${code.slice(0, 3)} ${code.slice(3)}` })).status).toBe(200);
  });

  it("re-seals a secret that was sealed under a retired key when the code is read", async () => {
    const oldKey = testKey("key-old");
    const retiring = serve({ keys: [oldKey] });
    const { account } = await enrol(retiring);
    expect((await store.mfaStateOf(account.id))?.secret.keyId).toBe("key-old");

    const rotated = serve({ keys: [testKey("key-new"), oldKey] });
    rotated.clock.advance(30_000);
    const { token } = await startSignIn(rotated, account);
    const code = await codeAt(rotated, account.id, 0);
    expect((await post(rotated, VERIFY, token, { code })).status).toBe(200);
    expect((await store.mfaStateOf(account.id))?.secret.keyId).toBe("key-new");
  });
});

describe("POST /api/v1/auth/mfa/verify with a backup code", () => {
  it("completes the sign-in, consumes the code and refuses it afterwards", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const code = backupCodes[0] ?? "";
    const first = await startSignIn(world, account);
    const response = await post(world, VERIFY, first.token, { backupCode: code });
    expect(response.status).toBe(200);
    expect(tokenOf(response)).toBeDefined();
    expect(await store.unusedBackupCodes(account.id)).toHaveLength(9);

    const second = await startSignIn(world, account);
    const replay = await post(world, VERIFY, second.token, { backupCode: code });
    expect(replay.status).toBe(422);
    expect(await problem(replay)).toMatchObject({ code: "invalid_code" });
    expect(await store.unusedBackupCodes(account.id)).toHaveLength(9);
    expect(await levels(account.id)).toContain("partial");
  });

  it("reads a code written in lower case and grouped by hyphens or spaces", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const code = (backupCodes[1] ?? "").toLowerCase();
    const first = await startSignIn(world, account);
    expect((await post(world, VERIFY, first.token, { backupCode: `${code.slice(0, 5)}-${code.slice(5)}` })).status).toBe(200);
    const second = await startSignIn(world, account);
    expect((await post(world, VERIFY, second.token, { backupCode: ` ${(backupCodes[2] ?? "").slice(0, 5)} ${(backupCodes[2] ?? "").slice(5)} ` })).status).toBe(200);
  });

  it("accepts a backup code presented twice at once exactly once", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const code = backupCodes[3] ?? "";
    const first = await startSignIn(world, account);
    const second = await startSignIn(world, account);

    const responses = await Promise.all([post(world, VERIFY, first.token, { backupCode: code }), post(world, VERIFY, second.token, { backupCode: code })]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(await store.unusedBackupCodes(account.id)).toHaveLength(9);
  });

  it("does not use up a backup code that matched while the session was already gone", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const { token } = await startSignIn(world, account);
    expect((await post(world, LOGOUT, token)).status).toBe(204);
    const response = await post(world, VERIFY, token, { backupCode: backupCodes[4] ?? "" });
    expect(response.status).toBe(401);
    expect(await store.unusedBackupCodes(account.id)).toHaveLength(10);
  });

  it("answers a wrong backup code and a wrong TOTP code with the same status and the same words", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    const totp = await post(world, VERIFY, token, { code: "000000" });
    const backup = await post(world, VERIFY, token, { backupCode: "ABCDEFGHJK" });
    expect(totp.status).toBe(422);
    expect(backup.status).toBe(422);
    const totpAnswer = strip(await problem(totp));
    expect(totpAnswer).toEqual(strip(await problem(backup)));
    expect(totpAnswer).toMatchObject({ code: "invalid_code" });
  });
});

describe("failures against the pending session and the mfa limit", () => {
  it("revokes the pending session at the fifth failed code, so even the right code is refused after it", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await post(world, VERIFY, token, { code: "000000" })).status, `attempt ${String(attempt)}`).toBe(422);
    }
    expect(await levels(account.id)).toContain("partial");
    expect((await post(world, VERIFY, token, { backupCode: "ABCDEFGHJK" })).status).toBe(422);
    expect(await levels(account.id)).not.toContain("partial");

    const after = await post(world, VERIFY, token, { code: await codeAt(world, account.id, 0) });
    expect(after.status).toBe(401);
    expect(await problem(after)).toMatchObject({ code: "unauthenticated" });
    expect((await get(world, ME, token)).status).toBe(401);
  });

  it("counts wrong TOTP and wrong backup codes together, and a right code before the fifth failure still completes", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await post(world, VERIFY, token, { code: "000000" });
      await post(world, VERIFY, token, { backupCode: "ABCDEFGHJK" });
    }
    expect((await post(world, VERIFY, token, { code: await codeAt(world, account.id, 0) })).status).toBe(200);
  });

  it("does not let failures of one pending session end another's", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const spoiled = await startSignIn(world, account);
    const other = await startSignIn(world, account);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post(world, VERIFY, spoiled.token, { code: "000000" });
    }
    expect((await post(world, VERIFY, other.token, { code: await codeAt(world, account.id, 0) })).status).toBe(200);
  });

  it("holds the per-account limit of the mfa bucket: attempts beyond it answer 429 with Retry-After, a right code included", async () => {
    // The enrolment takes tokens of the account's mfa bucket too, so it is made on a server with open limits.
    const open = serve();
    const enrolled = await enrol(open);
    const world = serve({ env: { RATE_LIMIT_MFA_ACCOUNT: "3/hour" }, keys: open.keys });
    world.clock.advance(60_000);
    const { account } = enrolled;
    const { token } = await startSignIn(world, account);
    const code = await codeAt(world, account.id, 0);

    expect((await post(world, VERIFY, token, { code: "000000" })).status).toBe(422);
    expect((await post(world, VERIFY, token, { code: "000001" })).status).toBe(422);
    expect((await post(world, VERIFY, token, { code: "000002" })).status).toBe(422);
    const limited = await post(world, VERIFY, token, { code });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await problem(limited)).toMatchObject({ code: "rate_limited" });
    expect(await levels(account.id)).toContain("partial");
  });
});

describe("what the operation refuses", () => {
  it("answers 401 unauthenticated without a session and for a token no session has", async () => {
    const world = serve();
    const none = await post(world, VERIFY, null, { code: "123456" });
    expect(none.status).toBe(401);
    expect(await problem(none)).toMatchObject({ code: "unauthenticated" });
    const unknown = await post(world, VERIFY, "A".repeat(43), { code: "123456" });
    expect(unknown.status).toBe(401);
  });

  it("answers 422 validation_failed for a body with neither code, with both, with an unknown field or with an empty value, counting nothing", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    for (const body of [{}, { code: "123456", backupCode: "ABCDEFGHJK" }, { code: "123456", extra: 1 }, { code: "" }, { backupCode: "" }, { code: 123456 }]) {
      const response = await post(world, VERIFY, token, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await problem(response), JSON.stringify(body)).toMatchObject({ code: "validation_failed" });
    }
    // None of them counted as a failed code: five more are still needed to end the session.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await post(world, VERIFY, token, { code: "000000" });
    }
    expect(await levels(account.id)).toContain("partial");
  });

  it("answers 422 validation_failed to a complete session, which has no second factor to give, and leaves it signed in", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false })) ?? "";
    const response = await post(world, VERIFY, token, { code: "123456" });
    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    expect((await get(world, ME, token)).status).toBe(200);
  });

  it("is refused from another site like any mutation", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const { token } = await startSignIn(world, account);
    const response = await world.server.fetch(
      new Request(new URL(VERIFY, world.origin), {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ code: await codeAt(world, account.id, 0) }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await levels(account.id)).toContain("partial");
  });
});

describe("what is never written down", () => {
  it("keeps a TOTP code, a backup code and the secret out of every log line and every problem document", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const { token } = await startSignIn(world, account);
    const wrongCode = "918273";
    const wrongBackup = "ZYXWVUTSRQ";
    const answers = [
      await post(world, VERIFY, token, { code: wrongCode }),
      await post(world, VERIFY, token, { backupCode: wrongBackup }),
      await post(world, VERIFY, token, { backupCode: backupCodes[5] ?? "" }),
    ];
    const state = await store.mfaStateOf(account.id);
    if (state === undefined) {
      throw new Error("the account has no secret");
    }
    const secret = Buffer.from(await testSecretBox(...world.keys).open(state.secret, mfaSecretOptions(account.id)));
    const written = JSON.stringify([world.logs.entries, world.logs.requests, await Promise.all(answers.map((answer) => answer.clone().text()))]);
    for (const value of [wrongCode, wrongBackup, backupCodes[5] ?? "", secret.toString("base64"), secret.toString("hex")]) {
      expect(written).not.toContain(value);
    }
  });
});
