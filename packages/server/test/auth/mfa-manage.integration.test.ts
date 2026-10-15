import { createHash } from "node:crypto";
import { verify } from "@node-rs/argon2";
import { totpCode, totpStep } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { FixedClock } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mfaSecretOptions } from "../../src/auth/mfa.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server } from "../../src/create-server.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { testKey, testSecretBox } from "../secret-box.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";
import { seedAccount, sessionRows, storeFor, type SeededAccount } from "./support.ts";

// Regenerating the backup codes, turning the second factor off and re-authenticating
// with a code, through the whole chain over the migrated database (doc 02 section
// 2.7, doc 04 sections 4.4 and 10.3, doc 10 T17 and T18). The failure scenarios: a
// stolen full session with no second factor that regenerates the codes or turns the
// factor off; an old backup code that still signs in after regeneration; a wrong
// password or code that spends a time step, a code or the factor; a disable or a
// regeneration applied in part or twice; two regenerations made at once that leave
// two valid sets; and a response or log line that carries a code or the password.

const LOGIN = "/api/v1/auth/login";
const VERIFY = "/api/v1/auth/mfa/verify";
const REAUTH = "/api/v1/me/reauth";
const START = "/api/v1/me/mfa/enrollment";
const CONFIRM = "/api/v1/me/mfa/enrollment/confirm";
const BACKUP_CODES = "/api/v1/me/mfa/backup-codes";
const MFA = "/api/v1/me/mfa";
const ME = "/api/v1/me";
const SESSION_COOKIE = "__Host-slugbase_session";
const STEP_MS = 30_000;
const KEY = testKey("key-1");

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
}

function serve(env: Record<string, string> = {}): World {
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
  const server = createServer({
    config,
    adapters: { ...adapters(config), tenantResolver: createAccountOnlyTenantResolver(), secretBox: testSecretBox(KEY) },
    modules: [],
    migrations: [],
    logger: logs,
    database: tenantDatabase(database()),
    authStore: store,
    now: () => clock.now().getTime(),
  });
  return { server, origin: config.APP_ORIGIN, logs, clock };
}

function tokenOf(response: Response): string | undefined {
  return new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(response.headers.get("set-cookie") ?? "")?.[1];
}

function send({ server, origin }: World, method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return server.fetch(new Request(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

const post = (world: World, path: string, token: string | null, body?: unknown) => send(world, "POST", path, token, body);
const del = (world: World, path: string, token: string | null, body?: unknown) => send(world, "DELETE", path, token, body);
const getMe = (world: World, token: string) => send(world, "GET", ME, token);

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

interface Enrolled {
  readonly account: SeededAccount;
  /** A full session that re-authenticated with the password a moment ago. */
  readonly token: string;
  readonly backupCodes: readonly string[];
}

/** The code of the step `offset` steps from the server's current one, from the secret the account has stored. */
async function codeAt(world: World, accountId: string, offset = 0): Promise<string> {
  const state = await store.mfaStateOf(accountId);
  if (state === undefined) {
    throw new Error("the account has no secret");
  }
  const secret = await testSecretBox(KEY).open(state.secret, mfaSecretOptions(accountId));
  return totpCode(secret, totpStep(world.clock.now().getTime()) + offset);
}

/** An account whose second factor is on, enrolled through the product's own operations, with its session as the enrolment left it. */
async function enrol(world: World): Promise<Enrolled> {
  const account = await seedAccount(database());
  const signedIn = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
  const first = tokenOf(signedIn);
  expect(signedIn.status).toBe(200);
  expect((await post(world, REAUTH, first ?? "", { password: account.password })).status).toBe(204);
  expect((await post(world, START, first ?? "")).status).toBe(200);
  const confirmed = await post(world, CONFIRM, first ?? "", { code: await codeAt(world, account.id) });
  expect(confirmed.status).toBe(200);
  const token = tokenOf(confirmed);
  const { backupCodes } = (await confirmed.json()) as { backupCodes: string[] };
  // The enrolment used the current time step; the next code the account gives is one later.
  world.clock.advance(STEP_MS);
  return { account, token: token ?? "", backupCodes };
}

/** A password sign-in followed by `verify` with the body: what a person holding only that factor gets. */
async function signInWith(world: World, account: SeededAccount, verifyBody: Record<string, string>): Promise<Response> {
  const login = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
  expect(await login.json()).toEqual({ next: "mfa" });
  return post(world, VERIFY, tokenOf(login) ?? "", verifyBody);
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

interface CodeRow {
  id: string;
  code_hash: Buffer;
  used_at: Date | null;
}

async function backupCodeRows(accountId: string): Promise<CodeRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<CodeRow[]>`SELECT id, code_hash, used_at FROM mfa_backup_codes WHERE account_id = ${accountId} ORDER BY id`;
  });
  return [...rows];
}

async function tokenHashes(accountId: string): Promise<Buffer[]> {
  return (await sessionRows(database(), accountId)).map((row) => row.token_hash);
}

function sha256(token: string): Buffer {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest();
}

/** A code that is not the right one for any step near now. */
function wrongCode(right: string): string {
  return right === "123456" ? "654321" : "123456";
}

describe("POST /api/v1/me/mfa/backup-codes", () => {
  it("replaces the whole set with ten new codes shown once: no old code, used or unused, works afterwards, and every new one does", async () => {
    const world = serve();
    const { account, token, backupCodes: old } = await enrol(world);
    // One old code is used before the regeneration: the regeneration removes it with the rest.
    expect((await signInWith(world, account, { backupCode: old[0] ?? "" })).status).toBe(200);

    const response = await post(world, BACKUP_CODES, token, { code: await codeAt(world, account.id) });

    expect(response.status).toBe(200);
    const { backupCodes } = (await response.json()) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    for (const code of backupCodes) {
      expect(code).toMatch(/^[A-Z2-9]{10}$/);
      expect(old).not.toContain(code);
    }
    const rows = await backupCodeRows(account.id);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.used_at === null)).toBe(true);
    const hashes = rows.map((row) => row.code_hash.toString("utf8"));
    for (const hash of hashes) {
      expect(hash.startsWith("$argon2id$")).toBe(true);
    }
    for (const code of backupCodes) {
      expect(JSON.stringify(rows)).not.toContain(code);
    }
    let matching = 0;
    for (const hash of hashes) {
      for (const code of backupCodes) {
        if (await verify(hash, code)) {
          matching += 1;
        }
      }
    }
    expect(matching).toBe(10);

    for (const code of old) {
      world.clock.advance(STEP_MS);
      const refused = await signInWith(world, account, { backupCode: code });
      expect(refused.status, code).toBe(422);
      expect(await problem(refused)).toMatchObject({ code: "invalid_code" });
    }
    const accepted = await signInWith(world, account, { backupCode: backupCodes[3] ?? "" });
    expect(accepted.status).toBe(200);
  });

  it("is refused to a stolen full session with no second factor, and the old backup codes keep working", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const before = await backupCodeRows(account.id);

    const withoutCode = await post(world, BACKUP_CODES, token, {});
    expect(withoutCode.status).toBe(422);
    expect(await problem(withoutCode)).toMatchObject({ code: "validation_failed" });
    const right = await codeAt(world, account.id);
    const wrong = await post(world, BACKUP_CODES, token, { code: wrongCode(right) });
    expect(wrong.status).toBe(422);
    expect(await problem(wrong)).toMatchObject({ code: "invalid_code", errors: [{ path: "code", code: "invalid_code" }] });
    // A backup code is not a second factor for this operation: the codes being replaced cannot authorise their own replacement.
    const backup = await post(world, BACKUP_CODES, token, { code: backupCodes[0] ?? "" });
    expect(backup.status).toBe(422);
    expect(await problem(backup)).toMatchObject({ code: "invalid_code" });
    const asBackup = await post(world, BACKUP_CODES, token, { backupCode: backupCodes[0] ?? "" });
    expect(asBackup.status).toBe(422);

    const after = await backupCodeRows(account.id);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.every((row) => row.used_at === null)).toBe(true);
    expect((await signInWith(world, account, { backupCode: backupCodes[0] ?? "" })).status).toBe(200);
  });

  it("refuses a code of a time step that was already accepted, and keeps the old set", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const code = await codeAt(world, account.id);
    expect((await post(world, BACKUP_CODES, token, { code })).status).toBe(200);

    const replay = await post(world, BACKUP_CODES, token, { code });

    expect(replay.status).toBe(422);
    expect(await problem(replay)).toMatchObject({ code: "invalid_code" });
    const rows = await backupCodeRows(account.id);
    expect(rows).toHaveLength(10);
    for (const old of backupCodes) {
      expect(JSON.stringify(rows.map((row) => row.code_hash.toString("utf8")))).not.toContain(old);
    }
  });

  it("requires a fresh re-authentication: a session that has not re-authenticated, or whose window passed, is 401 reauth_required", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const before = await backupCodeRows(account.id);

    world.clock.advance(11 * 60_000);
    const stale = await post(world, BACKUP_CODES, token, { code: await codeAt(world, account.id) });

    expect(stale.status).toBe(401);
    expect(await problem(stale)).toMatchObject({ code: "reauth_required" });
    expect((await backupCodeRows(account.id)).map((row) => row.id)).toEqual(before.map((row) => row.id));
  });

  it("is refused without a session and to a session whose second factor is pending", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const anonymous = await post(world, BACKUP_CODES, null, { code: "123456" });
    expect(anonymous.status).toBe(401);
    expect(await problem(anonymous)).toMatchObject({ code: "unauthenticated" });

    const login = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
    const pending = await post(world, BACKUP_CODES, tokenOf(login) ?? "", { code: await codeAt(world, account.id) });
    expect(pending.status).toBe(401);
    expect(await problem(pending)).toMatchObject({ code: "mfa_required" });
  });

  it("answers 422 validation_failed for an account whose second factor is off, and writes nothing", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const login = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
    const token = tokenOf(login) ?? "";
    expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);

    const response = await post(world, BACKUP_CODES, token, { code: "123456" });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed" });
    expect(await backupCodeRows(account.id)).toEqual([]);
  });

  it("counts every attempt against the mfa limit of the account: the attempt over it is 429, even with the right code, and the old set stays", async () => {
    const world = serve({ RATE_LIMIT_MFA_ACCOUNT: "30/hour" });
    const { account, token } = await enrol(world);
    const right = await codeAt(world, account.id);
    // Sign-in, re-authentication, the confirmation and these attempts all take from the one bucket; spend what is left but one.
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 40 && limited === undefined; attempt += 1) {
      const response = await post(world, BACKUP_CODES, token, { code: wrongCode(right) });
      if (response.status === 429) {
        limited = await post(world, BACKUP_CODES, token, { code: right });
      } else {
        expect(response.status).toBe(422);
      }
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await backupCodeRows(account.id)).every((row) => row.used_at === null)).toBe(true);
  });

  it("leaves exactly one valid set when two regenerations run at once with different codes", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const first = await codeAt(world, account.id, 0);
    const second = await codeAt(world, account.id, 1);

    const responses = await Promise.all([post(world, BACKUP_CODES, token, { code: first }), post(world, BACKUP_CODES, token, { code: second })]);

    for (const response of responses) {
      expect([200, 422]).toContain(response.status);
    }
    expect(responses.some((response) => response.status === 200)).toBe(true);
    const rows = await backupCodeRows(account.id);
    expect(rows).toHaveLength(10);
    const winners = await Promise.all(responses.filter((response) => response.status === 200).map((response) => response.json() as Promise<{ backupCodes: string[] }>));
    // The set that stands is the one of the later transaction, and only that one: no code of the other works.
    const hashes = rows.map((row) => row.code_hash.toString("utf8"));
    const standing = await Promise.all(
      winners.map(async ({ backupCodes }) => {
        let working = 0;
        for (const code of backupCodes) {
          for (const hash of hashes) {
            if (await verify(hash, code)) {
              working += 1;
            }
          }
        }
        return working;
      }),
    );
    expect(standing.filter((count) => count === 10)).toHaveLength(1);
    expect(standing.filter((count) => count !== 10 && count !== 0)).toEqual([]);
  });

  it("neither deadlocks nor leaves a half-written set when a regeneration and a backup-code sign-in run at once", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const login = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
    const pending = tokenOf(login) ?? "";
    const code = await codeAt(world, account.id);

    const [regenerated, signedIn] = await Promise.all([
      post(world, BACKUP_CODES, token, { code }),
      post(world, VERIFY, pending, { backupCode: backupCodes[2] ?? "" }),
    ]);

    expect(regenerated.status).toBe(200);
    expect([200, 422]).toContain(signedIn.status);
    const rows = await backupCodeRows(account.id);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.used_at === null)).toBe(true);
  });

  it("returns the codes only to the caller: they appear in no log line, and the response carries no cookie", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const right = await codeAt(world, account.id);
    await post(world, BACKUP_CODES, token, { code: wrongCode(right) });
    const response = await post(world, BACKUP_CODES, token, { code: right });
    const { backupCodes } = (await response.json()) as { backupCodes: string[] };

    expect(response.headers.get("set-cookie")).toBeNull();
    const logged = JSON.stringify([...world.logs.entries, ...world.logs.requests]);
    for (const secret of [right, wrongCode(right), ...backupCodes]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});

describe("DELETE /api/v1/me/mfa", () => {
  it("with a TOTP code and the password clears the secret and the activation, deletes every backup code, rotates the session and restores password sign-in", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const other = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false }));
    expect(other).toBeDefined();

    const response = await del(world, MFA, token, { password: account.password, code: await codeAt(world, account.id) });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const next = tokenOf(response);
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next).not.toBe(token);
    const row = await accountRow(account.id);
    expect(row).toEqual({ secret: null, key_id: null, enabled_at: null, last_step: null });
    expect(await backupCodeRows(account.id)).toEqual([]);
    const hashes = await tokenHashes(account.id);
    expect(hashes.some((hash) => hash.equals(sha256(token)))).toBe(false);
    expect(hashes.some((hash) => hash.equals(sha256(next ?? "")))).toBe(true);
    expect((await getMe(world, token)).status).toBe(401);
    expect((await getMe(world, next ?? "")).status).toBe(200);

    const again = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
    expect(await again.json()).toEqual({ next: "done" });
  });

  it("with an unused backup code and the password does the same, and a used one does not", async () => {
    const world = serve();
    const first = await enrol(world);
    const used = first.backupCodes[0] ?? "";
    expect((await signInWith(world, first.account, { backupCode: used })).status).toBe(200);

    const refused = await del(world, MFA, first.token, { password: first.account.password, backupCode: used });
    expect(refused.status).toBe(422);
    expect(await problem(refused)).toMatchObject({ code: "invalid_code", errors: [{ path: "backupCode", code: "invalid_code" }] });
    expect((await accountRow(first.account.id)).enabled_at).not.toBeNull();

    const response = await del(world, MFA, first.token, { password: first.account.password, backupCode: first.backupCodes[1]?.toLowerCase() ?? "" });

    expect(response.status).toBe(204);
    expect(await accountRow(first.account.id)).toEqual({ secret: null, key_id: null, enabled_at: null, last_step: null });
    expect(await backupCodeRows(first.account.id)).toEqual([]);
  });

  it("is refused to a stolen full session with no second factor or no password, and changes nothing", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const before = await accountRow(account.id);
    const codesBefore = await backupCodeRows(account.id);
    const right = await codeAt(world, account.id);

    const bodies: Record<string, unknown>[] = [
      {},
      { password: account.password },
      { code: right },
      { backupCode: backupCodes[0] },
      { password: account.password, code: wrongCode(right) },
      { password: account.password, backupCode: "AAAAAAAAAA" },
      { password: account.password, code: "" },
    ];
    for (const body of bodies) {
      const response = await del(world, MFA, token, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      const document = await problem(response);
      expect(["validation_failed", "invalid_code"], JSON.stringify(body)).toContain(document["code"]);
    }

    expect(await accountRow(account.id)).toEqual(before);
    expect((await backupCodeRows(account.id)).map((row) => row.id)).toEqual(codesBefore.map((row) => row.id));
    expect((await getMe(world, token)).status).toBe(200);
    expect((await signInWith(world, account, { backupCode: backupCodes[0] ?? "" })).status).toBe(200);
  });

  it("answers a wrong password as validation_failed naming the password, without looking at or spending the code", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const code = await codeAt(world, account.id);

    const wrong = await del(world, MFA, token, { password: "not the password at all", code });

    expect(wrong.status).toBe(422);
    expect(await problem(wrong)).toMatchObject({ code: "validation_failed", errors: [{ path: "password", code: "invalid_password" }] });
    const row = await accountRow(account.id);
    expect(row.enabled_at).not.toBeNull();
    // The step was not spent: the same code, with the right password, now disables.
    expect(row.last_step).not.toBe(String(totpStep(world.clock.now().getTime())));
    expect((await del(world, MFA, token, { password: account.password, code })).status).toBe(204);
  });

  it("refuses a code of a step that was already accepted, and a code the account gave a moment ago to re-authenticate", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const code = await codeAt(world, account.id);
    expect((await post(world, REAUTH, token, { code })).status).toBe(204);

    const replay = await del(world, MFA, token, { password: account.password, code });

    expect(replay.status).toBe(422);
    expect(await problem(replay)).toMatchObject({ code: "invalid_code" });
    expect((await accountRow(account.id)).enabled_at).not.toBeNull();
    expect(await backupCodeRows(account.id)).toHaveLength(10);
  });

  it("requires a fresh re-authentication and refuses a session whose window passed", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    world.clock.advance(11 * 60_000);

    const response = await del(world, MFA, token, { password: account.password, code: await codeAt(world, account.id) });

    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: "reauth_required" });
    expect((await accountRow(account.id)).enabled_at).not.toBeNull();
  });

  it("answers 422 validation_failed for an account whose second factor is off", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false })) ?? "";
    expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);

    const response = await del(world, MFA, token, { password: account.password, code: "123456" });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "validation_failed" });
  });

  it("disables once when two requests carry the same code at once", async () => {
    const world = serve();
    const { account, token } = await enrol(world);
    const code = await codeAt(world, account.id);

    const responses = await Promise.all([
      del(world, MFA, token, { password: account.password, code }),
      del(world, MFA, token, { password: account.password, code }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([204, 422]);
    expect((await accountRow(account.id)).enabled_at).toBeNull();
  });

  it("neither deadlocks nor half-applies when a disable runs at once with a sign-in using another backup code", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const login = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
    const pending = tokenOf(login) ?? "";

    const [disabled, signedIn] = await Promise.all([
      del(world, MFA, token, { password: account.password, backupCode: backupCodes[0] }),
      post(world, VERIFY, pending, { backupCode: backupCodes[1] ?? "" }),
    ]);

    expect(disabled.status).toBe(204);
    expect([200, 422]).toContain(signedIn.status);
    expect(await accountRow(account.id)).toEqual({ secret: null, key_id: null, enabled_at: null, last_step: null });
    expect(await backupCodeRows(account.id)).toEqual([]);
  });

  it("counts every attempt against the mfa limit of the account", async () => {
    const world = serve({ RATE_LIMIT_MFA_ACCOUNT: "30/hour" });
    const { account, token } = await enrol(world);
    const right = await codeAt(world, account.id);
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 40 && limited === undefined; attempt += 1) {
      const response = await del(world, MFA, token, { password: account.password, code: wrongCode(right) });
      if (response.status === 429) {
        limited = await del(world, MFA, token, { password: account.password, code: right });
      } else {
        expect(response.status).toBe(422);
      }
    }
    expect(limited?.status).toBe(429);
    expect((await accountRow(account.id)).enabled_at).not.toBeNull();
  });

  it("writes no password, code or backup code to a log line", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const right = await codeAt(world, account.id);
    await del(world, MFA, token, { password: account.password, code: wrongCode(right) });
    await del(world, MFA, token, { password: "not the password at all", backupCode: backupCodes[0] });
    await del(world, MFA, token, { password: account.password, code: right });

    const logged = JSON.stringify([...world.logs.entries, ...world.logs.requests]);
    for (const secret of [account.password, "not the password at all", right, wrongCode(right), ...backupCodes]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});

describe("POST /api/v1/me/reauth with a code", () => {
  it("re-authenticates a session that has not re-authenticated, so an operation that declares reauth then works, and accepts the password as before", async () => {
    const world = serve();
    const { account, backupCodes } = await enrol(world);
    const fresh = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false })) ?? "";
    const verified = await post(world, VERIFY, fresh, { code: await codeAt(world, account.id) });
    const token = tokenOf(verified) ?? "";
    expect(verified.status).toBe(200);
    world.clock.advance(STEP_MS);
    expect((await post(world, BACKUP_CODES, token, { code: "123456" })).status).toBe(401);

    const response = await post(world, REAUTH, token, { code: await codeAt(world, account.id) });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect((await post(world, BACKUP_CODES, token, { code: wrongCode(await codeAt(world, account.id)) })).status).toBe(422);

    const other = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false })) ?? "";
    expect((await post(world, VERIFY, other, { backupCode: backupCodes[0] ?? "" })).status).toBe(200);
  });

  it("answers a wrong code 422 invalid_code and leaves the session as it was", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const token = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false })) ?? "";
    const verified = tokenOf(await post(world, VERIFY, token, { code: await codeAt(world, account.id) })) ?? "";
    world.clock.advance(STEP_MS);
    const right = await codeAt(world, account.id);

    const wrong = await post(world, REAUTH, verified, { code: wrongCode(right) });

    expect(wrong.status).toBe(422);
    expect(await problem(wrong)).toMatchObject({ code: "invalid_code", errors: [{ path: "code", code: "invalid_code" }] });
    expect((await post(world, BACKUP_CODES, verified, { code: right })).status).toBe(401);
    expect((await getMe(world, verified)).status).toBe(200);
  });

  it("refuses a code whose step was already accepted, and a backup code", async () => {
    const world = serve();
    const { account, token, backupCodes } = await enrol(world);
    const code = await codeAt(world, account.id);
    expect((await post(world, REAUTH, token, { code })).status).toBe(204);

    const replay = await post(world, REAUTH, token, { code });
    expect(replay.status).toBe(422);
    expect(await problem(replay)).toMatchObject({ code: "invalid_code" });

    const backup = await post(world, REAUTH, token, { code: backupCodes[0] ?? "" });
    expect(backup.status).toBe(422);
    expect(await problem(backup)).toMatchObject({ code: "invalid_code" });
    expect((await backupCodeRows(account.id)).every((row) => row.used_at === null)).toBe(true);
  });

  it("answers 422 invalid_code for an account whose second factor is off, even with a pending secret", async () => {
    const world = serve();
    const account = await seedAccount(database());
    const token = tokenOf(await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false })) ?? "";
    expect((await post(world, REAUTH, token, { password: account.password })).status).toBe(204);
    expect((await post(world, START, token)).status).toBe(200);
    const pending = await codeAt(world, account.id);

    const response = await post(world, REAUTH, token, { code: pending });

    expect(response.status).toBe(422);
    expect(await problem(response)).toMatchObject({ code: "invalid_code" });
    expect((await accountRow(account.id)).last_step).toBeNull();
  });

  it("counts every attempt against the mfa limit of the account", async () => {
    const world = serve({ RATE_LIMIT_MFA_ACCOUNT: "30/hour" });
    const { account, token } = await enrol(world);
    const right = await codeAt(world, account.id);
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 40 && limited === undefined; attempt += 1) {
      const response = await post(world, REAUTH, token, { code: wrongCode(right) });
      if (response.status === 429) {
        limited = await post(world, REAUTH, token, { code: right });
      } else {
        expect(response.status).toBe(422);
      }
    }
    expect(limited?.status).toBe(429);
  });

  it("is refused without a session and to a session whose second factor is pending", async () => {
    const world = serve();
    const { account } = await enrol(world);
    const anonymous = await post(world, REAUTH, null, { code: "123456" });
    expect(anonymous.status).toBe(401);
    const login = await post(world, LOGIN, null, { email: account.email, password: account.password, remember: false });
    const pending = await post(world, REAUTH, tokenOf(login) ?? "", { code: await codeAt(world, account.id) });
    expect(pending.status).toBe(401);
    expect(await problem(pending)).toMatchObject({ code: "mfa_required" });
  });
});
