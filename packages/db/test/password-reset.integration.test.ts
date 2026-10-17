import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type PasswordReset, type QueuedJob } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// Redeeming a password-reset token (doc 05 section 3.3, doc 02 section 2.5, doc 10 T4, T8 and T17). The failure
// scenarios: a reset token that works twice, after its hour, after a newer one was issued or for another
// purpose; a reset that leaves a session of the old password alive; a reset that signs a second-factor account
// in with a full session; a reset that commits the password without the session, or the other way round.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;
const HOUR_SECONDS = 3_600;
const MAIL_QUEUE = "mail.send";
const OLD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$b2xk";
const NEW_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$bmV3";

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
  store = createAuthStore({ url: appUrl(db), poolSize: PARALLEL_CALLS });
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    INSERT INTO pgboss.queue VALUES ('${MAIL_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  await db.owner`TRUNCATE accounts CASCADE`;
});

let emailNumber = 0;

interface Options {
  readonly verified?: boolean;
  readonly mfa?: boolean;
}

/** An account with a password, a verified address and no second factor, unless the options say otherwise. */
async function account(options: Options = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `reset${String(emailNumber)}@example.test`, passwordHash: OLD_HASH });
  await asSystem(
    db,
    (tx) => tx`
      UPDATE accounts SET
        email_verified_at = ${options.verified === false ? null : new Date()},
        mfa_secret = ${options.mfa === true ? Buffer.from("sealed") : null},
        mfa_secret_key_id = ${options.mfa === true ? "key-1" : null},
        mfa_enabled_at = ${options.mfa === true ? new Date() : null}
      WHERE id = ${id}`,
  );
  return id;
}

async function session(accountId: string, hash = freshToken().hash): Promise<string> {
  const id = freshId();
  expect((await db.app`SELECT sys_session_create(${id}::uuid, ${accountId}::uuid, 'full', false, NULL, NULL, ${hash}::bytea, NULL) AS created`)[0]?.["created"]).toBe(true);
  return id;
}

async function issue(accountId: string, purpose = "password_reset"): Promise<Buffer> {
  const { hash } = freshToken();
  const result = await db.app`
    SELECT sys_credential_token_issue(${freshId()}::uuid, ${purpose}::text, ${accountId}::uuid, ${hash}::bytea, NULL::text, ${HOUR_SECONDS}::integer) AS issued`;
  expect(result[0]?.["issued"]).toBe(true);
  return hash;
}

function reset(tokenHash: Buffer, overrides: Partial<PasswordReset> = {}): PasswordReset {
  return { tokenHash, passwordHash: NEW_HASH, sessionId: freshId(), sessionTokenHash: freshToken().hash, ipPrefix: null, userAgent: null, replacedTokenHash: null, ...overrides };
}

interface AccountRow {
  password_hash: string | null;
  verified: boolean;
  password_changed: boolean;
}

async function accountRow(accountId: string): Promise<AccountRow | undefined> {
  const rows = await asSystem(
    db,
    (tx) => tx<AccountRow[]>`
      SELECT password_hash, email_verified_at IS NOT NULL AS verified, password_changed_at IS NOT NULL AS password_changed
      FROM accounts WHERE id = ${accountId}`,
  );
  return rows[0];
}

async function tokenRows(accountId: string): Promise<{ used: boolean }[]> {
  return [...(await asSystem(db, (tx) => tx<{ used: boolean }[]>`SELECT used_at IS NOT NULL AS used FROM credential_tokens WHERE account_id = ${accountId} ORDER BY created_at`))];
}

async function queued(): Promise<{ name: string; data: Record<string, unknown> }[]> {
  return [...(await db.app<{ name: string; data: Record<string, unknown> }[]>`SELECT name, data FROM pgboss.job ORDER BY id`)];
}

describe("the system operation", () => {
  it("is registered", () => {
    expect(systemOperations).toContain("sys_password_reset");
  });
});

describe("resetPassword", () => {
  it("replaces the password, deletes every session the account had and signs it in with a fresh one", async () => {
    const owner = await account();
    const oldToken = freshToken().hash;
    const before = [await session(owner, oldToken), await session(owner)];
    const input = reset(await issue(owner));

    expect(await store.resetPassword(input)).toEqual({ accountId: owner, next: "done" });

    expect(await accountRow(owner)).toEqual({ password_hash: NEW_HASH, verified: true, password_changed: true });
    const sessions = await sessionRows(db, owner);
    expect(sessions.map((row) => row.id)).toEqual([input.sessionId]);
    expect(sessions[0]).toMatchObject({ level: "full", token_hash: input.sessionTokenHash });
    expect(before).not.toContain(input.sessionId);
    expect(await store.lookupSession(oldToken)).toBeUndefined();
    expect(await store.lookupSession(input.sessionTokenHash)).toMatchObject({ accountId: owner, level: "full" });
  });

  it("answers nothing for the same token the second time, and a replay changes no password and no session", async () => {
    const owner = await account();
    const token = await issue(owner);
    const first = reset(token);
    expect(await store.resetPassword(first)).toEqual({ accountId: owner, next: "done" });

    expect(await store.resetPassword(reset(token, { passwordHash: OLD_HASH }))).toBeUndefined();

    expect((await accountRow(owner))?.password_hash).toBe(NEW_HASH);
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([first.sessionId]);
  });

  it("lets exactly one of several simultaneous redemptions of one token through", async () => {
    const owner = await account();
    const token = await issue(owner);

    const outcomes = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.resetPassword(reset(token))));

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
    expect(await sessionRows(db, owner)).toHaveLength(1);
  });

  it("refuses a token after its hour, an unknown token and a token of another purpose, all alike, changing nothing", async () => {
    const owner = await account();
    const kept = await session(owner);
    const stale = await issue(owner);
    await asSystem(db, (tx) => tx`UPDATE credential_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = ${stale}`);
    const verification = await issue(owner, "email_verify");

    for (const hash of [stale, freshToken().hash, verification]) {
      expect(await store.resetPassword(reset(hash))).toBeUndefined();
    }

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: true, password_changed: false });
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([kept]);
  });

  it("refuses a token once a newer one was issued to the account, and honours the newer one", async () => {
    const owner = await account();
    const older = await issue(owner);
    const newer = await issue(owner);

    expect(await store.resetPassword(reset(older))).toBeUndefined();
    expect(await store.resetPassword(reset(newer))).toEqual({ accountId: owner, next: "done" });
  });

  it("resets only the account the token was issued to", async () => {
    const owner = await account();
    const other = await account();
    const otherSession = await session(other);
    await issue(other);

    expect(await store.resetPassword(reset(await issue(owner)))).toEqual({ accountId: owner, next: "done" });

    expect(await accountRow(other)).toEqual({ password_hash: OLD_HASH, verified: true, password_changed: false });
    expect((await sessionRows(db, other)).map((row) => row.id)).toEqual([otherSession]);
    expect(await tokenRows(other)).toEqual([{ used: false }]);
  });

  it("makes a partial session for an account whose second factor is on, so the mailbox alone does not sign it in", async () => {
    const owner = await account({ mfa: true });
    const input = reset(await issue(owner));

    expect(await store.resetPassword(input)).toEqual({ accountId: owner, next: "mfa" });

    expect((await sessionRows(db, owner)).map((row) => row.level)).toEqual(["partial"]);
    expect((await store.lookupSession(input.sessionTokenHash))?.level).toBe("partial");
    expect((await accountRow(owner))?.password_hash).toBe(NEW_HASH);
  });

  it("answers nothing for an account whose address was never verified, changing nothing but the use of the token", async () => {
    const owner = await account({ verified: false });
    const kept = await session(owner);
    const token = await issue(owner);

    expect(await store.resetPassword(reset(token))).toBeUndefined();

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([kept]);
    expect(await tokenRows(owner)).toEqual([{ used: true }]);
  });

  it("answers nothing for an account that was disabled after the token was issued", async () => {
    const owner = await account();
    const token = await issue(owner);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${owner}`);

    expect(await store.resetPassword(reset(token))).toBeUndefined();

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: true, password_changed: false });
    expect(await sessionRows(db, owner)).toEqual([]);
  });

  it("ends the session of the cookie the request carried", async () => {
    const owner = await account();
    const carried = freshToken().hash;
    await session(owner, carried);

    await store.resetPassword(reset(await issue(owner), { replacedTokenHash: carried }));

    expect(await store.lookupSession(carried)).toBeUndefined();
  });

  it("undoes the new password, the deleted sessions and the use of the token when the session cannot be created", async () => {
    const owner = await account();
    const kept = await session(owner);
    const token = await issue(owner);
    await db.owner.unsafe(`
      CREATE FUNCTION public.refuse_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no session'; END $$;
      CREATE TRIGGER refuse_session BEFORE INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.refuse_session();`);
    try {
      await expect(store.resetPassword(reset(token))).rejects.toThrow();
    } finally {
      await db.owner.unsafe("DROP TRIGGER refuse_session ON public.sessions; DROP FUNCTION public.refuse_session()");
    }

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: true, password_changed: false });
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([kept]);
    expect(await tokenRows(owner)).toEqual([{ used: false }]);
    expect(await store.resetPassword(reset(token))).toEqual({ accountId: owner, next: "done" });
  });

  it("refuses a malformed argument before it consumes anything", async () => {
    const owner = await account();
    const token = await issue(owner);

    await expect(store.resetPassword(reset(token, { passwordHash: "plain text" }))).rejects.toThrow();
    await expect(store.resetPassword(reset(Buffer.alloc(8)))).rejects.toThrow(RangeError);

    expect(await tokenRows(owner)).toEqual([{ used: false }]);
  });

  it("is not reachable by the application role through the tables it reads", async () => {
    await expect(db.app`SELECT * FROM credential_tokens`).rejects.toThrow(/permission denied/);
  });
});

describe("requestPasswordReset", () => {
  function mail(accountId: string): QueuedJob {
    return { id: freshId(), queue: MAIL_QUEUE, data: { template: "passwordReset", accountId } };
  }

  async function addressOf(accountId: string): Promise<string> {
    const rows = await asSystem(db, (tx) => tx<{ email: string }[]>`SELECT email::text AS email FROM accounts WHERE id = ${accountId}`);
    return rows[0]?.email ?? "";
  }

  it("queues the job built for the account that holds the address, whatever its state", async () => {
    const verified = await account();
    const unverified = await account({ verified: false });

    for (const id of [verified, unverified]) {
      await store.requestPasswordReset({ email: (await addressOf(id)).toUpperCase(), onKnown: (accountId) => [mail(accountId)], onUnknown: [mail(freshId())] });
    }

    expect((await queued()).map((job) => job.data["accountId"]).sort()).toEqual([verified, unverified].sort());
  });

  it("queues the onUnknown jobs, and not the onKnown ones, for an address no account holds", async () => {
    const stranger = freshId();
    let asked = false;

    await store.requestPasswordReset({
      email: "nobody@example.test",
      onKnown: () => {
        asked = true;
        return [];
      },
      onUnknown: [mail(stranger)],
    });

    expect(asked).toBe(false);
    expect((await queued()).map((job) => job.data["accountId"])).toEqual([stranger]);
  });

  it("creates and changes nothing but the job: no token, session or password", async () => {
    const id = await account();
    await session(id);
    const snapshot = async () =>
      asSystem(db, async (tx) => ({
        account: (await tx`SELECT password_hash, email_verified_at, password_changed_at FROM accounts WHERE id = ${id}`)[0],
        tokens: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM credential_tokens`)[0]?.n,
        sessions: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions`)[0]?.n,
      }));
    const before = await snapshot();

    await store.requestPasswordReset({ email: await addressOf(id), onKnown: (accountId) => [mail(accountId)], onUnknown: [mail(freshId())] });

    expect(await snapshot()).toEqual(before);
    expect(await queued()).toHaveLength(1);
  });

  it("undoes the jobs already queued when a later one cannot be, and rejects", async () => {
    const id = await account();
    const missing: QueuedJob = { id: freshId(), queue: "no.such.queue", data: {} };

    await expect(store.requestPasswordReset({ email: await addressOf(id), onKnown: (accountId) => [mail(accountId), missing], onUnknown: [] })).rejects.toThrow();

    expect(await queued()).toEqual([]);
  });
});
