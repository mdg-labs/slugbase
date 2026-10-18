import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type QueuedJob } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// Changing the address of an account (doc 05 section 3.3, doc 02 section 2.6, doc 10 T4, T8 and T18). The
// failure scenarios: a confirmation that moves the account to an address another account holds, or works
// twice, after its hour, after a newer request or after the change was cancelled; a request that tells a
// taken address from a free one; a "this wasn't me" link that leaves a session alive; an account nobody
// verified that completes a change.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;
const HOUR_SECONDS = 3_600;
const MAIL_QUEUE = "mail.send";
const WAIT_DEADLINE_MS = 10_000;
const WAIT_POLL_MS = 25;
const RACE_TEST_TIMEOUT_MS = 30_000;

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
  readonly disabled?: boolean;
  readonly email?: string;
}

/** An account with a verified address, unless the options say otherwise. */
async function account(options: Options = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, {
    id,
    email: options.email ?? `change${String(emailNumber)}@example.test`,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$b2xk",
    disabledAt: options.disabled === true ? new Date() : null,
  });
  await asSystem(db, (tx) => tx`UPDATE accounts SET email_verified_at = ${options.verified === false ? null : new Date()} WHERE id = ${id}`);
  return id;
}

async function session(accountId: string, level: "full" | "partial" = "full"): Promise<string> {
  const id = freshId();
  const hash = freshToken().hash;
  if (level === "partial") {
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = 'sealed'::bytea, mfa_secret_key_id = 'key-1', mfa_enabled_at = now() WHERE id = ${accountId}`);
  }
  expect((await db.app`SELECT sys_session_create(${id}::uuid, ${accountId}::uuid, ${level}::text, false, NULL, NULL, ${hash}::bytea, NULL) AS created`)[0]?.["created"]).toBe(true);
  return id;
}

function mailJob(accountId: string): QueuedJob {
  return { id: freshId(), queue: MAIL_QUEUE, data: { template: "emailChange", accountId } };
}

async function request(accountId: string, email: string): Promise<boolean> {
  return store.requestEmailChange({ accountId, email, jobs: [mailJob(accountId)] });
}

interface IssueResult {
  readonly pending: string | null;
  readonly hash: Buffer;
}

/** Issues a token the way the mail job does, as the account, and answers what the operation answered. */
async function issueAs(accountId: string, purpose: "email_change" | "email_change_cancel"): Promise<IssueResult> {
  const { hash } = freshToken();
  const rows = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    return tx<{ pending: string | null }[]>`
      SELECT sys_email_change_token_issue(${freshId()}::uuid, ${purpose}::text, ${accountId}::uuid, ${hash}::bytea, ${HOUR_SECONDS}::integer) AS pending`;
  });
  return { pending: rows[0]?.pending ?? null, hash };
}

async function confirmation(accountId: string): Promise<Buffer> {
  const issued = await issueAs(accountId, "email_change");
  expect(issued.pending).not.toBeNull();
  return issued.hash;
}

async function notice(accountId: string): Promise<Buffer> {
  const issued = await issueAs(accountId, "email_change_cancel");
  expect(issued.pending).not.toBeNull();
  return issued.hash;
}

async function resetToken(accountId: string): Promise<Buffer> {
  const { hash } = freshToken();
  const rows = await db.app`
    SELECT sys_credential_token_issue(${freshId()}::uuid, 'password_reset'::text, ${accountId}::uuid, ${hash}::bytea, NULL::text, ${HOUR_SECONDS}::integer) AS issued`;
  expect(rows[0]?.["issued"]).toBe(true);
  return hash;
}

/** An account whose change to `to` was started and confirmed, and the notice's cancel token it was issued before that. */
async function confirmed(from: string, to: string): Promise<{ owner: string; cancel: Buffer }> {
  const owner = await account({ email: from });
  await request(owner, to);
  const cancel = await notice(owner);
  expect(await store.confirmEmailChange(await confirmation(owner))).toEqual({ accountId: owner });
  return { owner, cancel };
}

interface AccountRow {
  email: string;
  pending_email: string | null;
  verified: boolean;
}

async function accountRow(accountId: string): Promise<AccountRow | undefined> {
  const rows = await asSystem(db, (tx) => tx<AccountRow[]>`SELECT email, pending_email, email_verified_at IS NOT NULL AS verified FROM accounts WHERE id = ${accountId}`);
  return rows[0];
}

async function tokenRows(accountId: string): Promise<{ purpose: string; used: boolean; target_email: string | null }[]> {
  return [
    ...(await asSystem(
      db,
      (tx) =>
        tx<{ purpose: string; used: boolean; target_email: string | null }[]>`
          SELECT purpose, used_at IS NOT NULL AS used, target_email FROM credential_tokens WHERE account_id = ${accountId} ORDER BY purpose, created_at`,
    )),
  ];
}

async function queued(): Promise<{ name: string; data: Record<string, unknown> }[]> {
  return [...(await db.app<{ name: string; data: Record<string, unknown> }[]>`SELECT name, data FROM pgboss.job ORDER BY id`)];
}

describe("the system operations", () => {
  it("are registered", () => {
    expect(systemOperations).toEqual(
      expect.arrayContaining([
        "sys_email_change_request",
        "sys_email_change_clear",
        "sys_email_change_token_issue",
        "sys_email_change_confirm",
        "sys_email_change_cancel",
      ]),
    );
  });
});

describe("requestEmailChange", () => {
  it("records the address and queues the jobs in one transaction", async () => {
    const owner = await account();

    expect(await request(owner, "New.Address@example.test")).toBe(true);

    expect((await accountRow(owner))?.pending_email).toBe("New.Address@example.test");
    expect(await queued()).toEqual([{ name: MAIL_QUEUE, data: { template: "emailChange", accountId: owner } }]);
  });

  it("does the same for an address an account holds, for the account's own and for a free one: the pending address is recorded and the jobs are queued", async () => {
    const owner = await account();
    const other = await account({ email: "taken@example.test" });
    const own = (await accountRow(owner))?.email ?? "";

    for (const address of ["taken@example.test", own, "free@example.test"]) {
      await db.owner`TRUNCATE pgboss.job`;
      expect(await request(owner, address)).toBe(true);
      expect((await accountRow(owner))?.pending_email).toBe(address);
      expect(await queued()).toHaveLength(1);
    }
    expect(await accountRow(other)).toMatchObject({ email: "taken@example.test", pending_email: null });
  });

  it("deletes the unused tokens of an earlier request, of both purposes, and keeps a used one and another account's", async () => {
    const owner = await account();
    const bystander = await account();
    await request(owner, "first@example.test");
    const used = await confirmation(owner);
    await notice(owner);
    await request(bystander, "bystander-new@example.test");
    await confirmation(bystander);
    await store.confirmEmailChange(used);
    await request(owner, "second@example.test");
    await confirmation(owner);
    await notice(owner);
    await request(owner, "third@example.test");

    expect(await tokenRows(owner)).toEqual([{ purpose: "email_change", used: true, target_email: "first@example.test" }]);
    expect(await tokenRows(bystander)).toEqual([{ purpose: "email_change", used: false, target_email: "bystander-new@example.test" }]);
  });

  it("answers false, changing nothing and queueing nothing, for a disabled account and an unknown one", async () => {
    const disabled = await account({ disabled: true });

    expect(await request(disabled, "new@example.test")).toBe(false);
    expect(await request(freshId(), "new@example.test")).toBe(false);

    expect((await accountRow(disabled))?.pending_email).toBeNull();
    expect(await queued()).toEqual([]);
  });

  it("undoes the pending address when a job cannot be queued", async () => {
    const owner = await account();

    await expect(store.requestEmailChange({ accountId: owner, email: "new@example.test", jobs: [{ id: freshId(), queue: "no.such.queue", data: {} }] })).rejects.toThrow();

    expect((await accountRow(owner))?.pending_email).toBeNull();
  });
});

describe("the token issue", () => {
  it("issues a confirmation for a free address, recording the address it moves to, and a cancel token recording the address the account holds", async () => {
    const owner = await account({ email: "held@example.test" });
    await request(owner, "new@example.test");

    expect((await issueAs(owner, "email_change")).pending).toBe("new@example.test");
    expect((await issueAs(owner, "email_change_cancel")).pending).toBe("new@example.test");

    expect(await tokenRows(owner)).toEqual([
      { purpose: "email_change", used: false, target_email: "new@example.test" },
      { purpose: "email_change_cancel", used: false, target_email: "held@example.test" },
    ]);
  });

  it("issues no confirmation when the address is another account's, whatever its spelling, or the account's own, and still issues the notice's token", async () => {
    const owner = await account();
    await account({ email: "Taken@Example.test" });
    const own = (await accountRow(owner))?.email ?? "";

    for (const address of ["taken@example.test", own.toUpperCase()]) {
      await request(owner, address);
      expect((await issueAs(owner, "email_change")).pending).toBeNull();
      expect((await issueAs(owner, "email_change_cancel")).pending).toBe(address);
    }
    expect((await tokenRows(owner)).filter((row) => row.purpose === "email_change")).toEqual([]);
  });

  it("deletes the confirmation an earlier run issued when a later run finds the address taken, so the link already mailed stops working", async () => {
    const owner = await account();
    await request(owner, "contested@example.test");
    const mailed = await confirmation(owner);
    const holder = await account({ email: "contested@example.test" });

    expect((await issueAs(owner, "email_change")).pending).toBeNull();
    await asSystem(db, (tx) => tx`UPDATE accounts SET email = 'moved-on@example.test' WHERE id = ${holder}`);

    expect((await tokenRows(owner)).filter((row) => row.purpose === "email_change")).toEqual([]);
    expect(await store.confirmEmailChange(mailed)).toBeUndefined();
    expect(await accountRow(owner)).toMatchObject({ pending_email: "contested@example.test" });
  });

  it("issues nothing when no change is pending, and for a disabled account and one nobody verified", async () => {
    const none = await account();
    const disabled = await account();
    const unverified = await account({ verified: false });
    await request(disabled, "new@example.test");
    await request(unverified, "new@example.test");
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled}`);

    for (const owner of [none, disabled, unverified]) {
      expect((await issueAs(owner, "email_change")).pending).toBeNull();
      expect((await issueAs(owner, "email_change_cancel")).pending).toBeNull();
      expect(await tokenRows(owner)).toEqual([]);
    }
  });

  it("replaces the account's earlier unused token of the purpose", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const older = await confirmation(owner);
    const newer = await confirmation(owner);

    expect(await store.confirmEmailChange(older)).toBeUndefined();
    expect(await store.confirmEmailChange(newer)).toEqual({ accountId: owner });
  });

  it("refuses a purpose that is not an email change", async () => {
    const owner = await account();
    await expect(
      db.app`SELECT sys_email_change_token_issue(${freshId()}::uuid, 'password_reset'::text, ${owner}::uuid, ${freshToken().hash}::bytea, 3600::integer)`,
    ).rejects.toMatchObject({ code: "22023" });
  });
});

describe("confirmEmailChange", () => {
  it("moves the account to the address, clears the pending one, keeps the verified time and every session", async () => {
    const owner = await account();
    const kept = await session(owner);
    await request(owner, "new@example.test");

    expect(await store.confirmEmailChange(await confirmation(owner))).toEqual({ accountId: owner });

    expect(await accountRow(owner)).toEqual({ email: "new@example.test", pending_email: null, verified: true });
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([kept]);
  });

  it("answers nothing for the same token the second time", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const token = await confirmation(owner);
    expect(await store.confirmEmailChange(token)).toEqual({ accountId: owner });
    await request(owner, "another@example.test");

    expect(await store.confirmEmailChange(token)).toBeUndefined();

    expect((await accountRow(owner))?.email).toBe("new@example.test");
  });

  it("lets exactly one of several simultaneous redemptions of one token through", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const token = await confirmation(owner);

    const outcomes = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.confirmEmailChange(token)));

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
  });

  it("refuses an address another account holds by the time of the confirmation, as it refuses an unknown token, and changes nothing", async () => {
    const owner = await account();
    await request(owner, "contested@example.test");
    const token = await confirmation(owner);
    const rival = await account({ email: "contested@example.test" });

    expect(await store.confirmEmailChange(token)).toBeUndefined();
    expect(await store.confirmEmailChange(freshToken().hash)).toBeUndefined();

    expect(await accountRow(owner)).toMatchObject({ pending_email: "contested@example.test" });
    expect((await accountRow(owner))?.email).not.toBe("contested@example.test");
    expect((await accountRow(rival))?.email).toBe("contested@example.test");
  });

  it("lets only one of two accounts that confirm the same address at once take it, and fails the other as it fails an unknown token", async () => {
    const first = await account();
    const second = await account();
    await request(first, "race@example.test");
    await request(second, "race@example.test");
    const tokens = [await confirmation(first), await confirmation(second)];

    const outcomes = await Promise.all(tokens.map((token) => store.confirmEmailChange(token)));

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
    const holders = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts WHERE email = 'race@example.test'`);
    expect(holders).toHaveLength(1);
  });

  it("refuses a token after its hour, an unknown token and a token of another purpose, all alike, changing nothing", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const stale = await confirmation(owner);
    await asSystem(db, (tx) => tx`UPDATE credential_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = ${stale}`);
    const cancel = await notice(owner);

    for (const hash of [stale, freshToken().hash, cancel]) {
      expect(await store.confirmEmailChange(hash)).toBeUndefined();
    }

    expect(await accountRow(owner)).toMatchObject({ pending_email: "new@example.test" });
    expect((await accountRow(owner))?.email).not.toBe("new@example.test");
  });

  it("refuses a token of a change that was cancelled or asked for again, and the token of the account it was not issued to", async () => {
    const owner = await account();
    const other = await account();
    await request(owner, "new@example.test");
    const cancelled = await confirmation(owner);
    await store.cancelPendingEmailChange(owner);
    await request(owner, "second@example.test");
    const replaced = await confirmation(owner);
    await asSystem(db, (tx) => tx`UPDATE accounts SET pending_email = 'third@example.test' WHERE id = ${owner}`);

    expect(await store.confirmEmailChange(cancelled)).toBeUndefined();
    expect(await store.confirmEmailChange(replaced)).toBeUndefined();

    expect((await accountRow(owner))?.email).not.toMatch(/new|second|third/);
    expect((await accountRow(other))?.pending_email).toBeNull();
  });

  it("refuses the token of a disabled account and of one nobody verified", async () => {
    const disabled = await account();
    const unverified = await account();
    await request(disabled, "disabled-new@example.test");
    await request(unverified, "unverified-new@example.test");
    const tokens = [await confirmation(disabled), await confirmation(unverified)];
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled}`);
    await asSystem(db, (tx) => tx`UPDATE accounts SET email_verified_at = NULL WHERE id = ${unverified}`);

    for (const token of tokens) {
      expect(await store.confirmEmailChange(token)).toBeUndefined();
    }

    expect((await accountRow(disabled))?.email).not.toBe("disabled-new@example.test");
    expect((await accountRow(unverified))?.email).not.toBe("unverified-new@example.test");
  });

  it("keeps the notice's cancel token usable after the change", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const cancel = await notice(owner);
    await store.confirmEmailChange(await confirmation(owner));

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });
  });
});

describe("cancelPendingEmailChange", () => {
  it("clears the pending address and deletes the unused tokens of both purposes", async () => {
    const owner = await account();
    const other = await account();
    await request(owner, "new@example.test");
    const confirm = await confirmation(owner);
    const cancel = await notice(owner);
    await request(other, "other-new@example.test");
    await confirmation(other);

    expect(await store.cancelPendingEmailChange(owner)).toBe(true);

    expect(await accountRow(owner)).toMatchObject({ pending_email: null });
    expect(await tokenRows(owner)).toEqual([]);
    expect(await store.confirmEmailChange(confirm)).toBeUndefined();
    expect(await store.cancelEmailChange(cancel)).toBeUndefined();
    expect(await accountRow(other)).toMatchObject({ pending_email: "other-new@example.test" });
    expect(await tokenRows(other)).toHaveLength(1);
  });

  it("is a repeat that changes nothing, and answers false for a disabled account and an unknown one", async () => {
    const owner = await account();
    const disabled = await account({ disabled: true });

    expect(await store.cancelPendingEmailChange(owner)).toBe(true);
    expect(await store.cancelPendingEmailChange(owner)).toBe(true);
    expect(await store.cancelPendingEmailChange(disabled)).toBe(false);
    expect(await store.cancelPendingEmailChange(freshId())).toBe(false);
  });
});

describe("cancelEmailChange", () => {
  it("puts the address the change replaced back after the change was confirmed, keeps it verified, deletes every session and the unused reset, email-change and cancel tokens", async () => {
    const { owner, cancel } = await confirmed("restore.old@example.test", "restore.new@example.test");
    const bystander = await account();
    const bystanderSession = await session(bystander);
    await session(owner);
    await session(owner, "partial");
    const reset = await resetToken(owner);
    for (const purpose of ["email_change", "email_change_cancel"]) {
      await asSystem(
        db,
        (tx) => tx`INSERT INTO credential_tokens (id, purpose, account_id, token_hash, expires_at) VALUES (${freshId()}, ${purpose}, ${owner}, ${freshToken().hash}, now() + interval '1 hour')`,
      );
    }
    expect((await tokenRows(owner)).filter((row) => !row.used)).toHaveLength(4);

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });

    expect(await accountRow(owner)).toEqual({ email: "restore.old@example.test", pending_email: null, verified: true });
    expect(await sessionRows(db, owner)).toEqual([]);
    expect((await sessionRows(db, bystander)).map((row) => row.id)).toEqual([bystanderSession]);
    expect((await tokenRows(owner)).filter((row) => !row.used)).toEqual([]);
    expect(await db.app`SELECT * FROM sys_credential_token_consume('password_reset', ${reset}::bytea)`).toHaveLength(0);
    expect(await store.cancelEmailChange(cancel)).toBeUndefined();
  });

  it("makes a password reset requested to the address the change moved to unredeemable once the link restored the old one", async () => {
    const { owner, cancel } = await confirmed("scenario.old@example.test", "scenario.new@example.test");
    const reset = await resetToken(owner);

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });

    expect(await db.app`SELECT * FROM sys_credential_token_consume('password_reset', ${reset}::bytea)`).toHaveLength(0);
  });

  it("restores the address whatever the case of the spelling it replaced, and leaves the verified time alone", async () => {
    const { owner, cancel } = await confirmed("Mixed.Case@Example.test", "mixed.new@example.test");
    const before = await asSystem(db, (tx) => tx`SELECT email_verified_at FROM accounts WHERE id = ${owner}`);

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });

    expect((await accountRow(owner))?.email).toBe("Mixed.Case@Example.test");
    expect(await asSystem(db, (tx) => tx`SELECT email_verified_at FROM accounts WHERE id = ${owner}`)).toEqual(before);
  });

  it("keeps the account's current address when another account holds the old one by now, ends every session and answers as for a restore", async () => {
    const { owner, cancel } = await confirmed("taken.old@example.test", "taken.new@example.test");
    const holder = await account({ email: "Taken.Old@example.test" });
    await session(owner);
    const reset = await resetToken(owner);

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });

    expect(await accountRow(owner)).toMatchObject({ email: "taken.new@example.test", pending_email: null, verified: true });
    expect(await accountRow(holder)).toMatchObject({ email: "Taken.Old@example.test" });
    expect(await sessionRows(db, owner)).toEqual([]);
    expect(await db.app`SELECT * FROM sys_credential_token_consume('password_reset', ${reset}::bytea)`).toHaveLength(0);
    expect((await tokenRows(owner)).filter((row) => !row.used)).toEqual([]);
  });

  it("does not take over an address a registration commits while the restore runs: the account keeps its current address and every session still ends", async () => {
    const { owner, cancel } = await confirmed("race.old@example.test", "race.new@example.test");
    await session(owner);
    const registering = freshId();
    let redeeming: ReturnType<typeof store.cancelEmailChange> | undefined;

    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${registering}, true)`;
      await tx`INSERT INTO accounts (id, email, display_name) VALUES (${registering}, 'race.old@example.test', 'Registering')`;
      redeeming = store.cancelEmailChange(cancel);
      const deadline = Date.now() + WAIT_DEADLINE_MS;
      for (;;) {
        const waiting = await db.owner<{ waiting: string }[]>`
          SELECT count(*)::text AS waiting FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
          WHERE NOT l.granted AND s.datname = current_database()`;
        if (Number(waiting[0]?.waiting ?? 0) > 0) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("the restore never waited for the registration");
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      }
    });

    expect(await redeeming).toEqual({ accountId: owner });
    expect(await accountRow(owner)).toMatchObject({ email: "race.new@example.test", pending_email: null });
    expect(await accountRow(registering)).toMatchObject({ email: "race.old@example.test" });
    expect(await sessionRows(db, owner)).toEqual([]);
  }, RACE_TEST_TIMEOUT_MS);

  it("answers a replay of the restoring token as an invalid one and changes nothing", async () => {
    const { owner, cancel } = await confirmed("replay.old@example.test", "replay.new@example.test");
    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });
    await asSystem(db, (tx) => tx`UPDATE accounts SET email = 'replay.later@example.test' WHERE id = ${owner}`);
    const later = await session(owner);

    expect(await store.cancelEmailChange(cancel)).toBeUndefined();

    expect((await accountRow(owner))?.email).toBe("replay.later@example.test");
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([later]);
  });

  it("leaves the address and the account's reset tokens alone when the change was not confirmed", async () => {
    const owner = await account({ email: "pending.old@example.test" });
    await request(owner, "pending.new@example.test");
    const cancel = await notice(owner);
    const confirm = await confirmation(owner);
    const reset = await resetToken(owner);

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });

    expect(await accountRow(owner)).toMatchObject({ email: "pending.old@example.test", pending_email: null });
    expect(await store.confirmEmailChange(confirm)).toBeUndefined();
    expect(await tokenRows(owner)).toContainEqual({ purpose: "password_reset", used: false, target_email: null });
    expect(await db.app`SELECT * FROM sys_credential_token_consume('password_reset', ${reset}::bytea)`).toHaveLength(1);
  });

  it("cancels the pending change and deletes every session of the account, partial ones included, and no other account's", async () => {
    const owner = await account();
    const bystander = await account();
    const bystanderSession = await session(bystander);
    await session(owner);
    await session(owner);
    await request(owner, "new@example.test");
    const confirm = await confirmation(owner);
    const cancel = await notice(owner);

    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });

    expect(await accountRow(owner)).toMatchObject({ pending_email: null });
    expect(await sessionRows(db, owner)).toEqual([]);
    expect((await sessionRows(db, bystander)).map((row) => row.id)).toEqual([bystanderSession]);
    expect(await store.confirmEmailChange(confirm)).toBeUndefined();
    expect((await accountRow(owner))?.email).not.toBe("new@example.test");
  });

  it("deletes the sessions of an account whose second factor is on", async () => {
    const owner = await account();
    await session(owner, "partial");
    await request(owner, "new@example.test");

    expect(await store.cancelEmailChange(await notice(owner))).toEqual({ accountId: owner });

    expect(await sessionRows(db, owner)).toEqual([]);
  });

  it("answers nothing for the same token the second time, and a replay ends no session", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const cancel = await notice(owner);
    expect(await store.cancelEmailChange(cancel)).toEqual({ accountId: owner });
    const later = await session(owner);

    expect(await store.cancelEmailChange(cancel)).toBeUndefined();

    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([later]);
  });

  it("refuses a token after its hour, an unknown token, a token of another purpose and the token of a disabled account, all alike, ending no session", async () => {
    const owner = await account();
    const disabled = await account();
    const kept = await session(owner);
    const disabledSession = await session(disabled);
    await request(owner, "new@example.test");
    await request(disabled, "disabled-new@example.test");
    const stale = await notice(owner);
    await asSystem(db, (tx) => tx`UPDATE credential_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = ${stale}`);
    const confirm = await confirmation(owner);
    const disabledCancel = await notice(disabled);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${disabled}`);

    for (const hash of [stale, freshToken().hash, confirm, disabledCancel]) {
      expect(await store.cancelEmailChange(hash)).toBeUndefined();
    }

    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([kept]);
    expect((await sessionRows(db, disabled)).map((row) => row.id)).toEqual([disabledSession]);
    expect(await accountRow(owner)).toMatchObject({ pending_email: "new@example.test" });
  });

  it("lets exactly one of several simultaneous redemptions of one token through", async () => {
    const owner = await account();
    await request(owner, "new@example.test");
    const cancel = await notice(owner);

    const outcomes = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.cancelEmailChange(cancel)));

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
  });
});
