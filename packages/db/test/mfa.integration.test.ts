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
    await store.createSession({ id, accountId, level: "full", remember: false, ipPrefix: null, userAgent: null, tokenHash: hash, replacedTokenHash: null }),
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
  const operations = [
    "sys_backup_code_consume",
    "sys_backup_codes_replace",
    "sys_backup_codes_unused",
    "sys_mfa_accept_step",
    "sys_mfa_get_secret",
    "sys_mfa_set",
    "sys_session_mfa_failure",
    "sys_session_promote",
  ];

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
    const again = await signIn(accountId);
    const issued = codes();
    await store.activateMfa({ accountId, sessionId: session.id, step: 10, secret: secret.ciphertext, backupCodes: issued, newTokenHash: freshToken().hash });
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

/** An account whose MFA is on, with its ten backup codes, the way an enrolment leaves it. */
async function enrolled(step = 100) {
  const { accountId, session, secret } = await pending();
  const issued = codes();
  expect(
    await store.activateMfa({ accountId, sessionId: session.id, step, secret: secret.ciphertext, backupCodes: issued, newTokenHash: freshToken().hash }),
  ).toBe("activated");
  return { accountId, issued, step };
}

async function partialSignIn(accountId: string, overrides: { remember?: boolean; replacedTokenHash?: Buffer | null } = {}) {
  const { hash } = freshToken();
  const id = freshId();
  expect(
    await store.createSession({
      id,
      accountId,
      level: "partial",
      remember: overrides.remember ?? false,
      ipPrefix: null,
      userAgent: null,
      tokenHash: hash,
      replacedTokenHash: overrides.replacedTokenHash ?? null,
    }),
  ).toBe(true);
  return { id, hash };
}

async function sessionById(accountId: string, sessionId: string) {
  const row = (await sessionRows(db, accountId)).find((candidate) => candidate.id === sessionId);
  if (row === undefined) {
    return undefined;
  }
  const [failures] = await asSystem(db, (tx) => tx<{ failures: number }[]>`SELECT mfa_failures AS failures FROM sessions WHERE id = ${sessionId}`);
  return { ...row, failures: failures?.failures ?? -1 };
}

describe("a partial session", () => {
  it("is created for an account whose MFA is on, expires after five minutes, sets no sign-in time and replaces the carried session", async () => {
    const { accountId } = await enrolled();
    const lastSignInOf = async () => (await asSystem(db, (tx) => tx<{ at: Date | null }[]>`SELECT last_sign_in_at AS at FROM accounts WHERE id = ${accountId}`))[0]?.at;
    const signedInBefore = await lastSignInOf();
    const carried = await account();
    const carriedSession = await signIn(carried);
    const { id, hash } = await partialSignIn(accountId, { replacedTokenHash: carriedSession.hash });
    const row = await sessionById(accountId, id);
    expect(row?.level).toBe("partial");
    expect(row?.failures).toBe(0);
    expect(row?.expires_at.getTime()).toBe((row?.created_at.getTime() ?? 0) + 5 * 60_000);
    expect(row?.absolute_expires_at.getTime()).toBe((row?.created_at.getTime() ?? 0) + 5 * 60_000);
    expect(await store.lookupSession(carriedSession.hash)).toBeUndefined();
    expect((await store.lookupSession(hash))?.level).toBe("partial");
    expect(await lastSignInOf()).toEqual(signedInBefore);
  });

  it("is refused for an account whose MFA is off, and a full session is refused for one whose MFA is on, deleting nothing", async () => {
    const { accountId } = await enrolled();
    const before = (await sessionRows(db, accountId)).length;
    const plain = await account();
    const carried = await signIn(plain);
    expect(
      await store.createSession({ id: freshId(), accountId: plain, level: "partial", remember: false, ipPrefix: null, userAgent: null, tokenHash: freshToken().hash, replacedTokenHash: carried.hash }),
    ).toBe(false);
    expect(
      await store.createSession({ id: freshId(), accountId, level: "full", remember: false, ipPrefix: null, userAgent: null, tokenHash: freshToken().hash, replacedTokenHash: carried.hash }),
    ).toBe(false);
    expect(await sessionRows(db, accountId)).toHaveLength(before);
    expect((await store.lookupSession(carried.hash))?.sessionId).toBe(carried.id);
  });

  it("is not moved forward by a request, and is refused once its five minutes are over", async () => {
    const { accountId } = await enrolled();
    const { id, hash } = await partialSignIn(accountId);
    await asSystem(db, (tx) => tx`UPDATE sessions SET created_at = created_at - interval '2 minutes', last_seen_at = last_seen_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes', absolute_expires_at = absolute_expires_at - interval '2 minutes' WHERE id = ${id}`);
    const before = await sessionById(accountId, id);
    expect((await store.lookupSession(hash))?.level).toBe("partial");
    expect((await sessionById(accountId, id))?.expires_at).toEqual(before?.expires_at);
    await asSystem(db, (tx) => tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${id}`);
    expect(await store.lookupSession(hash)).toBeUndefined();
  });
});

describe("completeMfaSignIn", () => {
  it("accepts the step and makes the partial session a full one under the new token, keeping the remember choice", async () => {
    const { accountId, step } = await enrolled();
    const { id, hash } = await partialSignIn(accountId, { remember: true });
    await store.recordMfaFailure(id, accountId);
    const next = freshToken();
    expect(await store.completeMfaSignIn({ accountId, sessionId: id, factor: { kind: "totp", step: step + 1 }, newTokenHash: next.hash })).toBe("completed");

    expect(await store.lookupSession(hash)).toBeUndefined();
    expect(await store.lookupSession(next.hash)).toMatchObject({ sessionId: id, accountId, level: "full" });
    const row = await sessionById(accountId, id);
    expect(row?.remember).toBe(true);
    expect(row?.failures).toBe(0);
    expect(Math.round(((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)) / 86_400_000)).toBe(90);
    expect(Math.round(((row?.absolute_expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)) / 86_400_000)).toBe(180);
    expect((await mfaRow(accountId)).last_step).toBe(String(step + 1));
    const [signedIn] = await asSystem(db, (tx) => tx<{ at: Date | null }[]>`SELECT last_sign_in_at AS at FROM accounts WHERE id = ${accountId}`);
    expect(signedIn?.at).not.toBeNull();
  });

  it("answers replayed for a step that was already accepted or is older, and leaves the session partial under its token", async () => {
    const { accountId, step } = await enrolled(500);
    const { id, hash } = await partialSignIn(accountId);
    expect(await store.completeMfaSignIn({ accountId, sessionId: id, factor: { kind: "totp", step }, newTokenHash: freshToken().hash })).toBe("replayed");
    expect(await store.completeMfaSignIn({ accountId, sessionId: id, factor: { kind: "totp", step: step - 1 }, newTokenHash: freshToken().hash })).toBe("replayed");
    expect((await store.lookupSession(hash))?.level).toBe("partial");
    expect((await mfaRow(accountId)).last_step).toBe("500");
  });

  it("completes one of two sign-ins made at once with the same step", async () => {
    const { accountId, step } = await enrolled(600);
    const first = await partialSignIn(accountId);
    const second = await partialSignIn(accountId);
    const results = await Promise.all(
      [first, second].map((session) =>
        store.completeMfaSignIn({ accountId, sessionId: session.id, factor: { kind: "totp", step: step + 1 }, newTokenHash: freshToken().hash }),
      ),
    );
    expect([...results].sort()).toEqual(["completed", "replayed"]);
  });

  it("answers no_session and rolls the accepted step back when there is no live partial session of the account", async () => {
    const { accountId, step } = await enrolled(700);
    const expired = await partialSignIn(accountId);
    await asSystem(db, (tx) => tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}`);
    const outcomes = [
      await store.completeMfaSignIn({ accountId, sessionId: expired.id, factor: { kind: "totp", step: step + 1 }, newTokenHash: freshToken().hash }),
      await store.completeMfaSignIn({ accountId, sessionId: freshId(), factor: { kind: "totp", step: step + 2 }, newTokenHash: freshToken().hash }),
    ];
    expect(outcomes).toEqual(["no_session", "no_session"]);
    expect((await mfaRow(accountId)).last_step).toBe("700");
  });

  it("does not complete the partial session of another account, a full session or the session of a disabled account", async () => {
    const mine = await enrolled(800);
    const theirs = await enrolled(800);
    const strangers = await partialSignIn(theirs.accountId);
    expect(
      await store.completeMfaSignIn({ accountId: mine.accountId, sessionId: strangers.id, factor: { kind: "totp", step: 801 }, newTokenHash: freshToken().hash }),
    ).toBe("no_session");
    expect((await store.lookupSession(strangers.hash))?.level).toBe("partial");

    const full = await partialSignIn(mine.accountId);
    expect(await store.completeMfaSignIn({ accountId: mine.accountId, sessionId: full.id, factor: { kind: "totp", step: 802 }, newTokenHash: freshToken().hash })).toBe("completed");
    expect(await store.completeMfaSignIn({ accountId: mine.accountId, sessionId: full.id, factor: { kind: "totp", step: 803 }, newTokenHash: freshToken().hash })).toBe("no_session");

    const pendingSession = await partialSignIn(theirs.accountId);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${theirs.accountId}`);
    expect(
      await store.completeMfaSignIn({ accountId: theirs.accountId, sessionId: pendingSession.id, factor: { kind: "totp", step: 804 }, newTokenHash: freshToken().hash }),
    ).not.toBe("completed");
    expect((await sessionById(theirs.accountId, pendingSession.id))?.level).toBe("partial");
  });

  it("refuses a session created before the account's password change", async () => {
    const { accountId, step } = await enrolled(900);
    const { id } = await partialSignIn(accountId);
    await asSystem(db, (tx) => tx`UPDATE accounts SET password_changed_at = clock_timestamp() + interval '1 second' WHERE id = ${accountId}`);
    expect(await store.completeMfaSignIn({ accountId, sessionId: id, factor: { kind: "totp", step: step + 1 }, newTokenHash: freshToken().hash })).toBe("no_session");
    expect((await mfaRow(accountId)).last_step).toBe("900");
  });

  it("consumes the backup code with the session and refuses it afterwards, whichever session presents it", async () => {
    const { accountId, issued } = await enrolled();
    const first = await partialSignIn(accountId);
    const second = await partialSignIn(accountId);
    const code = issued[0]?.id ?? "";
    expect(await store.completeMfaSignIn({ accountId, sessionId: first.id, factor: { kind: "backup", codeId: code }, newTokenHash: freshToken().hash })).toBe("completed");
    expect(await store.completeMfaSignIn({ accountId, sessionId: second.id, factor: { kind: "backup", codeId: code }, newTokenHash: freshToken().hash })).toBe("replayed");
    expect((await store.lookupSession(second.hash))?.level).toBe("partial");
    expect((await backupCodeRows(accountId)).filter((row) => row.used_at !== null).map((row) => row.id)).toEqual([code]);
  });

  it("completes one of two sign-ins made at once with the same backup code", async () => {
    const { accountId, issued } = await enrolled();
    const first = await partialSignIn(accountId);
    const second = await partialSignIn(accountId);
    const code = issued[1]?.id ?? "";
    const results = await Promise.all(
      [first, second].map((session) =>
        store.completeMfaSignIn({ accountId, sessionId: session.id, factor: { kind: "backup", codeId: code }, newTokenHash: freshToken().hash }),
      ),
    );
    expect([...results].sort()).toEqual(["completed", "replayed"]);
  });

  it("leaves the backup code unused when the session is gone", async () => {
    const { accountId, issued } = await enrolled();
    const code = issued[2]?.id ?? "";
    expect(await store.completeMfaSignIn({ accountId, sessionId: freshId(), factor: { kind: "backup", codeId: code }, newTokenHash: freshToken().hash })).toBe("no_session");
    expect((await backupCodeRows(accountId)).every((row) => row.used_at === null)).toBe(true);
  });

  it("refuses a token hash of the wrong length before sending anything", async () => {
    const { accountId } = await enrolled();
    const { id } = await partialSignIn(accountId);
    await expect(store.completeMfaSignIn({ accountId, sessionId: id, factor: { kind: "totp", step: 5000 }, newTokenHash: Buffer.alloc(31) })).rejects.toThrow(RangeError);
  });
});

describe("unusedBackupCodes", () => {
  it("lists the ids and hashes of the codes that are not used, oldest first, and no used one", async () => {
    const { accountId, issued } = await enrolled();
    const used = issued[3]?.id ?? "";
    await db.app`SELECT sys_backup_code_consume(${accountId}::uuid, ${used}::uuid)`;
    const listed = await store.unusedBackupCodes(accountId);
    expect(listed.map((code) => code.id)).toEqual(issued.map((code) => code.id).filter((id) => id !== used).sort());
    expect(listed.every((code) => code.hash === CODE_HASH)).toBe(true);
  });

  it("lists nothing for an account whose MFA is off, a disabled one and one that does not exist", async () => {
    const { accountId } = await enrolled();
    expect(await store.unusedBackupCodes(await account())).toEqual([]);
    expect(await store.unusedBackupCodes(freshId())).toEqual([]);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${accountId}`);
    expect(await store.unusedBackupCodes(accountId)).toEqual([]);
  });
});

describe("recordMfaFailure", () => {
  it("counts the failures of a partial session and deletes it at the fifth", async () => {
    const { accountId } = await enrolled();
    const { id, hash } = await partialSignIn(accountId);
    for (let failure = 1; failure <= 4; failure += 1) {
      expect(await store.recordMfaFailure(id, accountId)).toBe(false);
      expect((await sessionById(accountId, id))?.failures).toBe(failure);
    }
    expect((await store.lookupSession(hash))?.level).toBe("partial");
    expect(await store.recordMfaFailure(id, accountId)).toBe(true);
    expect(await sessionById(accountId, id)).toBeUndefined();
    expect(await store.lookupSession(hash)).toBeUndefined();
  });

  it("counts failures made at once, so five parallel ones end the session", async () => {
    const { accountId } = await enrolled();
    const { id } = await partialSignIn(accountId);
    const results = await Promise.all(Array.from({ length: 5 }, () => store.recordMfaFailure(id, accountId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await sessionById(accountId, id)).toBeUndefined();
  });

  it("changes nothing for a full session, the session of another account and one that does not exist, and answers that it is over", async () => {
    const { accountId } = await enrolled();
    const other = await account();
    const full = await signIn(other);
    expect(await store.recordMfaFailure(full.id, other)).toBe(true);
    expect((await sessionById(other, full.id))?.failures).toBe(0);
    const partial = await partialSignIn(accountId);
    expect(await store.recordMfaFailure(partial.id, other)).toBe(true);
    expect((await sessionById(accountId, partial.id))?.failures).toBe(0);
    expect(await store.recordMfaFailure(freshId(), accountId)).toBe(true);
  });
});
