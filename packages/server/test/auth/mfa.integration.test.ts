import { createHash } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { totpCode, totpStep } from "@slugbase/core";
import { FixedClock } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { AuthStore } from "@slugbase/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { testKey, testSecretBox, type TestKey } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// Enrolling the second factor through the whole chain over the migrated database
// (doc 02 section 2.7, doc 04 sections 4.4 and 10.3, doc 10 T7 and T17). The
// failure scenarios: a secret that is stored in plaintext or without the key
// that sealed it, or returned again; an enrolment that turns sign-in on before a
// code was confirmed; a code that is accepted outside its window or twice; an
// activation that is applied in part; and a response or log line that carries a
// secret, a code or a backup code.

const START = "/api/v1/me/mfa/enrollment";
const CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const REAUTH = "/api/v1/me/reauth";
const LOGIN = "/api/v1/auth/login";
const ME = "/api/v1/me";
const SESSION_COOKIE = "__Host-slugbase_session";

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
  readonly clock: FixedClock;
  readonly keys: readonly [TestKey, ...TestKey[]];
}

interface ServeOptions {
  readonly env?: Record<string, string>;
  readonly keys?: readonly [TestKey, ...TestKey[]];
  readonly clock?: FixedClock;
}

function serve({ env = {}, keys = [testKey("key-1")], clock = new FixedClock(Date.now()) }: ServeOptions = {}): World {
  const config = serverConfig({
    NODE_ENV: "test",
    DATABASE_URL: appUrl(database()),
    RATE_LIMIT_LOGIN_IP: "1000/min",
    RATE_LIMIT_LOGIN_EMAIL: "1000/hour",
    RATE_LIMIT_MFA_IP: "1000/min",
    RATE_LIMIT_MFA_ACCOUNT: "1000/hour",
    ...env,
  });
  const logs = recordingLogger();
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver(), secretBox: testSecretBox(...keys) },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, logs, clock, keys };
}

interface Browser {
  token: string;
  readonly accountId: string;
}

async function signIn(world: World, account: SeededAccount, reauthenticate = true): Promise<Browser> {
  const response = await world.server.fetch(
    new Request(new URL(LOGIN, world.origin), {
      method: "POST",
      headers: { origin: world.origin, "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password, remember: false }),
    }),
  );
  const token = tokenOf(response);
  if (response.status !== 200 || token === undefined) {
    throw new Error(`could not sign in: ${String(response.status)}`);
  }
  const browser = { token, accountId: account.id };
  if (reauthenticate) {
    const reauth = await post(world, REAUTH, browser, { password: account.password });
    if (reauth.status !== 204) {
      throw new Error(`could not re-authenticate: ${String(reauth.status)}`);
    }
  }
  return browser;
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

function post({ server, origin }: World, path: string, as: Browser | null, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (as !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${as.token}`);
  }
  return server.fetch(new Request(new URL(path, origin), { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

function getMe({ server, origin }: World, as: Browser): Promise<Response> {
  return server.fetch(new Request(new URL(ME, origin), { headers: { cookie: `${SESSION_COOKIE}=${as.token}` } }));
}

interface Enrolment {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly qrSvg: string;
}

async function start(world: World, as: Browser): Promise<Enrolment> {
  const response = await post(world, START, as);
  expect(response.status).toBe(200);
  return (await response.json()) as Enrolment;
}

/** The plaintext secret of the account's pending or active enrolment, opened with the keys of `world`. */
async function storedSecret(world: World, accountId: string): Promise<Uint8Array> {
  const state = await store.mfaStateOf(accountId);
  if (state === undefined) {
    throw new Error("the account has no secret");
  }
  return testSecretBox(...world.keys).open(state.secret, mfaSecretOptions(accountId));
}

async function codeNow(world: World, accountId: string, offsetSteps = 0): Promise<string> {
  return totpCode(await storedSecret(world, accountId), totpStep(world.clock.now().getTime()) + offsetSteps);
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

interface AccountRow {
  secret: Buffer | null;
  key_id: string | null;
  enabled_at: Date | null;
  last_step: string | null;
}

async function accountRow(accountId: string): Promise<AccountRow> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AccountRow[]>`
      SELECT mfa_secret AS secret, mfa_secret_key_id AS key_id, mfa_enabled_at AS enabled_at, mfa_last_step::text AS last_step
      FROM accounts WHERE id = ${accountId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return row;
}

async function backupCodeHashes(accountId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ code_hash: Buffer }[]>`SELECT code_hash FROM mfa_backup_codes WHERE account_id = ${accountId} AND used_at IS NULL`;
  });
  return rows.map((row) => row.code_hash.toString("utf8"));
}

async function activeSessions(accountId: string): Promise<number> {
  return (await sessionRows(database(), accountId)).length;
}

describe("POST /api/v1/me/mfa/enrollment", () => {
  it("stores the secret sealed with the id of its key, never in plaintext, and returns the text key, the otpauth URI and a QR code", async () => {
    const world = serve({ keys: [testKey("key-9")] });
    const account = await seedAccount(database(), { email: "enrol@example.test" });
    const browser = await signIn(world, account);

    const enrolment = await start(world, browser);

    const row = await accountRow(account.id);
    expect(row.key_id).toBe("key-9");
    expect(row).toMatchObject({ enabled_at: null, last_step: null });
    const plain = await storedSecret(world, account.id);
    expect(plain).toHaveLength(20);
    // The column holds neither the secret's bytes nor its text key.
    expect(row.secret?.includes(Buffer.from(plain))).toBe(false);
    expect(row.secret?.toString("latin1")).not.toContain(enrolment.secret);
    expect(row.secret?.toString("utf8")).not.toContain(enrolment.secret);
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);

    const uri = new URL(enrolment.otpauthUri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(enrolment.secret);
    expect(uri.searchParams.get("issuer")).toBe(`SlugBase (${new URL(world.origin).hostname})`);
    expect(decodeURIComponent(uri.pathname)).toBe(`/SlugBase (${new URL(world.origin).hostname}):enrol@example.test`);
    expect(enrolment.qrSvg.startsWith("<svg")).toBe(true);
    expect(enrolment.qrSvg).not.toMatch(/<script|<image|href=/i);
  });

  it.each([
    ["https://localhost:5173", "SlugBase (localhost)"],
    ["https://links.example.test:8443", "SlugBase (links.example.test)"],
  ])("builds the default issuer without a colon when APP_ORIGIN is %s", async (origin, issuer) => {
    const world = serve({ env: { APP_ORIGIN: origin } });
    const browser = await signIn(world, await seedAccount(database()));
    const uri = new URL((await start(world, browser)).otpauthUri);
    expect(uri.searchParams.get("issuer")).toBe(issuer);
    const label = decodeURIComponent(uri.pathname).slice(1);
    expect(label.slice(0, label.indexOf(":"))).toBe(issuer);
    expect(label.split(":")).toHaveLength(2);
    expect(uri.pathname.toLowerCase()).not.toContain("%3a");
  });

  it("uses TOTP_ISSUER as the issuer when it is set", async () => {
    const world = serve({ env: { TOTP_ISSUER: "Acme Links" } });
    const browser = await signIn(world, await seedAccount(database()));
    const uri = new URL((await start(world, browser)).otpauthUri);
    expect(uri.searchParams.get("issuer")).toBe("Acme Links");
    expect(decodeURIComponent(uri.pathname)).toMatch(/^\/Acme Links:/);
  });

  it("leaves sign-in unchanged: the account still signs in with its password alone and keeps its sessions", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);

    expect((await accountRow(account.id)).enabled_at).toBeNull();
    const again = await world.server.fetch(
      new Request(new URL(LOGIN, world.origin), {
        method: "POST",
        headers: { origin: world.origin, "content-type": "application/json" },
        body: JSON.stringify({ email: account.email, password: account.password, remember: false }),
      }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ next: "done" });
    expect(tokenOf(again)).toBeDefined();
    expect((await getMe(world, browser)).status).toBe(200);
  });

  it("replaces a pending secret: a code of the first secret no longer confirms, a code of the second does", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    const first = await start(world, browser);
    const firstCode = await codeNow(world, account.id);
    const second = await start(world, browser);
    expect(second.secret).not.toBe(first.secret);

    const stale = await post(world, CONFIRM, browser, { code: firstCode });
    expect(stale.status).toBe(422);
    expect(await problem(stale)).toMatchObject({ code: "invalid_code" });
    expect((await accountRow(account.id)).enabled_at).toBeNull();

    expect((await post(world, CONFIRM, browser, { code: await codeNow(world, account.id) })).status).toBe(200);
  });

  it("is refused with 401 reauth_required to a session that has not re-authenticated, and stores nothing", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account, false);

    const response = await post(world, START, browser);

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect((await accountRow(account.id)).secret).toBeNull();
  });

  it("is refused after the re-authentication window has passed", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    world.clock.advance(11 * 60_000);
    const response = await post(world, START, browser);
    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect((await accountRow(account.id)).secret).toBeNull();
  });

  it("is refused without a session", async () => {
    const world = serve();
    const response = await post(world, START, null);
    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "unauthenticated" });
  });

  it("answers 422 validation_failed for an account whose second factor is already on, and keeps its secret", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);
    const confirmed = await post(world, CONFIRM, browser, { code: await codeNow(world, account.id) });
    const next = tokenOf(confirmed);
    expect(next).toBeDefined();
    const kept = await accountRow(account.id);

    const rotated: Browser = { token: next ?? "", accountId: account.id };
    expect((await post(world, REAUTH, rotated, { password: account.password })).status).toBe(204);
    const response = await post(world, START, rotated);

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    const after = await accountRow(account.id);
    expect(after.secret?.equals(kept.secret ?? Buffer.alloc(0))).toBe(true);
    expect(after.enabled_at).toEqual(kept.enabled_at);
  });
});

describe("POST /api/v1/me/mfa/enrollment/confirm", () => {
  it("turns the factor on, returns ten distinct backup codes once, stores them as argon2id hashes and rotates the session", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const other = await signIn(world, account, false);
    const browser = await signIn(world, account);
    await start(world, browser);
    const step = totpStep(world.clock.now().getTime());

    const response = await post(world, CONFIRM, browser, { code: await codeNow(world, account.id) });

    expect(response.status).toBe(200);
    const { backupCodes } = (await response.json()) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    for (const code of backupCodes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    }
    const row = await accountRow(account.id);
    expect(row.enabled_at).toBeInstanceOf(Date);
    expect(row.last_step).toBe(String(step));

    const hashes = await backupCodeHashes(account.id);
    expect(hashes).toHaveLength(10);
    for (const hash of hashes) {
      expect(hash.startsWith("$argon2id$")).toBe(true);
    }
    const [first] = backupCodes;
    expect((await Promise.all(hashes.map((hash) => verify(hash, first ?? "")))).filter(Boolean)).toHaveLength(1);
    for (const code of backupCodes) {
      expect(hashes.some((hash) => hash.includes(code))).toBe(false);
    }

    // The old token is refused and the new one works; the account's other session is kept.
    const next = tokenOf(response);
    expect(next).toBeDefined();
    expect(next).not.toBe(browser.token);
    expect((await getMe(world, browser)).status).toBe(401);
    expect((await getMe(world, { token: next ?? "", accountId: account.id })).status).toBe(200);
    expect((await getMe(world, other)).status).toBe(200);
  });

  it("answers a wrong code with 422 invalid_code naming the field, and changes nothing", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);
    const before = await accountRow(account.id);
    const right = await codeNow(world, account.id);
    const wrong = right === "123456" ? "654321" : "123456";

    const response = await post(world, CONFIRM, browser, { code: wrong });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "invalid_code", errors: [{ path: "code", code: "invalid_code" }] });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await accountRow(account.id)).toEqual(before);
    expect(await backupCodeHashes(account.id)).toEqual([]);
    expect((await getMe(world, browser)).status).toBe(200);
  });

  it("answers anything that is not a six-digit code with 422 invalid_code", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);
    for (const code of ["abcdef", "12345", "1234567", " "]) {
      const response = await post(world, CONFIRM, browser, { code });
      expect(response.status, code).toBe(422);
      expect(await problem(response), code).toMatchObject({ code: "invalid_code" });
    }
    expect((await accountRow(account.id)).enabled_at).toBeNull();
  });

  it("accepts a code one step either side of the clock and refuses one two steps away", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);

    for (const offset of [-2, 2]) {
      const refused = await post(world, CONFIRM, browser, { code: await codeNow(world, account.id, offset) });
      expect(refused.status, `offset ${String(offset)}`).toBe(422);
      expect(await problem(refused)).toMatchObject({ code: "invalid_code" });
    }
    expect((await accountRow(account.id)).enabled_at).toBeNull();

    const early = await post(world, CONFIRM, browser, { code: await codeNow(world, account.id, -1) });
    expect(early.status).toBe(200);
    expect((await accountRow(account.id)).last_step).toBe(String(totpStep(world.clock.now().getTime()) - 1));

    const late = serve();
    const lateAccount = await seedAccount(database());
    const lateBrowser = await signIn(late, lateAccount);
    await start(late, lateBrowser);
    expect((await post(late, CONFIRM, lateBrowser, { code: await codeNow(late, lateAccount.id, 1) })).status).toBe(200);
  });

  it("refuses a code whose time step was already accepted, even one inside the window", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);
    const step = totpStep(world.clock.now().getTime());
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`SELECT sys_mfa_accept_step(${account.id}::uuid, ${step}::bigint)`;
    });

    const response = await post(world, CONFIRM, browser, { code: await codeNow(world, account.id) });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "invalid_code" });
    expect((await accountRow(account.id)).enabled_at).toBeNull();
    expect(await backupCodeHashes(account.id)).toEqual([]);
  });

  it("counts every attempt against the mfa limit of the account: the attempt over it is 429 with Retry-After, even with the right code", async () => {
    const world = serve({ env: { RATE_LIMIT_MFA_ACCOUNT: "3/hour" } });
    const account = await seedAccount(database());
    const browser = await signIn(world, account, false);
    // Re-authentication also counts against the bucket, so the attempts are made from the third on.
    expect((await post(world, REAUTH, browser, { password: account.password })).status).toBe(204);
    expect((await post(world, START, browser)).status).toBe(200);
    const right = await codeNow(world, account.id);
    const wrong = right === "123456" ? "654321" : "123456";

    expect((await post(world, CONFIRM, browser, { code: wrong })).status).toBe(422);
    expect((await post(world, CONFIRM, browser, { code: wrong })).status).toBe(422);
    const limited = await post(world, CONFIRM, browser, { code: right });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await accountRow(account.id)).enabled_at).toBeNull();
  });

  it("answers 422 validation_failed when no enrolment was started or it is already confirmed, and writes nothing", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);

    const none = await post(world, CONFIRM, browser, { code: "123456" });
    expect(none.status).toBe(422);
    expect(await problem(none)).toMatchObject({ code: "validation_failed" });

    await start(world, browser);
    const code = await codeNow(world, account.id);
    const confirmed = await post(world, CONFIRM, browser, { code });
    expect(confirmed.status).toBe(200);
    const next: Browser = { token: tokenOf(confirmed) ?? "", accountId: account.id };
    const hashes = await backupCodeHashes(account.id);

    const again = await post(world, CONFIRM, next, { code: await codeNow(world, account.id) });
    expect(again.status).toBe(422);
    expect(await problem(again)).toMatchObject({ code: "validation_failed" });
    expect(await backupCodeHashes(account.id)).toEqual(hashes);
  });

  it("accepts one of two confirmations made at once with the same code, from two sessions, and issues one set of codes", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const first = await signIn(world, account);
    const second = await signIn(world, account);
    await start(world, first);
    const code = await codeNow(world, account.id);

    const responses = await Promise.all([post(world, CONFIRM, first, { code }), post(world, CONFIRM, second, { code })]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(await backupCodeHashes(account.id)).toHaveLength(10);
    const refused = responses.find((response) => response.status === 422);
    expect(refused?.headers.get("set-cookie")).toBeNull();
  });

  it("is refused without a session and for a body that is not a closed code object", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);

    const anonymous = await post(world, CONFIRM, null, { code: "123456" });
    expect(anonymous.status).toBe(401);
    expect(await problem(anonymous)).toMatchObject({ code: "unauthenticated" });
    expect((await post(world, CONFIRM, browser, { code: "123456", accountId: account.id })).status).toBe(422);
    expect((await post(world, CONFIRM, browser, {})).status).toBe(422);
    expect((await post(world, CONFIRM, browser, { code: 123456 })).status).toBe(422);
  });

  it("works on the account of the session only: another account's enrolment is not touched", async () => {
    const world = serve();
    const owner = await seedAccount(database());
    const bystander = await seedAccount(database());
    const ownerBrowser = await signIn(world, owner);
    const bystanderBrowser = await signIn(world, bystander);
    await start(world, bystanderBrowser);
    const kept = await accountRow(bystander.id);
    await start(world, ownerBrowser);

    expect((await post(world, CONFIRM, ownerBrowser, { code: await codeNow(world, owner.id) })).status).toBe(200);

    expect(await accountRow(bystander.id)).toEqual(kept);
    expect((await accountRow(bystander.id)).enabled_at).toBeNull();
  });

  it("seals a pending secret that is still under a retired key again under the current one, and confirms it", async () => {
    const retired = testKey("key-old");
    const current = testKey("key-new");
    const before = serve({ keys: [retired] });
    const account = await seedAccount(database());
    const browser = await signIn(before, account);
    await start(before, browser);
    const oldRow = await accountRow(account.id);
    expect(oldRow.key_id).toBe("key-old");

    const after = serve({ keys: [current, retired] });
    const code = await codeNow(after, account.id);
    const response = await post(after, CONFIRM, browser, { code });

    expect(response.status).toBe(200);
    const row = await accountRow(account.id);
    expect(row.key_id).toBe("key-new");
    expect(row.secret?.equals(oldRow.secret ?? Buffer.alloc(0))).toBe(false);
    expect(row.enabled_at).toBeInstanceOf(Date);
    // The resealed ciphertext opens under the current key alone.
    const state = await store.mfaStateOf(account.id);
    const opened = await testSecretBox(current).open(state?.secret ?? { ciphertext: new Uint8Array(), keyId: "" }, mfaSecretOptions(account.id));
    expect(opened).toHaveLength(20);
  });

  it("fails closed when the secret cannot be opened: 500, nothing activated and the enrolment still pending", async () => {
    const world = serve({ keys: [testKey("key-lost")] });
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    await start(world, browser);
    const code = await codeNow(world, account.id);

    const unknownKey = serve({ keys: [testKey("key-other")] });
    const response = await post(unknownKey, CONFIRM, browser, { code });

    expect(response.status).toBe(500);
    expect(await problem(response)).toMatchObject({ code: "internal" });
    const row = await accountRow(account.id);
    expect(row).toMatchObject({ enabled_at: null, key_id: "key-lost" });
    expect(await backupCodeHashes(account.id)).toEqual([]);
    expect((await getMe(world, browser)).status).toBe(200);
  });

  it("is refused for another account's ciphertext: a secret copied to this row does not open", async () => {
    const world = serve();
    const victim = await seedAccount(database());
    const attacker = await seedAccount(database());
    const victimBrowser = await signIn(world, victim);
    const attackerBrowser = await signIn(world, attacker);
    await start(world, victimBrowser);
    const victimState = await store.mfaStateOf(victim.id);
    // The attacker's pending secret is replaced, below the application, by the victim's ciphertext.
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET mfa_secret = ${Buffer.from(victimState?.secret.ciphertext ?? [])}, mfa_secret_key_id = ${victimState?.secret.keyId ?? ""} WHERE id = ${attacker.id}`;
    });

    const code = await codeNow(world, victim.id);
    const response = await post(world, CONFIRM, attackerBrowser, { code });

    expect(response.status).toBe(500);
    expect((await accountRow(attacker.id)).enabled_at).toBeNull();
  });
});

describe("what leaves the server", () => {
  it("no operation returns the secret again, and the account's profile carries no MFA material", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    const enrolment = await start(world, browser);

    const profile = await (await getMe(world, browser)).text();
    expect(profile).not.toContain(enrolment.secret);
    expect(profile.toLowerCase()).not.toContain("mfa");
    expect(profile).not.toContain("otpauth");

    const second = await start(world, browser);
    expect(second.secret).not.toBe(enrolment.secret);
    expect(JSON.stringify(second)).not.toContain(enrolment.secret);
  });

  it("writes no secret, code or backup code to a log line, and none to the error report, in any outcome", async () => {
    const world = serve({ keys: [testKey("key-1")] });
    const account = await seedAccount(database());
    const browser = await signIn(world, account);
    const enrolment = await start(world, browser);
    const right = await codeNow(world, account.id);
    const wrong = right === "123456" ? "654321" : "123456";
    await post(world, CONFIRM, browser, { code: wrong });
    await post(world, CONFIRM, browser, { code: "not a code" });
    const confirmed = await post(world, CONFIRM, browser, { code: right });
    const { backupCodes } = (await confirmed.json()) as { backupCodes: string[] };

    const logged = JSON.stringify([...world.logs.entries, ...world.logs.requests]);
    const plain = Buffer.from(await storedSecret(world, account.id));
    for (const secret of [enrolment.secret, enrolment.otpauthUri, right, wrong, "not a code", ...backupCodes, plain.toString("hex"), plain.toString("base64")]) {
      expect(logged, secret).not.toContain(secret);
    }
    expect(world.logs.requests.length).toBeGreaterThan(0);
  });
});

describe("the sessions of an enrolment", () => {
  it("rotation of the session keeps exactly the sessions the account had, one of them under a new token", async () => {
    const world = serve();
    const account = await seedAccount(database());
    await signIn(world, account, false);
    const browser = await signIn(world, account);
    await start(world, browser);
    const before = await activeSessions(account.id);

    const response = await post(world, CONFIRM, browser, { code: await codeNow(world, account.id) });

    expect(response.status).toBe(200);
    expect(await activeSessions(account.id)).toBe(before);
    const hash = createHash("sha256").update(Buffer.from(tokenOf(response) ?? "", "base64url")).digest();
    expect((await sessionRows(database(), account.id)).some((row) => row.token_hash.equals(hash))).toBe(true);
  });
});
