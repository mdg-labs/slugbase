import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type SealedMfaSecret } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// The second factor's enrolment (doc 05 sections 2.1 and 3.3, doc 02 section
// 2.7, doc 10 T7 and T17): the columns and the backup-code table the
// application role cannot read, the five system operations that reach them and
// the one transaction `activateMfa` runs. The failure scenarios are an
// application role that can read the secret, a secret stored in plaintext or
// without the key that sealed it, an enrolment that is applied in part, a code
// that is accepted twice and a pending secret replaced between the check of a
// code and the activation.

const HOOK_TIMEOUT_MS = 300_000;
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$b2xkc2FsdG9sZHNhbHQ$b2xkaGFzaG9sZGhhc2hvbGRoYXNoMDEyMzQ1Njc4OQ";
const CODE_HASH = "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdG5ld3NhbHQ$bmV3aGFzaG5ld2hhc2huZXdoYXNoMDEyMzQ1Njc4";

let db: TestDatabase;
let store: AuthStore;

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
  store = createAuthStore({ url: appUrl(db), poolSize: 4 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let counter = 0;
async function account(overrides: { disabledAt?: Date } = {}) {
  counter += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `mfa${String(counter)}@example.test`, passwordHash: PASSWORD_HASH, ...overrides });
  return id;
}

async function signIn(accountId: string) {
  const { hash } = freshToken();
  const id = freshId();
  expect(
    await store.createSession({ id, accountId, remember: false, ipPrefix: null, userAgent: null, tokenHash: hash, replacedTokenHash: null }),
  ).toBe(true);
  return { id, hash };
}

/** What the secret box would hand over: an IV, some bytes and a tag, under a key id. */
function sealed(keyId = "key-1"): SealedMfaSecret {
  return { ciphertext: new Uint8Array(randomBytes(12 + 20 + 16)), keyId };
}

interface MfaRow {
  secret: Buffer | null;
  key_id: string | null;
  enabled_at: Date | null;
  last_step: string | null;
}

async function mfaRow(accountId: string): Promise<MfaRow> {
  const rows = await asSystem(
    db,
    (tx) => tx<MfaRow[]>`
      SELECT mfa_secret AS secret, mfa_secret_key_id AS key_id, mfa_enabled_at AS enabled_at, mfa_last_step::text AS last_step
      FROM accounts WHERE id = ${accountId}`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return row;
}

async function backupCodeRows(accountId: string): Promise<{ id: string; code_hash: Buffer; used_at: Date | null }[]> {
  return asSystem(
    db,
    async (tx) => [...(await tx<{ id: string; code_hash: Buffer; used_at: Date | null }[]>`SELECT id, code_hash, used_at FROM mfa_backup_codes WHERE account_id = ${accountId} ORDER BY id`)],
  );
}

function codes(count = 10): { id: string; hash: string }[] {
  return Array.from({ length: count }, () => ({ id: freshId(), hash: CODE_HASH }));
}

/** A pending enrolment for a fresh account with a session, ready for `activateMfa`. */
async function pending() {
  const accountId = await account();
  const session = await signIn(accountId);
  const secret = sealed();
  expect(await store.startMfaEnrollment(accountId, secret)).toBe(true);
  return { accountId, session, secret };
}

describe("the second-factor system operations", () => {
  const operations = ["sys_backup_code_consume", "sys_backup_codes_replace", "sys_mfa_accept_step", "sys_mfa_get_secret", "sys_mfa_set"];

  it("are SECURITY DEFINER functions of slugbase_system with a pinned search_path, callable by slugbase_app only, and in the registry", async () => {
    const rows = await db.owner<{ name: string; definer: boolean; owner: string; config: string[]; app: boolean; public: boolean }[]>`
      SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (${operations})
      ORDER BY p.proname`;
    expect(rows.map((row) => row.name)).toEqual(operations);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ definer: true, owner: "slugbase_system", app: true, public: false });
      expect(row.config, row.name).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(systemOperations, row.name).toContain(row.name);
    }
  });
});

describe("what slugbase_app can reach", () => {
  const columns = ["mfa_enabled_at", "mfa_secret", "mfa_secret_key_id", "mfa_last_step"];

  it.each(columns)("holds no SELECT and no UPDATE on accounts.%s, and no privilege on mfa_backup_codes", async (column) => {
    const [row] = await db.owner<{ select: boolean; update: boolean; insert: boolean }[]>`
      SELECT has_column_privilege('slugbase_app', 'public.accounts', ${column}, 'SELECT') AS select,
             has_column_privilege('slugbase_app', 'public.accounts', ${column}, 'UPDATE') AS update,
             has_column_privilege('slugbase_app', 'public.accounts', ${column}, 'INSERT') AS insert`;
    expect(row).toEqual({ select: false, update: false, insert: false });
    const [table] = await db.owner<{ privileges: number }[]>`
      SELECT count(*)::int AS privileges FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        AS p WHERE has_table_privilege('slugbase_app', 'public.mfa_backup_codes', p)`;
    expect(table?.privileges).toBe(0);
  });

  it.each(columns)("is refused when it reads accounts.%s of its own row", async (column) => {
    const accountId = await account();
    expect(await store.startMfaEnrollment(accountId, sealed())).toBe(true);
    await expect(
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
        return tx.unsafe(`SELECT ${column} FROM accounts WHERE id = '${accountId}'`);
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("is refused when it reads, inserts into or updates mfa_backup_codes", async () => {
    const { accountId } = await pending();
    for (const statement of [
      "SELECT * FROM mfa_backup_codes",
      `INSERT INTO mfa_backup_codes (id, account_id, code_hash) VALUES ('${freshId()}', '${accountId}', '\\x01')`,
      "UPDATE mfa_backup_codes SET used_at = now()",
    ]) {
      await expect(db.app.begin((tx) => tx.unsafe(statement)), statement).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("is refused when it writes the mfa columns directly", async () => {
    const accountId = await account();
    await expect(
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
        return tx`UPDATE accounts SET mfa_enabled_at = now() WHERE id = ${accountId}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps row-level security forced on mfa_backup_codes, with no policy", async () => {
    const [row] = await db.owner<{ enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.mfa_backup_codes'::regclass`;
    expect(row).toEqual({ enabled: true, forced: true, policies: 0 });
  });
});

describe("startMfaEnrollment", () => {
  it("stores the sealed secret with the id of its key, enables nothing and leaves no accepted step", async () => {
    const accountId = await account();
    const secret = sealed("key-7");
    expect(await store.startMfaEnrollment(accountId, secret)).toBe(true);
    const row = await mfaRow(accountId);
    expect(row.secret?.equals(Buffer.from(secret.ciphertext))).toBe(true);
    expect(row).toMatchObject({ key_id: "key-7", enabled_at: null, last_step: null });
  });

  it("replaces an earlier pending secret and forgets a step that was accepted for it", async () => {
    const { accountId, secret: first } = await pending();
    expect(await asSystem(db, (tx) => tx`SELECT sys_mfa_accept_step(${accountId}::uuid, 41::bigint)`)).toBeDefined();
    const second = sealed("key-2");
    expect(await store.startMfaEnrollment(accountId, second)).toBe(true);
    const row = await mfaRow(accountId);
    expect(row.secret?.equals(Buffer.from(second.ciphertext))).toBe(true);
    expect(row.secret?.equals(Buffer.from(first.ciphertext))).toBe(false);
    expect(row).toMatchObject({ key_id: "key-2", enabled_at: null, last_step: null });
  });

  it("is refused for an account whose MFA is enabled, and its secret stays", async () => {
    const { accountId, session, secret } = await pending();
    expect(
      await store.activateMfa({ accountId, sessionId: session.id, step: 100, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
    ).toBe("activated");
    expect(await store.startMfaEnrollment(accountId, sealed("other"))).toBe(false);
    const row = await mfaRow(accountId);
    expect(row.secret?.equals(Buffer.from(secret.ciphertext))).toBe(true);
    expect(row.key_id).toBe("key-1");
    expect(row.enabled_at).not.toBeNull();
  });

  it("changes nothing for a disabled account and for one that does not exist", async () => {
    const disabled = await account({ disabledAt: new Date() });
    expect(await store.startMfaEnrollment(disabled, sealed())).toBe(false);
    expect((await mfaRow(disabled)).secret).toBeNull();
    expect(await store.startMfaEnrollment(freshId(), sealed())).toBe(false);
  });

  it("refuses a value that is not a sealed secret with invalid_parameter_value, and a key id of the wrong length", async () => {
    const accountId = await account();
    await expect(store.startMfaEnrollment(accountId, { ciphertext: new Uint8Array(10), keyId: "key-1" })).rejects.toMatchObject({ code: "22023" });
    await expect(store.startMfaEnrollment(accountId, { ciphertext: sealed().ciphertext, keyId: "" })).rejects.toMatchObject({ code: "22023" });
    await expect(store.startMfaEnrollment(accountId, { ciphertext: sealed().ciphertext, keyId: "k".repeat(129) })).rejects.toMatchObject({ code: "22023" });
    expect((await mfaRow(accountId)).secret).toBeNull();
  });
});

describe("mfaStateOf", () => {
  it("is undefined for an account with no secret, a disabled one and one that does not exist", async () => {
    expect(await store.mfaStateOf(await account())).toBeUndefined();
    const disabled = await account();
    expect(await store.startMfaEnrollment(disabled, sealed())).toBe(true);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled}`);
    expect(await store.mfaStateOf(disabled)).toBeUndefined();
    expect(await store.mfaStateOf(freshId())).toBeUndefined();
  });

  it("returns the sealed secret and its key id, pending first and active after the activation", async () => {
    const { accountId, session, secret } = await pending();
    const state = await store.mfaStateOf(accountId);
    expect(Buffer.from(state?.secret.ciphertext ?? []).equals(Buffer.from(secret.ciphertext))).toBe(true);
    expect(state).toMatchObject({ secret: { keyId: "key-1" }, enabledAt: null, lastStep: null });

    await store.activateMfa({ accountId, sessionId: session.id, step: 5_000_000_001, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash });
    const active = await store.mfaStateOf(accountId);
    expect(active?.enabledAt).toBeInstanceOf(Date);
    expect(active?.lastStep).toBe(5_000_000_001);
  });
});

describe("resealMfaSecret", () => {
  it("replaces the stored ciphertext and key id and leaves the activation state and the step alone", async () => {
    const { accountId, session, secret } = await pending();
    await store.activateMfa({ accountId, sessionId: session.id, step: 77, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash });
    const before = await mfaRow(accountId);
    const resealed = sealed("key-2");
    expect(await store.resealMfaSecret(accountId, secret.ciphertext, resealed)).toBe(true);
    const after = await mfaRow(accountId);
    expect(after.secret?.equals(Buffer.from(resealed.ciphertext))).toBe(true);
    expect(after).toMatchObject({ key_id: "key-2", enabled_at: before.enabled_at, last_step: "77" });
  });

  it("writes nothing when the stored ciphertext is no longer the one the caller read", async () => {
    const { accountId, secret } = await pending();
    const replacement = sealed("key-3");
    expect(await store.startMfaEnrollment(accountId, replacement)).toBe(true);
    expect(await store.resealMfaSecret(accountId, secret.ciphertext, sealed("key-2"))).toBe(false);
    const row = await mfaRow(accountId);
    expect(row.secret?.equals(Buffer.from(replacement.ciphertext))).toBe(true);
    expect(row.key_id).toBe("key-3");
  });

  it("changes nothing for an account with no secret", async () => {
    const accountId = await account();
    expect(await store.resealMfaSecret(accountId, sealed().ciphertext, sealed("key-2"))).toBe(false);
    expect((await mfaRow(accountId)).secret).toBeNull();
  });
});

describe("activateMfa", () => {
  it("enables MFA with the step, stores exactly the backup codes hashed and rotates the session", async () => {
    const { accountId, session, secret } = await pending();
    const other = await signIn(accountId);
    const { hash: newTokenHash } = freshToken();
    const issued = codes();

    expect(await store.activateMfa({ accountId, sessionId: session.id, step: 12345, secret: secret.ciphertext, backupCodes: issued, newTokenHash })).toBe("activated");

    const row = await mfaRow(accountId);
    expect(row.enabled_at).toBeInstanceOf(Date);
    expect(row.last_step).toBe("12345");
    const stored = await backupCodeRows(accountId);
    expect(stored.map((code) => code.id)).toEqual(issued.map((code) => code.id).sort());
    expect(stored.every((code) => code.code_hash.toString("utf8") === CODE_HASH && code.used_at === null)).toBe(true);
    expect((await store.lookupSession(newTokenHash))?.sessionId).toBe(session.id);
    expect(await store.lookupSession(session.hash)).toBeUndefined();
    // Enabling the factor does not end the account's other sessions.
    expect((await store.lookupSession(other.hash))?.sessionId).toBe(other.id);
  });

  it("replaces the backup codes the account had", async () => {
    const { accountId, session, secret } = await pending();
    await store.activateMfa({ accountId, sessionId: session.id, step: 9, secret: secret.ciphertext, backupCodes: codes(3), newTokenHash: freshToken().hash });
    const issued = codes();
    expect(await asSystem(db, (tx) => tx`SELECT sys_backup_codes_replace(${accountId}::uuid, ${tx.array(issued.map((code) => code.id), 2951)}::uuid[], ${tx.array(issued.map((code) => Buffer.from(code.hash)), 1001)}::bytea[])`)).toBeDefined();
    expect((await backupCodeRows(accountId)).map((code) => code.id)).toEqual(issued.map((code) => code.id).sort());
  });

  it("answers replayed and writes nothing when the step is not newer than the accepted one", async () => {
    const { accountId, session, secret } = await pending();
    await asSystem(db, (tx) => tx`SELECT sys_mfa_accept_step(${accountId}::uuid, 500::bigint)`);
    for (const step of [500, 499]) {
      expect(
        await store.activateMfa({ accountId, sessionId: session.id, step, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
      ).toBe("replayed");
    }
    expect(await mfaRow(accountId)).toMatchObject({ enabled_at: null, last_step: "500" });
    expect(await backupCodeRows(accountId)).toEqual([]);
    expect((await store.lookupSession(session.hash))?.sessionId).toBe(session.id);
  });

  it("answers changed and writes nothing when the pending secret was replaced after the code was checked", async () => {
    const { accountId, session, secret } = await pending();
    const replacement = sealed("key-2");
    await store.startMfaEnrollment(accountId, replacement);
    expect(
      await store.activateMfa({ accountId, sessionId: session.id, step: 600, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
    ).toBe("changed");
    const row = await mfaRow(accountId);
    expect(row).toMatchObject({ enabled_at: null, last_step: null, key_id: "key-2" });
    expect(await backupCodeRows(accountId)).toEqual([]);
  });

  it("answers changed for an account whose MFA is already enabled and keeps its codes", async () => {
    const { accountId, session, secret } = await pending();
    const issued = codes();
    await store.activateMfa({ accountId, sessionId: session.id, step: 10, secret: secret.ciphertext, backupCodes: issued, newTokenHash: freshToken().hash });
    const again = await signIn(accountId);
    expect(
      await store.activateMfa({ accountId, sessionId: again.id, step: 11, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
    ).toBe("changed");
    expect((await mfaRow(accountId)).last_step).toBe("10");
    expect((await backupCodeRows(accountId)).map((code) => code.id)).toEqual(issued.map((code) => code.id).sort());
    expect((await store.lookupSession(again.hash))?.sessionId).toBe(again.id);
  });

  it("answers no_session and rolls the step, the activation and the codes back when the account has no such full session", async () => {
    const { accountId, secret } = await pending();
    const foreign = await signIn(await account());
    for (const sessionId of [freshId(), foreign.id]) {
      expect(
        await store.activateMfa({ accountId, sessionId, step: 700, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
      ).toBe("no_session");
    }
    expect(await mfaRow(accountId)).toMatchObject({ enabled_at: null, last_step: null });
    expect(await backupCodeRows(accountId)).toEqual([]);
    expect((await store.lookupSession(foreign.hash))?.sessionId).toBe(foreign.id);
  });

  it("rolls everything back when the rotation fails after the codes were stored", async () => {
    const { accountId, session, secret } = await pending();
    const taken = await signIn(await account());
    await expect(
      store.activateMfa({ accountId, sessionId: session.id, step: 800, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: taken.hash }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await mfaRow(accountId)).toMatchObject({ enabled_at: null, last_step: null });
    expect(await backupCodeRows(accountId)).toEqual([]);
    expect((await store.lookupSession(session.hash))?.sessionId).toBe(session.id);
  });

  it("rolls everything back when a backup code is refused, and refuses an empty or oversized set", async () => {
    const { accountId, session, secret } = await pending();
    const duplicate = freshId();
    await expect(
      store.activateMfa({
        accountId,
        sessionId: session.id,
        step: 900,
        secret: secret.ciphertext,
        backupCodes: [
          { id: duplicate, hash: CODE_HASH },
          { id: duplicate, hash: CODE_HASH },
        ],
        newTokenHash: freshToken().hash,
      }),
    ).rejects.toMatchObject({ code: "23505" });
    for (const set of [codes(0), codes(21)]) {
      await expect(
        store.activateMfa({ accountId, sessionId: session.id, step: 900, secret: secret.ciphertext, backupCodes: set, newTokenHash: freshToken().hash }),
      ).rejects.toMatchObject({ code: "22023" });
    }
    expect(await mfaRow(accountId)).toMatchObject({ enabled_at: null, last_step: null });
    expect(await backupCodeRows(accountId)).toEqual([]);
  });

  it("accepts one of two activations made at once with the same step", async () => {
    const { accountId, session, secret } = await pending();
    const second = await signIn(accountId);
    const outcomes = await Promise.all([
      store.activateMfa({ accountId, sessionId: session.id, step: 1000, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
      store.activateMfa({ accountId, sessionId: second.id, step: 1000, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
    ]);
    expect(outcomes.filter((outcome) => outcome === "activated")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "replayed")).toHaveLength(1);
    expect(await backupCodeRows(accountId)).toHaveLength(10);
  });

  it("refuses a token hash of the wrong length before sending anything", async () => {
    const { accountId, session, secret } = await pending();
    await expect(
      store.activateMfa({ accountId, sessionId: session.id, step: 1, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: Buffer.alloc(31) }),
    ).rejects.toThrow(RangeError);
    expect((await mfaRow(accountId)).enabled_at).toBeNull();
  });

  it("changes nothing for a disabled account", async () => {
    const { accountId, session, secret } = await pending();
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${accountId}`);
    expect(
      await store.activateMfa({ accountId, sessionId: session.id, step: 1100, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash }),
    ).toBe("replayed");
    expect(await mfaRow(accountId)).toMatchObject({ enabled_at: null, last_step: null });
  });
});

describe("sys_mfa_accept_step", () => {
  it("accepts a newer step once, refuses the same and an older one, and never lowers the step", async () => {
    const { accountId } = await pending();
    const accept = async (step: number) => {
      const rows = await asSystem(db, (tx) => tx<{ done: boolean }[]>`SELECT sys_mfa_accept_step(${accountId}::uuid, ${step}::bigint) AS done`);
      return rows[0]?.done;
    };
    expect(await accept(2000)).toBe(true);
    expect(await accept(2000)).toBe(false);
    expect(await accept(1999)).toBe(false);
    expect(await accept(2001)).toBe(true);
    expect((await mfaRow(accountId)).last_step).toBe("2001");
  });

  it("refuses an account without a secret and a step that is not positive", async () => {
    const accountId = await account();
    const rows = await asSystem(db, (tx) => tx<{ done: boolean }[]>`SELECT sys_mfa_accept_step(${accountId}::uuid, 5::bigint) AS done`);
    expect(rows[0]?.done).toBe(false);
    await expect(asSystem(db, (tx) => tx`SELECT sys_mfa_accept_step(${accountId}::uuid, 0::bigint)`)).rejects.toMatchObject({ code: "22023" });
  });
});

describe("sys_mfa_set", () => {
  it("refuses an unknown action and arguments that do not fit the action", async () => {
    const accountId = await account();
    const secret = Buffer.from(sealed().ciphertext);
    const call = (action: string, set: Buffer | null, keyId: string | null, expected: Buffer | null) =>
      db.app`SELECT sys_mfa_set(${accountId}::uuid, ${action}::text, ${set}::bytea, ${keyId}::text, ${expected}::bytea)`;
    await expect(call("enable", secret, "key-1", null)).rejects.toMatchObject({ code: "22023" });
    await expect(call("start", secret, "key-1", secret)).rejects.toMatchObject({ code: "22023" });
    await expect(call("start", null, "key-1", null)).rejects.toMatchObject({ code: "22023" });
    await expect(call("reseal", secret, "key-1", null)).rejects.toMatchObject({ code: "22023" });
    await expect(call("activate", secret, null, secret)).rejects.toMatchObject({ code: "22023" });
    await expect(call("activate", null, null, null)).rejects.toMatchObject({ code: "22023" });
  });

  it("does not activate before a step was accepted", async () => {
    const { accountId, secret } = await pending();
    const rows = await asSystem(
      db,
      (tx) => tx<{ done: boolean }[]>`SELECT sys_mfa_set(${accountId}::uuid, 'activate'::text, NULL::bytea, NULL::text, ${Buffer.from(secret.ciphertext)}::bytea) AS done`,
    );
    expect(rows[0]?.done).toBe(false);
    expect((await mfaRow(accountId)).enabled_at).toBeNull();
  });
});

describe("the account's MFA columns", () => {
  it("refuse a secret without a key id, a key id without a secret and an activation without a secret", async () => {
    const accountId = await account();
    for (const statement of [
      `UPDATE accounts SET mfa_secret = '\\x01' WHERE id = '${accountId}'`,
      `UPDATE accounts SET mfa_secret_key_id = 'key-1' WHERE id = '${accountId}'`,
      `UPDATE accounts SET mfa_enabled_at = now() WHERE id = '${accountId}'`,
    ]) {
      await expect(asSystem(db, (tx) => tx.unsafe(statement)), statement).rejects.toMatchObject({ code: "23514" });
    }
  });
});

describe("sys_backup_codes_replace", () => {
  it("changes nothing for an account whose MFA is not enabled", async () => {
    const { accountId } = await pending();
    const issued = codes();
    const rows = await asSystem(
      db,
      (tx) => tx<{ done: boolean }[]>`
        SELECT sys_backup_codes_replace(${accountId}::uuid, ${tx.array(issued.map((code) => code.id), 2951)}::uuid[], ${tx.array(issued.map((code) => Buffer.from(code.hash)), 1001)}::bytea[]) AS done`,
    );
    expect(rows[0]?.done).toBe(false);
    expect(await backupCodeRows(accountId)).toEqual([]);
  });
});

describe("sys_backup_code_consume", () => {
  async function consume(accountId: string, codeId: string): Promise<boolean | undefined> {
    const rows = await db.app<{ done: boolean }[]>`SELECT sys_backup_code_consume(${accountId}::uuid, ${codeId}::uuid) AS done`;
    return rows[0]?.done;
  }

  it("marks an unused code as used once and refuses it afterwards, whichever caller asks", async () => {
    const { accountId, session, secret } = await pending();
    const issued = codes();
    await store.activateMfa({ accountId, sessionId: session.id, step: 3000, secret: secret.ciphertext, backupCodes: issued, newTokenHash: freshToken().hash });
    const [first, second] = issued;
    expect(await consume(accountId, first?.id ?? "")).toBe(true);
    expect(await consume(accountId, first?.id ?? "")).toBe(false);
    const rows = await backupCodeRows(accountId);
    expect(rows.filter((row) => row.used_at !== null).map((row) => row.id)).toEqual([first?.id]);
    expect(await consume(accountId, second?.id ?? "")).toBe(true);
  });

  it("consumes a code presented twice at once exactly once", async () => {
    const { accountId, session, secret } = await pending();
    const issued = codes();
    await store.activateMfa({ accountId, sessionId: session.id, step: 3100, secret: secret.ciphertext, backupCodes: issued, newTokenHash: freshToken().hash });
    const target = issued[0]?.id ?? "";
    const results = await Promise.all([consume(accountId, target), consume(accountId, target)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses the code of another account and one that does not exist, changing nothing", async () => {
    const owner = await pending();
    const issued = codes();
    await store.activateMfa({
      accountId: owner.accountId,
      sessionId: owner.session.id,
      step: 3200,
      secret: owner.secret.ciphertext,
      backupCodes: issued,
      newTokenHash: freshToken().hash,
    });
    const other = await account();
    expect(await consume(other, issued[0]?.id ?? "")).toBe(false);
    expect(await consume(owner.accountId, freshId())).toBe(false);
    expect((await backupCodeRows(owner.accountId)).every((row) => row.used_at === null)).toBe(true);
  });
});

describe("deleting an account", () => {
  it("deletes its backup codes with it and the sessions of its enrolment", async () => {
    const { accountId, session, secret } = await pending();
    await store.activateMfa({ accountId, sessionId: session.id, step: 4000, secret: secret.ciphertext, backupCodes: codes(), newTokenHash: freshToken().hash });
    expect(await backupCodeRows(accountId)).toHaveLength(10);
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      await tx`DELETE FROM accounts WHERE id = ${accountId}`;
    });
    expect(await backupCodeRows(accountId)).toEqual([]);
    expect(await sessionRows(db, accountId)).toEqual([]);
  });
});
