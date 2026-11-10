import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, createDatabase, credentialTokenRepository, type AuthStore, type Database, type NewCredentialToken } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sha256 } from "./support/auth-fixture.ts";

// The emailed single-use tokens (doc 05 sections 2.1 and 3.3, doc 02 section 2.6, doc 10 T4):
// `credential_tokens` is closed to slugbase_app, a token is stored as its SHA-256 only, issuing
// one deletes the account's older unused tokens of that purpose, and redeeming one works once.
// The failure scenarios: a token that works twice, after its expiry or for another purpose; two
// tokens of one purpose that both work after concurrent issues; a token the application role
// can read or write directly.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;
const DAY_SECONDS = 86_400;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const TEST_TIMEOUT_MS = 60_000;

let db: TestDatabase;
let store: AuthStore;
let tenants: Database;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: PARALLEL_CALLS });
  tenants = createDatabase({ url: appUrl(db), poolSize: PARALLEL_CALLS });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await tenants.close();
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await asSystem(db, (tx) => tx`DELETE FROM credential_tokens`);
});

let emailNumber = 0;

async function account(options: { disabled?: boolean } = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `credential${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", disabledAt: options.disabled === true ? new Date() : null });
  return id;
}

interface TokenRow {
  id: string;
  purpose: string;
  account_id: string;
  token_hash: Buffer;
  target_email: string | null;
  expires_at: Date;
  used_at: Date | null;
}

async function rows(accountId?: string): Promise<TokenRow[]> {
  const found = await asSystem(db, (tx) =>
    accountId === undefined
      ? tx<TokenRow[]>`SELECT * FROM credential_tokens ORDER BY created_at, id`
      : tx<TokenRow[]>`SELECT * FROM credential_tokens WHERE account_id = ${accountId} ORDER BY created_at, id`,
  );
  return [...found];
}

/** Calls the system operation the way the application does: as slugbase_app, outside any tenant. */
async function issue(accountId: string, overrides: { purpose?: string; hash?: Buffer; target?: string | null; ttl?: number; id?: string } = {}): Promise<boolean> {
  const result = await db.app<{ issued: boolean }[]>`
    SELECT sys_credential_token_issue(
      ${overrides.id ?? freshId()}::uuid, ${overrides.purpose ?? "email_verify"}::text, ${accountId}::uuid,
      ${overrides.hash ?? freshToken().hash}::bytea, ${overrides.target ?? null}::text, ${overrides.ttl ?? DAY_SECONDS}::integer) AS issued`;
  return result[0]?.issued ?? false;
}

async function consume(purpose: string, hash: Buffer): Promise<{ account_id: string; target_email: string | null }[]> {
  const result = await db.app<{ account_id: string; target_email: string | null }[]>`
    SELECT account_id, target_email FROM sys_credential_token_consume(${purpose}::text, ${hash}::bytea)`;
  return [...result];
}

/** Waits until a backend of this database is queued behind a lock, which is where an issue waiting for the account row stands. */
async function waitUntilBlocked(): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  for (;;) {
    const rows = await db.owner<{ waiting: string }[]>`
      SELECT count(DISTINCT l.pid)::text AS waiting
      FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
      WHERE NOT l.granted AND s.datname = current_database()`;
    if (Number(rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("the issue never waited for a lock");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe("sys_credential_token_issue", () => {
  it("stores the SHA-256 of the token, the purpose and the account, and an expiry the ttl after now on the database clock", async () => {
    const owner = await account();
    const { token, hash } = freshToken();
    expect(sha256(token)).toEqual(hash);

    const before = Date.now();
    expect(await issue(owner, { hash, ttl: DAY_SECONDS, target: "new@example.test", purpose: "email_change" })).toBe(true);
    const after = Date.now();

    const [row, ...rest] = await rows(owner);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ purpose: "email_change", account_id: owner, target_email: "new@example.test", used_at: null });
    expect(row?.token_hash).toEqual(hash);
    expect(row?.token_hash).not.toEqual(token);
    const expiresAt = row?.expires_at.getTime() ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + DAY_SECONDS * 1000 - 5000);
    expect(expiresAt).toBeLessThanOrEqual(after + DAY_SECONDS * 1000 + 5000);
  });

  it(
    "writes created_at and expires_at from one read of the clock taken after the wait for the account row, so the lifetime is exactly the ttl",
    async () => {
      const owner = await account();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const accountLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let releasedAt = "";

      // A transaction that holds the account row, as another issue or a redemption for the account would.
      const holding = db.owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`SELECT 1 FROM accounts WHERE id = ${owner} FOR UPDATE`;
        locked();
        await released;
        const read = await tx<{ at: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
        releasedAt = read[0]?.at ?? "";
      });
      const holdingSettled = holding.then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      await accountLocked;

      // The issuing transaction starts while the row is held, so its start time is earlier than the end of the wait.
      const issuing = db.app.begin(async (tx) => {
        const issued = await tx<{ issued: boolean }[]>`
          SELECT sys_credential_token_issue(${freshId()}::uuid, 'email_verify'::text, ${owner}::uuid, ${freshToken().hash}::bytea, NULL::text, ${DAY_SECONDS}::integer) AS issued`;
        return issued[0]?.issued;
      });
      const issuingSettled = issuing.then(
        (issued) => ({ issued }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitUntilBlocked();
      } finally {
        release();
      }

      expect(await holdingSettled).toBeUndefined();
      expect(await issuingSettled).toEqual({ issued: true });
      const dates = await asSystem(
        db,
        (tx) => tx<{ exact: boolean; after_wait: boolean }[]>`
          SELECT expires_at - created_at = ${DAY_SECONDS}::integer * interval '1 second' AS exact, created_at >= ${releasedAt}::timestamptz AS after_wait
          FROM credential_tokens WHERE account_id = ${owner}`,
      );
      expect(releasedAt).not.toBe("");
      expect(dates).toEqual([{ exact: true, after_wait: true }]);
    },
    TEST_TIMEOUT_MS,
  );

  it("deletes the account's older unused tokens of the purpose and keeps used ones, other purposes and other accounts' tokens", async () => {
    const owner = await account();
    const other = await account();
    const usedHash = freshToken().hash;
    await issue(owner, { hash: usedHash });
    await consume("email_verify", usedHash);
    await issue(owner, { purpose: "password_reset" });
    await issue(other);
    await issue(owner);
    const older = await issue(owner);
    expect(older).toBe(true);
    const newest = freshToken().hash;
    expect(await issue(owner, { hash: newest })).toBe(true);

    const mine = (await rows(owner)).map((row) => [row.purpose, row.used_at === null ? "unused" : "used"]);
    expect(mine.sort()).toEqual([
      ["email_verify", "unused"],
      ["email_verify", "used"],
      ["password_reset", "unused"],
    ]);
    expect((await rows(owner)).find((row) => row.purpose === "email_verify" && row.used_at === null)?.token_hash).toEqual(newest);
    expect(await rows(other)).toHaveLength(1);
  });

  it("leaves exactly one unused token of a purpose when many issues for one account run at once", async () => {
    const owner = await account();
    const answers = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => issue(owner)));
    expect(answers).toEqual(Array.from({ length: PARALLEL_CALLS }, () => true));
    expect(await rows(owner)).toHaveLength(1);
  });

  it("answers false and writes nothing for an unknown account and for a disabled one", async () => {
    const disabled = await account({ disabled: true });
    expect(await issue(freshId())).toBe(false);
    expect(await issue(disabled)).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("refuses an unknown purpose, a hash of the wrong length and a lifetime outside 1 second to 7 days", async () => {
    const owner = await account();
    await expect(issue(owner, { purpose: "sign_in" })).rejects.toMatchObject({ code: "22023" });
    await expect(issue(owner, { hash: Buffer.alloc(31) })).rejects.toMatchObject({ code: "22023" });
    await expect(issue(owner, { ttl: 0 })).rejects.toMatchObject({ code: "22023" });
    await expect(issue(owner, { ttl: 7 * DAY_SECONDS + 1 })).rejects.toMatchObject({ code: "22023" });
    expect(await rows()).toEqual([]);
  });

  it("is deleted with the account", async () => {
    const owner = await account();
    await issue(owner);
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${owner}, true)`;
      await tx`DELETE FROM accounts WHERE id = ${owner}`;
    });
    expect(await rows(owner)).toEqual([]);
  });
});

describe("sys_credential_token_consume", () => {
  it("returns the account and the target address once, and nothing for a token that was used", async () => {
    const owner = await account();
    const { hash } = freshToken();
    await issue(owner, { hash, purpose: "email_change", target: "moved@example.test" });

    expect(await consume("email_change", hash)).toEqual([{ account_id: owner, target_email: "moved@example.test" }]);
    expect(await consume("email_change", hash)).toEqual([]);
    expect((await rows(owner))[0]?.used_at).toBeInstanceOf(Date);
  });

  it("accepts the token once when many requests redeem it at the same time", async () => {
    const owner = await account();
    const { hash } = freshToken();
    await issue(owner, { hash });

    const answers = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => consume("email_verify", hash)));
    expect(answers.filter((answer) => answer.length === 1)).toHaveLength(1);
    expect(answers.filter((answer) => answer.length === 0)).toHaveLength(PARALLEL_CALLS - 1);
  });

  it("returns nothing for an expired token, a token of another purpose and an unknown token, and leaves the first two unused", async () => {
    const owner = await account();
    const expired = freshToken().hash;
    await issue(owner, { hash: expired });
    await asSystem(db, (tx) => tx`UPDATE credential_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = ${expired}`);
    const live = freshToken().hash;
    await issue(owner, { hash: live, purpose: "password_reset" });

    expect(await consume("email_verify", expired)).toEqual([]);
    expect(await consume("email_verify", live)).toEqual([]);
    expect(await consume("password_reset", freshToken().hash)).toEqual([]);
    expect((await rows(owner)).map((row) => row.used_at)).toEqual([null, null]);
    expect(await consume("password_reset", live)).toHaveLength(1);
  });

  it("does not redeem a token that a newer issue of the purpose replaced", async () => {
    const owner = await account();
    const first = freshToken().hash;
    await issue(owner, { hash: first });
    const second = freshToken().hash;
    await issue(owner, { hash: second });

    expect(await consume("email_verify", first)).toEqual([]);
    expect(await consume("email_verify", second)).toHaveLength(1);
  });
});

describe("credential_tokens", () => {
  it("is closed to slugbase_app: it can neither read nor write a token, and row-level security is forced", async () => {
    for (const statement of [
      "SELECT * FROM public.credential_tokens",
      "INSERT INTO public.credential_tokens (id, purpose, account_id, token_hash, expires_at) VALUES (gen_random_uuid(), 'email_verify', gen_random_uuid(), sha256('x'), now())",
      "UPDATE public.credential_tokens SET used_at = now()",
      "DELETE FROM public.credential_tokens",
    ]) {
      await expect(db.app.unsafe(statement)).rejects.toMatchObject({ code: "42501" });
    }
    const found = await db.owner<{ enabled: boolean; forced: boolean; policies: string }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced,
             (SELECT count(*)::text FROM pg_policy WHERE polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.credential_tokens'::regclass`;
    expect([...found]).toEqual([{ enabled: true, forced: true, policies: "0" }]);
  });

  it("has both system functions as SECURITY DEFINER functions of slugbase_system, in the registry", async () => {
    expect(systemOperations).toContain("sys_credential_token_issue");
    expect(systemOperations).toContain("sys_credential_token_consume");
    const found = await db.owner<{ name: string; definer: boolean; owner: string; config: string[] }[]>`
      SELECT proname AS name, prosecdef AS definer, pg_get_userbyid(proowner) AS owner, proconfig AS config
      FROM pg_proc WHERE proname IN ('sys_credential_token_issue', 'sys_credential_token_consume') ORDER BY proname`;
    expect([...found]).toEqual([
      { name: "sys_credential_token_consume", definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"] },
      { name: "sys_credential_token_issue", definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"] },
    ]);
  });
});

describe("credentialTokenRepository", () => {
  function newToken(overrides: Partial<NewCredentialToken> = {}): NewCredentialToken {
    return { id: freshId(), purpose: "email_verify", tokenHash: freshToken().hash, targetEmail: null, ttlSeconds: DAY_SECONDS, ...overrides };
  }

  it("issues a token to the account of the transaction and to no other", async () => {
    const mine = await account();
    const theirs = await account();
    const token = newToken();

    expect(await tenants.withTenant({ accountId: mine, requestId: "test" }, (tx) => credentialTokenRepository(tx).issue(token))).toBe(true);

    expect((await rows()).map((row) => [row.account_id, row.token_hash])).toEqual([[mine, token.tokenHash]]);
    expect(await rows(theirs)).toEqual([]);
  });

  it("answers false for a disabled account and writes nothing", async () => {
    const disabled = await account({ disabled: true });
    expect(await tenants.withTenant({ accountId: disabled, requestId: "test" }, (tx) => credentialTokenRepository(tx).issue(newToken()))).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("refuses a hash that is not a SHA-256 before any SQL", async () => {
    const mine = await account();
    await expect(
      tenants.withTenant({ accountId: mine, requestId: "test" }, (tx) => credentialTokenRepository(tx).issue(newToken({ tokenHash: Buffer.alloc(8) }))),
    ).rejects.toThrow(RangeError);
  });
});
