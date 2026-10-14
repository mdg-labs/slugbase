import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// Re-authentication and the password change (doc 05 section 3.3, doc 04
// sections 4.3 and 4.4, doc 10 T4 and T18): the four system operations behind
// them and the one transaction `changePassword` runs. The failure scenarios
// are a change that leaves the signing session refused (a session created
// before password_changed_at is invalid), a change that leaves another
// device's session valid, and a change that is applied in part.

const HOOK_TIMEOUT_MS = 300_000;
// Hashes in the encoding the application's hasher (@node-rs/argon2, as packages/server/src/auth/password.ts calls it) writes.
// The db package does not depend on the hasher, so these are strings copied from a real run of it: the first is the output
// for a password, the others differ in the salt and hash only.
const REAL_HASH = "$argon2id$v=19$m=19456,t=2,p=1$sFLPcSAWqw4Wpd/8O0PrNw$xLekCysBXktEpmApalRynWfjPdndgkAFMEe1+x82+K4";
const OLD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$b2xkc2FsdG9sZHNhbHQ$b2xkaGFzaG9sZGhhc2hvbGRoYXNoMDEyMzQ1Njc4OQ";
const NEW_HASH = "$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdG5ld3NhbHQ$bmV3aGFzaG5ld2hhc2huZXdoYXNoMDEyMzQ1Njc4";

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
async function account(overrides: { passwordHash?: string | null; disabledAt?: Date } = {}) {
  counter += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `change${String(counter)}@example.test`, passwordHash: OLD_HASH, ...overrides });
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

async function passwordRow(accountId: string): Promise<{ hash: string | null; changedAt: Date | null }> {
  const rows = await asSystem(db, (tx) =>
    tx<{ hash: string | null; changed_at: Date | null }[]>`SELECT password_hash AS hash, password_changed_at AS changed_at FROM accounts WHERE id = ${accountId}`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return { hash: row.hash, changedAt: row.changed_at };
}

describe("the password system operations", () => {
  const operations = ["sys_account_password_hash", "sys_password_set", "sys_session_reauth", "sys_session_rotate"];

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

describe("passwordHashOf", () => {
  it("returns the hash of an account with a password", async () => {
    expect(await store.passwordHashOf(await account())).toBe(OLD_HASH);
  });

  it("returns null alike for an account without a password, a disabled one and one that does not exist", async () => {
    expect(await store.passwordHashOf(await account({ passwordHash: null }))).toBeNull();
    expect(await store.passwordHashOf(await account({ disabledAt: new Date() }))).toBeNull();
    expect(await store.passwordHashOf(freshId())).toBeNull();
  });
});

describe("markReauthenticated", () => {
  it("sets reauth_at of the session to now and the lookup reports it", async () => {
    const accountId = await account();
    const session = await signIn(accountId);
    expect((await store.lookupSession(session.hash))?.reauthAt).toBeNull();
    const before = Date.now();
    expect(await store.markReauthenticated(session.id, accountId)).toBe(true);
    const reauthAt = (await store.lookupSession(session.hash))?.reauthAt;
    expect(reauthAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(reauthAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("changes nothing for a session of another account", async () => {
    const owner = await account();
    const other = await account();
    const session = await signIn(owner);
    expect(await store.markReauthenticated(session.id, other)).toBe(false);
    expect((await store.lookupSession(session.hash))?.reauthAt).toBeNull();
  });
});

describe("changePassword", () => {
  it("stores the hash, keeps the signing session under its new token, refuses its old token and every other session", async () => {
    const accountId = await account();
    const current = await signIn(accountId);
    const otherDevice = await signIn(accountId);
    const { hash: newTokenHash } = freshToken();

    expect(await store.changePassword({ accountId, sessionId: current.id, passwordHash: NEW_HASH, newTokenHash })).toBe(true);

    expect((await passwordRow(accountId)).hash).toBe(NEW_HASH);
    expect((await passwordRow(accountId)).changedAt).not.toBeNull();
    // The signing session still works, under the rotated token only.
    expect((await store.lookupSession(newTokenHash))?.sessionId).toBe(current.id);
    expect(await store.lookupSession(current.hash)).toBeUndefined();
    // Another device's session is deleted, so its cookie is refused on its next request (T4).
    expect(await store.lookupSession(otherDevice.hash)).toBeUndefined();
    expect((await sessionRows(db, accountId)).map((row) => row.id)).toEqual([current.id]);
  });

  it("deletes the other sessions of the account whatever their level, and no session of another account", async () => {
    const accountId = await account();
    const bystander = await account();
    const current = await signIn(accountId);
    const bystanderSession = await signIn(bystander);
    const partial = freshToken();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
        VALUES (${freshId()}, ${partial.hash}, ${accountId}, 'partial', false, now() + interval '5 minutes', now() + interval '1 day')`,
    );

    expect(await store.changePassword({ accountId, sessionId: current.id, passwordHash: NEW_HASH, newTokenHash: freshToken().hash })).toBe(true);

    expect((await sessionRows(db, accountId)).map((row) => row.id)).toEqual([current.id]);
    expect(await store.lookupSession(bystanderSession.hash)).toBeDefined();
  });

  it("sets the signing session's creation no earlier than password_changed_at, which the lookup requires", async () => {
    const accountId = await account();
    const current = await signIn(accountId);
    await store.changePassword({ accountId, sessionId: current.id, passwordHash: NEW_HASH, newTokenHash: freshToken().hash });
    const [row] = await sessionRows(db, accountId);
    const changedAt = (await passwordRow(accountId)).changedAt;
    expect(changedAt).not.toBeNull();
    expect(row?.created_at.getTime()).toBeGreaterThanOrEqual(changedAt?.getTime() ?? Number.POSITIVE_INFINITY);
  });

  it("changes nothing when the session is not a full session of the account", async () => {
    const accountId = await account();
    const other = await account();
    const otherDevice = await signIn(accountId);
    const foreign = await signIn(other);
    const before = await passwordRow(accountId);

    expect(await store.changePassword({ accountId, sessionId: foreign.id, passwordHash: NEW_HASH, newTokenHash: freshToken().hash })).toBe(false);
    expect(await store.changePassword({ accountId, sessionId: freshId(), passwordHash: NEW_HASH, newTokenHash: freshToken().hash })).toBe(false);

    // The password write that came first is rolled back with the failed rotation.
    expect(await passwordRow(accountId)).toEqual(before);
    expect(await store.lookupSession(otherDevice.hash)).toBeDefined();
    expect(await store.lookupSession(foreign.hash)).toBeDefined();
  });

  it("leaves a partial session as it is: neither re-authenticated nor rotated, and the password change made from it is rolled back", async () => {
    const accountId = await account();
    const partial = freshToken();
    const partialId = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
        VALUES (${partialId}, ${partial.hash}, ${accountId}, 'partial', false, now() + interval '5 minutes', now() + interval '1 day')`,
    );
    expect(await store.markReauthenticated(partialId, accountId)).toBe(false);
    expect(await store.changePassword({ accountId, sessionId: partialId, passwordHash: NEW_HASH, newTokenHash: freshToken().hash })).toBe(false);
    expect(await passwordRow(accountId)).toEqual({ hash: OLD_HASH, changedAt: null });
    expect((await sessionRows(db, accountId)).map((row) => [row.id, row.token_hash.equals(partial.hash)])).toEqual([[partialId, true]]);
  });

  it("changes nothing for a disabled account", async () => {
    const accountId = await account({ disabledAt: new Date() });
    const session = freshToken();
    const sessionId = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
        VALUES (${sessionId}, ${session.hash}, ${accountId}, 'full', false, now() + interval '1 day', now() + interval '2 days')`,
    );
    expect(await store.changePassword({ accountId, sessionId, passwordHash: NEW_HASH, newTokenHash: freshToken().hash })).toBe(false);
    expect((await passwordRow(accountId)).hash).toBe(OLD_HASH);
  });

  it("rolls the password and the other sessions back when the rotation fails after the password was written", async () => {
    const accountId = await account();
    const current = await signIn(accountId);
    const otherDevice = await signIn(accountId);
    const taken = await signIn(await account());

    // The new token collides with one in use, so the rotation is refused by the unique index after sys_password_set ran.
    await expect(
      store.changePassword({ accountId, sessionId: current.id, passwordHash: NEW_HASH, newTokenHash: taken.hash }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await passwordRow(accountId)).toEqual({ hash: OLD_HASH, changedAt: null });
    expect((await store.lookupSession(current.hash))?.sessionId).toBe(current.id);
    expect((await store.lookupSession(otherDevice.hash))?.sessionId).toBe(otherDevice.id);
  });

  it("stores a hash in the encoding the application's hasher writes, with the version field and without it", async () => {
    for (const hash of [REAL_HASH, REAL_HASH.replace("$v=19", "")]) {
      const accountId = await account();
      const current = await signIn(accountId);
      expect(await store.changePassword({ accountId, sessionId: current.id, passwordHash: hash, newTokenHash: freshToken().hash })).toBe(true);
      expect((await passwordRow(accountId)).hash).toBe(hash);
    }
    expect(REAL_HASH.replace("$v=19", "")).not.toBe(REAL_HASH);
  });

  it("checks the shape of the hash and not the lengths of its salt and hash field: a one-character salt and hash are stored", async () => {
    const accountId = await account();
    const current = await signIn(accountId);
    const shortFields = "$argon2id$v=19$m=19456,t=2,p=1$A$A";
    expect(await store.changePassword({ accountId, sessionId: current.id, passwordHash: shortFields, newTokenHash: freshToken().hash })).toBe(true);
    expect((await passwordRow(accountId)).hash).toBe(shortFields);
  });

  it.each([
    ["a bare prefix", "$argon2id$"],
    ["a prefix and one character", "$argon2id$x"],
    ["a prefix and plain text", "$argon2id$this is not a hash"],
    ["a hash missing its hash field", "$argon2id$v=19$m=19456,t=2,p=1$sFLPcSAWqw4Wpd/8O0PrNw"],
    ["a hash missing its salt and hash fields", "$argon2id$v=19$m=19456,t=2,p=1$"],
    ["a hash of another variant", REAL_HASH.replace("$argon2id$", "$argon2i$")],
    ["a hash with a trailing newline", `${REAL_HASH}\n`],
    ["a hash with a trailing space", `${REAL_HASH} `],
    ["a hash with a leading space", ` ${REAL_HASH}`],
    ["a hash with a character outside the alphabet", `${REAL_HASH}!`],
    ["plain text", "plain text"],
    ["an empty string", ""],
  ])("refuses %s with invalid_parameter_value, leaving the password, its change time and the sessions as they were", async (_name, passwordHash) => {
    const accountId = await account();
    const current = await signIn(accountId);
    const otherDevice = await signIn(accountId);

    await expect(store.changePassword({ accountId, sessionId: current.id, passwordHash, newTokenHash: freshToken().hash })).rejects.toMatchObject({
      code: "22023",
    });

    expect(await passwordRow(accountId)).toEqual({ hash: OLD_HASH, changedAt: null });
    expect((await store.lookupSession(current.hash))?.sessionId).toBe(current.id);
    expect((await store.lookupSession(otherDevice.hash))?.sessionId).toBe(otherDevice.id);
  });

  it("refuses a token hash of the wrong length before sending anything", async () => {
    const accountId = await account();
    const current = await signIn(accountId);
    await expect(
      store.changePassword({ accountId, sessionId: current.id, passwordHash: NEW_HASH, newTokenHash: Buffer.alloc(31) }),
    ).rejects.toThrow(RangeError);
    expect(await passwordRow(accountId)).toEqual({ hash: OLD_HASH, changedAt: null });
  });

  it("lets two changes made at once from two sessions finish, one after the other, without a deadlock", async () => {
    const accountId = await account();
    const first = await signIn(accountId);
    const second = await signIn(accountId);
    const results = await Promise.all([
      store.changePassword({ accountId, sessionId: first.id, passwordHash: NEW_HASH, newTokenHash: freshToken().hash }),
      store.changePassword({ accountId, sessionId: second.id, passwordHash: NEW_HASH, newTokenHash: freshToken().hash }),
    ]);
    // The one that commits second finds its session already deleted by the first; it rolls back as a whole.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await sessionRows(db, accountId)).length).toBe(1);
  });
});
