import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, instanceRepository, type AuthStore, type PasswordReset, type QueuedJob, type TenantTx } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// The recovery operations of the CE instance admin (doc 05 sections 2.9 and 3.3, doc 02 sections 2.5, 2.6, 2.7 and
// 11.2, doc 10 T4, T7, T17 and T18). The failure scenarios: an account that is not an instance admin with a second
// factor that reaches a recovery function, which must raise and change nothing; a reset of the second factor that
// leaves a secret, a backup code or a session of the account alive, or copies the secret anywhere (the audit event,
// the queued job); two admins who reset one account at once and tell it twice; a reset link issued for an account whose
// redemption refuses it, or that leaves a token behind where it was to be mailed; an address marked verified that leaves
// the registrant's password, session, second factor, API token or linked identity working on the account, or the
// verification link mailed before it; an account so cleaned that no reset link reaches its owner; and a disabled account
// that gets a link, a mail or a reset.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER = "22023";
const MAIL_QUEUE = "mail.send";
const SECRET = Buffer.from("sealed-totp-secret");

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
  store = createAuthStore({ url: appUrl(db), poolSize: 2 });
  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes and reads.
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

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
});

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

interface Options {
  readonly admin?: boolean;
  readonly mfa?: boolean;
  readonly disabled?: boolean;
  readonly verified?: boolean;
  readonly password?: boolean;
  /** A linked provider identity, the sign-in method of an account that has no password. */
  readonly identity?: boolean;
}

async function account(options: Options = {}): Promise<{ id: string; email: string }> {
  emailNumber += 1;
  const id = freshId();
  const email = `instance-recovery${String(emailNumber)}@example.test`;
  await seedAccount(db, {
    id,
    email,
    passwordHash: options.password === false ? null : "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    disabledAt: options.disabled === true ? new Date() : null,
    emailVerified: options.verified !== false,
  });
  if (options.identity === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${freshId()}, ${id}, 'idp', ${`subject-${id}`}, ${email})`;
    });
  }
  if (options.mfa === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${SECRET}, mfa_secret_key_id = 'key-1', mfa_last_step = 42 WHERE id = ${id}`;
    });
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO mfa_backup_codes (id, account_id, code_hash, used_at)
        VALUES (${freshId()}, ${id}, ${Buffer.from("hash-1")}, NULL), (${freshId()}, ${id}, ${Buffer.from("hash-2")}, now())`,
    );
  }
  return { id, email };
}

const admin = async (): Promise<string> => (await account({ admin: true, mfa: true })).id;

function withTenant<T>(accountId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "req-instance-recovery" }, work);
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    const code = errorCode(error);
    if (typeof code !== "string") {
      throw error;
    }
    return code;
  }
  return undefined;
}

function errorCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string") {
      return code;
    }
    current = cause;
  }
  return undefined;
}

interface InstanceEventRow {
  id: string;
  actor_account_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  ip_prefix: string | null;
}

async function instanceEvents(): Promise<InstanceEventRow[]> {
  const rows = await asSystem(
    db,
    (tx) =>
      tx<InstanceEventRow[]>`
        SELECT id, actor_account_id, action, entity_type, entity_id, metadata, ip_prefix::text AS ip_prefix
        FROM audit_events WHERE workspace_id IS NULL ORDER BY created_at, id`,
  );
  return [...rows];
}

interface MfaState {
  mfa_secret: Buffer | null;
  mfa_secret_key_id: string | null;
  mfa_enabled_at: Date | null;
  mfa_last_step: string | null;
  codes: number;
}

async function mfaState(accountId: string): Promise<MfaState | undefined> {
  const rows = await asSystem(
    db,
    (tx) =>
      tx<MfaState[]>`
        SELECT a.mfa_secret, a.mfa_secret_key_id, a.mfa_enabled_at, a.mfa_last_step::text AS mfa_last_step,
               (SELECT count(*)::int FROM mfa_backup_codes c WHERE c.account_id = a.id) AS codes
        FROM accounts a WHERE a.id = ${accountId}`,
  );
  return rows[0];
}

async function seedSession(accountId: string, level: "full" | "partial" = "full"): Promise<Buffer> {
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
      VALUES (${freshId()}, ${hash}, ${accountId}, ${level}, false, now() + interval '1 hour', now() + interval '1 day')`,
  );
  return hash;
}

async function mailJobs(): Promise<Record<string, unknown>[]> {
  return (await db.owner<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${MAIL_QUEUE} ORDER BY id`).map((row) => row.data);
}

const mailJob = (template: string, accountId: string): QueuedJob => ({ id: freshId(), queue: MAIL_QUEUE, data: { template, accountId } });

interface TokenRow {
  id: string;
  purpose: string;
  token_hash: Buffer;
  target_email: string | null;
  seconds_left: number;
  used_at: Date | null;
}

async function tokensOf(accountId: string): Promise<TokenRow[]> {
  const rows = await asSystem(
    db,
    (tx) =>
      tx<TokenRow[]>`
        SELECT id, purpose, token_hash, target_email::text AS target_email, extract(epoch FROM expires_at - now())::int AS seconds_left, used_at
        FROM credential_tokens WHERE account_id = ${accountId} ORDER BY created_at, id`,
  );
  return [...rows];
}

async function seedToken(accountId: string, purpose: "email_verify" | "password_reset" | "email_change" | "email_change_cancel"): Promise<Buffer> {
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`INSERT INTO credential_tokens (id, purpose, account_id, token_hash, expires_at) VALUES (${freshId()}, ${purpose}, ${accountId}, ${hash}, now() + interval '1 day')`,
  );
  return hash;
}

async function accountRow(accountId: string): Promise<{ verified: boolean; password: boolean; disabled: boolean }> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ verified: boolean; password: boolean; disabled: boolean }[]>`SELECT email_verified_at IS NOT NULL AS verified, password_hash IS NOT NULL AS password, disabled_at IS NOT NULL AS disabled FROM accounts WHERE id = ${accountId}`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is gone");
  }
  return row;
}

/** What a sign-in of the account itself reads: `sys_account_mfa_enabled()` for the account of the transaction. */
async function secondFactorOn(accountId: string): Promise<boolean | undefined> {
  const rows = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    return tx<{ on: boolean }[]>`SELECT public.sys_account_mfa_enabled() AS "on"`;
  });
  return rows[0]?.on;
}

const resetMfa = (actor: string, target: string, jobs: readonly QueuedJob[] = [], eventId = freshId(), ipPrefix: string | null = null) =>
  withTenant(actor, (tx) => instanceRepository(tx).resetMfa(target, eventId, ipPrefix, jobs));

const issueLink = (actor: string, target: string, token: { id: string; hash: Buffer } | undefined, jobs: readonly QueuedJob[] = [], eventId = freshId(), ipPrefix: string | null = null) =>
  withTenant(actor, (tx) => instanceRepository(tx).issueResetLink(target, eventId, token, ipPrefix, jobs));

const requestVerification = (actor: string, target: string, jobs: readonly QueuedJob[] = [], eventId = freshId(), ipPrefix: string | null = null) =>
  withTenant(actor, (tx) => instanceRepository(tx).requestVerification(target, eventId, ipPrefix, jobs));

const markVerified = (actor: string, target: string, change: { disabled?: boolean } = {}, eventIds = { admin: freshId(), disabled: freshId(), verified: freshId() }) =>
  withTenant(actor, (tx) => instanceRepository(tx).updateAccount(target, { ...change, emailVerified: true }, eventIds, null, []));

const newToken = (): { id: string; hash: Buffer } => ({ id: freshId(), hash: freshToken().hash });

const OLD_HASH = "$argon2id$stub";
const NEW_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$bmV3";

interface Footholds {
  readonly session: Buffer;
  readonly apiToken: Buffer;
}

/** What a visitor who registered the address can have set up besides a password and a second factor: a session, an API token, a pending link handshake. */
async function plantFootholds(accountId: string): Promise<Footholds> {
  const workspaceId = freshId();
  const apiToken = freshToken().hash;
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, 'Visitor workspace')`;
    await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceId}, ${accountId}, 'member')`;
    await tx`
      INSERT INTO oidc_login_states (state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id, expires_at)
      VALUES (${freshToken().hash}, 'idp', 'link', 'nonce', ${Buffer.alloc(8, 2)}, 'key-1', '/', ${accountId}, now() + interval '10 minutes')`;
  });
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`
      INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope)
      VALUES (${freshId()}, ${accountId}, ${workspaceId}, 'visitor', ${apiToken}, 'abcdef', 'read')`;
  });
  return { session: await seedSession(accountId), apiToken };
}

async function ownedRows(accountId: string): Promise<{ apiTokens: number; identities: number; pendingLinks: number }> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ api_tokens: number; identities: number; links: number }[]>`
      SELECT (SELECT count(*)::int FROM api_tokens WHERE account_id = ${accountId}) AS api_tokens,
             (SELECT count(*)::int FROM account_identities WHERE account_id = ${accountId}) AS identities,
             (SELECT count(*)::int FROM oidc_login_states WHERE link_account_id = ${accountId}) AS links`,
  );
  return { apiTokens: rows[0]?.api_tokens ?? -1, identities: rows[0]?.identities ?? -1, pendingLinks: rows[0]?.links ?? -1 };
}

/** The provider sign-in of the identity `account()` links, which resolves to no account once the identity is gone. */
const identitySignIn = (accountId: string): Parameters<AuthStore["signInWithIdentity"]>[0] => ({
  provider: "idp",
  subject: `subject-${accountId}`,
  sessionId: freshId(),
  ipPrefix: null,
  userAgent: null,
  tokenHash: freshToken().hash,
  replacedTokenHash: null,
});

describe("the recovery functions repeat the instanceAdmin check in the database", () => {
  const callers: readonly [string, () => Promise<string>][] = [
    ["an account that holds no flag", async () => (await account({ mfa: true })).id],
    ["an instance admin without a second factor", async () => (await account({ admin: true })).id],
    ["a disabled instance admin with a second factor", async () => (await account({ admin: true, mfa: true, disabled: true })).id],
  ];

  it.each(callers)("raises insufficient_privilege for %s and changes, issues, queues and writes nothing", async (_who, make) => {
    const victim = await account({ mfa: true });
    const unverified = await account({ verified: false });
    const session = await seedSession(victim.id);
    const caller = await make();
    const events = await instanceEvents();
    const jobs = [mailJob("mfaReset", victim.id)];

    expect(await refusedWith(resetMfa(caller, victim.id, jobs))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(issueLink(caller, victim.id, newToken(), jobs))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(issueLink(caller, victim.id, undefined, jobs))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(requestVerification(caller, unverified.id, jobs))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(markVerified(caller, unverified.id))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await mfaState(victim.id)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
    expect((await mfaState(victim.id))?.mfa_enabled_at).not.toBeNull();
    expect(await store.lookupSession(session)).toBeDefined();
    expect(await tokensOf(victim.id)).toEqual([]);
    expect((await accountRow(unverified.id)).verified).toBe(false);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it("raises insufficient_privilege when the transaction acts for no account", async () => {
    const victim = await account({ mfa: true });
    const events = await instanceEvents();
    const asNobody = (work: (tx: import("postgres").TransactionSql) => Promise<unknown>): Promise<unknown> => db.app.begin((tx) => work(tx));

    expect(await refusedWith(asNobody((tx) => tx`SELECT sys_instance_reset_mfa(${freshId()}::uuid, NULL::cidr, ${victim.id}::uuid)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(asNobody((tx) => tx`SELECT sys_instance_issue_reset_link(${freshId()}::uuid, NULL::cidr, ${victim.id}::uuid, NULL::uuid, NULL::bytea)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(asNobody((tx) => tx`SELECT sys_instance_resend_verification(${freshId()}::uuid, NULL::cidr, ${victim.id}::uuid)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(asNobody((tx) => tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${victim.id}::uuid, NULL::boolean, NULL::boolean, true)`))).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await mfaState(victim.id)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
    expect(await instanceEvents()).toEqual(events);
  });

  it("refuses a missing event id, a token without its hash, a short hash and a false mark as invalid parameters, writing nothing", async () => {
    const caller = await admin();
    const target = await account({ verified: false });
    const events = await instanceEvents();
    const asApp = (work: (tx: import("postgres").TransactionSql) => Promise<unknown>): Promise<unknown> =>
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${caller}, true)`;
        return work(tx);
      });

    expect(await refusedWith(asApp((tx) => tx`SELECT sys_instance_reset_mfa(NULL::uuid, NULL::cidr, ${target.id}::uuid)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT sys_instance_reset_mfa(${freshId()}::uuid, NULL::cidr, NULL::uuid)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT sys_instance_issue_reset_link(${freshId()}::uuid, NULL::cidr, ${target.id}::uuid, ${freshId()}::uuid, NULL::bytea)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT sys_instance_issue_reset_link(${freshId()}::uuid, NULL::cidr, ${target.id}::uuid, NULL::uuid, ${Buffer.from("short")}::bytea)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT sys_instance_resend_verification(NULL::uuid, NULL::cidr, ${target.id}::uuid)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT * FROM sys_instance_update_account(NULL::uuid, ${freshId()}::uuid, NULL::uuid, NULL::cidr, ${target.id}::uuid, NULL::boolean, NULL::boolean, true)`))).toBe(INVALID_PARAMETER);
    expect(await refusedWith(asApp((tx) => tx`SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${target.id}::uuid, NULL::boolean, NULL::boolean, false)`))).toBe(INVALID_PARAMETER);

    expect((await accountRow(target.id)).verified).toBe(false);
    expect(await instanceEvents()).toEqual(events);
  });
});

describe("sys_instance_reset_mfa", () => {
  it("clears the secret, the activation and the backup codes, deletes every session of the account and writes one event for it, in the same call", async () => {
    const caller = await admin();
    const target = await account({ mfa: true });
    const full = await seedSession(target.id, "full");
    const partial = await seedSession(target.id, "partial");
    const bystander = await account({ mfa: true });
    const bystanderSession = await seedSession(bystander.id);
    const eventId = freshId();
    const before = (await instanceEvents()).length;

    const outcome = await resetMfa(caller, target.id, [mailJob("mfaReset", target.id)], eventId, "203.0.0.0/16");

    expect(outcome).toBe("reset");
    expect(await mfaState(target.id)).toEqual({ mfa_secret: null, mfa_secret_key_id: null, mfa_enabled_at: null, mfa_last_step: null, codes: 0 });
    expect(await sessionRows(db, target.id)).toEqual([]);
    expect(await store.lookupSession(full)).toBeUndefined();
    expect(await store.lookupSession(partial)).toBeUndefined();
    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual({ id: eventId, actor_account_id: caller, action: "instance.account_mfa_reset", entity_type: "account", entity_id: target.id, metadata: {}, ip_prefix: "203.0.0.0/16" });
    expect(await mailJobs()).toEqual([{ template: "mfaReset", accountId: target.id }]);
    // Nobody else's second factor or session is touched.
    expect(await mfaState(bystander.id)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
    expect(await store.lookupSession(bystanderSession)).toBeDefined();
  });

  it("never copies the secret: the event and the queued job hold no byte of it, and the account no longer has a secret to read", async () => {
    const caller = await admin();
    const target = await account({ mfa: true });
    await resetMfa(caller, target.id, [mailJob("mfaReset", target.id)]);

    const stored = JSON.stringify([await instanceEvents(), await mailJobs()]);
    expect(stored).not.toContain(SECRET.toString("utf8"));
    expect(stored).not.toContain(SECRET.toString("base64"));
    expect(stored).not.toContain(SECRET.toString("hex"));
    const secrets = await asSystem(db, (tx) => tx`SELECT * FROM sys_mfa_get_secret(${target.id}::uuid)`);
    expect(secrets).toHaveLength(0);
  });

  it("leaves the account able to sign in with its password alone only because the second factor is off: the sign-in reads it as off", async () => {
    const caller = await admin();
    const target = await account({ mfa: true });
    expect(await secondFactorOn(target.id)).toBe(true);

    await resetMfa(caller, target.id);

    expect(await secondFactorOn(target.id)).toBe(false);
  });

  it("answers mfa_not_enabled for an account with no confirmed second factor and for a second request, writing, deleting and queueing nothing", async () => {
    const caller = await admin();
    const plain = await account();
    const target = await account({ mfa: true });
    const plainSession = await seedSession(plain.id);
    const pending = await account();
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${pending.id}, true)`;
      await tx`UPDATE accounts SET mfa_secret = ${SECRET}, mfa_secret_key_id = 'key-1' WHERE id = ${pending.id}`;
    });
    expect(await resetMfa(caller, target.id, [mailJob("mfaReset", target.id)])).toBe("reset");
    const events = await instanceEvents();
    const jobs = await mailJobs();

    expect(await resetMfa(caller, target.id, [mailJob("mfaReset", target.id)])).toBe("mfa_not_enabled");
    expect(await resetMfa(caller, plain.id, [mailJob("mfaReset", plain.id)])).toBe("mfa_not_enabled");
    expect(await resetMfa(caller, pending.id, [mailJob("mfaReset", pending.id)])).toBe("mfa_not_enabled");

    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual(jobs);
    expect(await store.lookupSession(plainSession)).toBeDefined();
    expect((await mfaState(pending.id))?.mfa_secret).toEqual(SECRET);
  });

  it("refuses a disabled account, the calling admin's own account and an unknown account, changing and writing nothing", async () => {
    const caller = await admin();
    const disabled = await account({ mfa: true, disabled: true });
    const events = await instanceEvents();
    const callerSession = await seedSession(caller);

    expect(await resetMfa(caller, disabled.id, [mailJob("mfaReset", disabled.id)])).toBe("account_disabled");
    expect(await resetMfa(caller, caller, [mailJob("mfaReset", caller)])).toBe("self");
    expect(await resetMfa(caller, freshId(), [])).toBe("unknown_account");

    expect(await mfaState(disabled.id)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
    expect(await mfaState(caller)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
    expect(await store.lookupSession(callerSession)).toBeDefined();
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });
});

/** How many backends of this database wait for a lock. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilWaiting(backends: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) < backends) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function settle<T>(work: Promise<T>): Promise<{ readonly value: T } | { readonly error: unknown }> {
  return work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("resets that race", () => {
  it(
    "two admins who reset one account at once tell it once: the second waits for the first and finds the second factor already off",
    async () => {
      const first = await admin();
      const second = await admin();
      const target = await account({ mfa: true });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const firstDone = new Promise<void>((resolve) => {
        held = resolve;
      });
      const firstReset = settle(
        withTenant(first, async (tx) => {
          const result = await instanceRepository(tx).resetMfa(target.id, freshId(), null, [mailJob("mfaReset", target.id)]);
          held();
          await released;
          return result;
        }),
      );
      await firstDone;
      let secondReset: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      try {
        secondReset = settle(resetMfa(second, target.id, [mailJob("mfaReset", target.id)]));
        await waitUntilWaiting(1, "the second reset");
      } finally {
        release();
      }

      expect(await Promise.all([firstReset, secondReset])).toEqual([{ value: "reset" }, { value: "mfa_not_enabled" }]);
      expect((await instanceEvents()).filter((event) => event.action === "instance.account_mfa_reset" && event.entity_id === target.id)).toHaveLength(1);
      expect(await mailJobs()).toEqual([{ template: "mfaReset", accountId: target.id }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a reset that waits for the account's rows is refused as a caller when the admin lost the flag meanwhile, and leaves the second factor on",
    async () => {
      const keeper = await admin();
      const demoted = await admin();
      const target = await account({ mfa: true });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      // The keeper's demotion of the other admin holds both admins' rows until it commits.
      const demotion = settle(
        withTenant(keeper, async (tx) => {
          const result = await instanceRepository(tx).updateAccount(demoted, { isInstanceAdmin: false }, { admin: freshId(), disabled: freshId(), verified: freshId() }, null, []);
          held();
          await released;
          return result;
        }),
      );
      await holding;
      let reset: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      try {
        reset = settle(resetMfa(demoted, target.id, [mailJob("mfaReset", target.id)]));
        await waitUntilWaiting(1, "the reset");
      } finally {
        release();
      }

      const [, outcome] = await Promise.all([demotion, reset]);

      expect(outcome).toHaveProperty("error");
      expect(errorCode((outcome as { error: unknown }).error)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await mfaState(target.id)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
      expect(await mailJobs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a reset waits for a sign-in with a backup code, which holds the code rows first, and takes the factor away after it",
    async () => {
      const caller = await admin();
      const target = await account({ mfa: true });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const signIn = settle(
        db.owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`SELECT 1 FROM mfa_backup_codes WHERE account_id = ${target.id} ORDER BY id FOR UPDATE`;
          held();
          await released;
        }),
      );
      await holding;
      let reset: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      try {
        reset = settle(resetMfa(caller, target.id));
        await waitUntilWaiting(1, "the reset");
        expect((await mfaState(target.id))?.mfa_enabled_at).not.toBeNull();
      } finally {
        release();
      }

      expect(await Promise.all([signIn, reset])).toEqual([{ value: undefined }, { value: "reset" }]);
      expect(await mfaState(target.id)).toMatchObject({ mfa_secret: null, codes: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  // The owner redeems the verification link of an address a registrant enrolled a second factor on, while an admin acts on
  // the same account. Both take the account's backup-code rows and its account row; a redemption that locked the account row
  // first would wait for the codes the admin holds while the admin waits for the account row, and the database would abort
  // one of the two with a deadlock error. A sign-in with a backup code holds the code rows first, so the test holds them
  // until both calls are queued behind it.
  const concurrentWithRedemption = [
    {
      name: "marks the address verified",
      act: markVerified,
      // The mark deletes the verification token, so the redemption that queued behind it finds none and answers no row.
      redeemed: 0,
      afterwards: { verified: true, password: false },
    },
    {
      name: "resets the second factor",
      act: resetMfa,
      // The reset leaves the unverified address and its token alone, so the redemption verifies and signs in.
      redeemed: 1,
      afterwards: { verified: true, password: true },
    },
  ] as const;

  it.each(concurrentWithRedemption)(
    "a redemption of the verification link and an admin who $name at once both complete, one after the other",
    async ({ act, redeemed, afterwards }) => {
      const caller = await admin();
      const target = await account({ verified: false, mfa: true });
      const tokenHash = await seedToken(target.id, "email_verify");
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const signIn = settle(
        db.owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`SELECT 1 FROM mfa_backup_codes WHERE account_id = ${target.id} ORDER BY id FOR UPDATE`;
          held();
          await released;
        }),
      );
      await holding;
      let adminCall: Promise<{ readonly value: unknown } | { readonly error: unknown }>;
      let redemption: Promise<{ readonly value: readonly unknown[] } | { readonly error: unknown }>;
      try {
        adminCall = settle<unknown>(act(caller, target.id));
        await waitUntilWaiting(1, "the admin's call");
        redemption = settle(
          db.app
            .unsafe("SELECT * FROM public.sys_email_verify($1::bytea, $2::text, $3::uuid, $4::bytea, NULL::cidr, NULL::text, NULL::bytea)", [tokenHash, NEW_HASH, freshId(), freshToken().hash])
            .then((rows) => [...rows]),
        );
        await waitUntilWaiting(2, "the redemption");
      } finally {
        release();
      }

      const [, adminOutcome, redemptionOutcome] = await Promise.all([signIn, adminCall, redemption]);

      expect(adminOutcome).not.toHaveProperty("error");
      expect(redemptionOutcome).not.toHaveProperty("error");
      expect((redemptionOutcome as { value: readonly unknown[] }).value).toHaveLength(redeemed);
      expect(await accountRow(target.id)).toEqual({ ...afterwards, disabled: false });
      expect(await mfaState(target.id)).toMatchObject({ mfa_secret: null, codes: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("sys_instance_issue_reset_link", () => {
  it("with a token stores its hash for one hour, ends the earlier unused reset token, writes the event naming the delivery link and queues nothing", async () => {
    const caller = await admin();
    const target = await account();
    const earlier = await seedToken(target.id, "password_reset");
    const verifyToken = await seedToken(target.id, "email_verify");
    const token = newToken();
    const eventId = freshId();

    const outcome = await issueLink(caller, target.id, token, [], eventId, "203.0.0.0/16");

    expect(outcome).toBe("issued");
    const tokens = await tokensOf(target.id);
    expect(tokens.map((row) => row.purpose).sort()).toEqual(["email_verify", "password_reset"]);
    const reset = tokens.find((row) => row.purpose === "password_reset");
    expect(reset).toMatchObject({ id: token.id, target_email: null, used_at: null });
    expect(reset?.token_hash.equals(token.hash)).toBe(true);
    expect(reset?.token_hash.equals(earlier)).toBe(false);
    expect(reset?.seconds_left).toBeGreaterThan(3590);
    expect(reset?.seconds_left).toBeLessThanOrEqual(3600);
    expect(tokens.find((row) => row.purpose === "email_verify")?.token_hash.equals(verifyToken)).toBe(true);
    const event = (await instanceEvents()).at(-1);
    expect(event).toEqual({ id: eventId, actor_account_id: caller, action: "instance.account_reset_link_issued", entity_type: "account", entity_id: target.id, metadata: { delivery: "link" }, ip_prefix: "203.0.0.0/16" });
    expect(JSON.stringify(await instanceEvents())).not.toContain(token.hash.toString("hex"));
    expect(await mailJobs()).toEqual([]);
  });

  it("without a token stores nothing, leaves the earlier token for the mail job to replace, writes the event naming the delivery mail and queues the email", async () => {
    const caller = await admin();
    const target = await account();
    const earlier = await seedToken(target.id, "password_reset");

    const outcome = await issueLink(caller, target.id, undefined, [mailJob("passwordReset", target.id)]);

    expect(outcome).toBe("issued");
    const tokens = await tokensOf(target.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token_hash.equals(earlier)).toBe(true);
    expect((await instanceEvents()).at(-1)).toMatchObject({ action: "instance.account_reset_link_issued", entity_id: target.id, metadata: { delivery: "mail" } });
    expect(await mailJobs()).toEqual([{ template: "passwordReset", accountId: target.id }]);
  });

  it.each([
    ["a disabled account", { disabled: true }, "account_disabled"],
    ["an account whose address was never verified", { verified: false }, "email_unverified"],
    ["an account that signs in through a provider only", { password: false, identity: true }, "no_password"],
  ] as const)("refuses %s as %s, issuing, replacing, writing and queueing nothing, with or without a token", async (_what, options, refusal) => {
    const caller = await admin();
    const target = await account(options);
    const earlier = await seedToken(target.id, "password_reset");
    const events = await instanceEvents();

    expect(await issueLink(caller, target.id, newToken(), [mailJob("passwordReset", target.id)])).toBe(refusal);
    expect(await issueLink(caller, target.id, undefined, [mailJob("passwordReset", target.id)])).toBe(refusal);

    const tokens = await tokensOf(target.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token_hash.equals(earlier)).toBe(true);
    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });

  it("hands the link over, and does not promise a mail, for an account with no password and no linked provider identity", async () => {
    const caller = await admin();
    const target = await account({ password: false });
    const events = await instanceEvents();

    expect(await issueLink(caller, target.id, undefined, [mailJob("passwordReset", target.id)])).toBe("link_required");
    expect(await instanceEvents()).toEqual(events);
    expect(await tokensOf(target.id)).toEqual([]);
    expect(await mailJobs()).toEqual([]);

    expect(await issueLink(caller, target.id, newToken())).toBe("issued");
    expect(await tokensOf(target.id)).toHaveLength(1);
    expect((await instanceEvents()).at(-1)).toMatchObject({ action: "instance.account_reset_link_issued", entity_id: target.id, metadata: { delivery: "link" } });
    expect(await mailJobs()).toEqual([]);
  });

  it("answers unknown_account for an account that does not exist", async () => {
    const caller = await admin();
    const events = await instanceEvents();
    expect(await issueLink(caller, freshId(), newToken())).toBe("unknown_account");
    expect(await instanceEvents()).toEqual(events);
  });

  it("issues a link the redemption accepts: the token it stores is the one sys_password_reset consumes", async () => {
    const caller = await admin();
    const target = await account();
    const { token, hash } = freshToken();
    await issueLink(caller, target.id, { id: freshId(), hash });
    const session = freshToken();

    const redeemed = await asSystem(
      db,
      (tx) => tx<{ reset_account_id: string; session_level: string }[]>`SELECT * FROM sys_password_reset(${hash}, ${"$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$bmV3"}, ${freshId()}, ${session.hash}, NULL, NULL, NULL)`,
    );

    expect(token).toBeDefined();
    expect(redeemed).toEqual([{ reset_account_id: target.id, session_level: "full" }]);
  });
});

describe("sys_instance_resend_verification", () => {
  it("writes the event for an enabled account with an unverified address and queues the email in the same transaction", async () => {
    const caller = await admin();
    const target = await account({ verified: false });
    const eventId = freshId();

    const outcome = await requestVerification(caller, target.id, [mailJob("verifyEmail", target.id)], eventId, "203.0.0.0/16");

    expect(outcome).toBe("requested");
    expect((await instanceEvents()).at(-1)).toEqual({ id: eventId, actor_account_id: caller, action: "instance.account_verification_resent", entity_type: "account", entity_id: target.id, metadata: {}, ip_prefix: "203.0.0.0/16" });
    expect(await mailJobs()).toEqual([{ template: "verifyEmail", accountId: target.id }]);
    expect(await tokensOf(target.id)).toEqual([]);
  });

  it.each([
    ["a verified address", { verified: true }, "already_verified"],
    ["a disabled account", { verified: false, disabled: true }, "account_disabled"],
  ] as const)("refuses %s as %s, writing and queueing nothing", async (_what, options, refusal) => {
    const caller = await admin();
    const target = await account(options);
    const events = await instanceEvents();

    expect(await requestVerification(caller, target.id, [mailJob("verifyEmail", target.id)])).toBe(refusal);
    expect(await requestVerification(caller, freshId())).toBe("unknown_account");

    expect(await instanceEvents()).toEqual(events);
    expect(await mailJobs()).toEqual([]);
  });
});

describe("sys_instance_update_account, marking an address verified", () => {
  it("takes away what the registrant set up, as redeeming the verification link does, and writes the event for it", async () => {
    const caller = await admin();
    const target = await account({ verified: false, mfa: true, identity: true });
    const footholds = await plantFootholds(target.id);
    await seedToken(target.id, "email_verify");
    await seedToken(target.id, "password_reset");
    const eventIds = { admin: freshId(), disabled: freshId(), verified: freshId() };
    const before = (await instanceEvents()).length;
    expect(await store.lookupSession(footholds.session)).toBeDefined();
    expect(await store.lookupApiToken(footholds.apiToken, null)).toBeDefined();
    expect((await store.loginLookup(target.email))?.passwordHash).toBe(OLD_HASH);

    const outcome = await markVerified(caller, target.id, {}, eventIds);

    expect(outcome).toMatchObject({ kind: "updated", adminChanged: false, disabledChanged: false, verifiedChanged: true, account: { id: target.id, emailVerified: true, mfaEnabled: false } });
    expect(await accountRow(target.id)).toEqual({ verified: true, password: false, disabled: false });
    expect((await store.loginLookup(target.email))?.passwordHash).toBeNull();
    expect(await store.lookupSession(footholds.session)).toBeUndefined();
    expect(await sessionRows(db, target.id)).toEqual([]);
    expect(await store.lookupApiToken(footholds.apiToken, null)).toBeUndefined();
    expect(await mfaState(target.id)).toEqual({ mfa_secret: null, mfa_secret_key_id: null, mfa_enabled_at: null, mfa_last_step: null, codes: 0 });
    expect(await ownedRows(target.id)).toEqual({ apiTokens: 0, identities: 0, pendingLinks: 0 });
    expect(await tokensOf(target.id)).toEqual([]);
    expect(await store.signInWithIdentity(identitySignIn(target.id))).toBe("refused");
    const events = await instanceEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ id: eventIds.verified, actor_account_id: caller, action: "instance.account_email_verified", entity_type: "account", entity_id: target.id, metadata: {} });
  });

  it("clears the pending change of email of the account together with its unused tokens", async () => {
    const caller = await admin();
    const target = await account({ verified: false });
    await asSystem(db, (tx) => tx`UPDATE accounts SET pending_email = 'registrant-pending@example.test' WHERE id = ${target.id}`);
    await seedToken(target.id, "email_change");
    await seedToken(target.id, "email_change_cancel");

    await markVerified(caller, target.id);

    const rows = await asSystem(db, (tx) => tx<{ pending: string | null }[]>`SELECT pending_email::text AS pending FROM accounts WHERE id = ${target.id}`);
    expect(rows[0]?.pending).toBeNull();
    expect(await tokensOf(target.id)).toEqual([]);
  });

  it("leaves the owner a way in: a reset link issued afterwards sets a password and signs in, and the old one does not work", async () => {
    const caller = await admin();
    const target = await account({ verified: false, mfa: true });
    await markVerified(caller, target.id);
    const { token, hash } = freshToken();
    expect(await issueLink(caller, target.id, { id: freshId(), hash })).toBe("issued");
    expect(token).toBeDefined();
    const reset: PasswordReset = { tokenHash: hash, passwordHash: NEW_HASH, sessionId: freshId(), sessionTokenHash: freshToken().hash, ipPrefix: null, userAgent: null, replacedTokenHash: null };

    expect(await store.resetPassword(reset)).toEqual({ accountId: target.id, next: "done" });

    expect((await store.loginLookup(target.email))?.passwordHash).toBe(NEW_HASH);
    expect(await store.lookupSession(reset.sessionTokenHash)).toMatchObject({ accountId: target.id, level: "full" });
    expect(await store.resetPassword({ ...reset, sessionId: freshId(), sessionTokenHash: freshToken().hash })).toBeUndefined();
  });

  it("does not take the calling admin's own second factor and session when the admin marks their own address", async () => {
    const caller = await account({ admin: true, mfa: true, verified: false });
    const session = await seedSession(caller.id);

    const outcome = await markVerified(caller.id, caller.id);

    expect(outcome).toMatchObject({ kind: "updated", verifiedChanged: true, account: { id: caller.id, emailVerified: true, mfaEnabled: true } });
    expect(await mfaState(caller.id)).toMatchObject({ mfa_secret: SECRET, codes: 2 });
    expect(await store.lookupSession(session)).toBeDefined();
    expect(await accountRow(caller.id)).toEqual({ verified: true, password: true, disabled: false });
  });

  it("gives slugbase_app no call of the clean-up itself: it is reached only through the functions that vouch for the caller", async () => {
    const target = await account({ verified: false });
    expect(await refusedWith(db.app`SELECT public.account_mark_verified(${target.id}::uuid, NULL::text)`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await accountRow(target.id)).verified).toBe(false);
  });

  it("changes nothing and writes no event for an address that is verified already, and keeps its tokens", async () => {
    const caller = await admin();
    const target = await account({ verified: true });
    const verifyToken = await seedToken(target.id, "email_verify");
    const events = await instanceEvents();

    const outcome = await markVerified(caller, target.id);

    expect(outcome).toMatchObject({ kind: "updated", verifiedChanged: false, account: { emailVerified: true } });
    expect(await instanceEvents()).toEqual(events);
    expect((await tokensOf(target.id))[0]?.token_hash.equals(verifyToken)).toBe(true);
  });

  it("marks a disabled account's address and keeps it disabled: the mark opens no door", async () => {
    const caller = await admin();
    const target = await account({ verified: false, disabled: true });

    const outcome = await markVerified(caller, target.id);

    expect(outcome).toMatchObject({ kind: "updated", verifiedChanged: true, disabledChanged: false, account: { emailVerified: true, disabled: true } });
    expect(await accountRow(target.id)).toEqual({ verified: true, password: false, disabled: true });
  });

  it("applies the mark together with enabling the account, one event for each, the later one last", async () => {
    const caller = await admin();
    const target = await account({ verified: false, disabled: true });
    const eventIds = { admin: freshId(), disabled: freshId(), verified: freshId() };

    const outcome = await markVerified(caller, target.id, { disabled: false }, eventIds);

    expect(outcome).toMatchObject({ kind: "updated", adminChanged: false, disabledChanged: true, verifiedChanged: true });
    expect((await instanceEvents()).slice(-2).map((event) => [event.id, event.action])).toEqual([
      [eventIds.disabled, "instance.account_enabled"],
      [eventIds.verified, "instance.account_email_verified"],
    ]);
  });

  it("answers unknown_account for an account that does not exist, writing nothing", async () => {
    const caller = await admin();
    const events = await instanceEvents();
    expect(await markVerified(caller, freshId())).toEqual({ kind: "unknown_account" });
    expect(await instanceEvents()).toEqual(events);
  });

  it("keeps the six-argument form for a replica of the previous release, which answers as the eight-argument function does without the mark", async () => {
    const caller = await admin();
    const target = await account({ verified: false });
    const eventId = freshId();

    const rows = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${caller}, true)`;
      return tx<{ outcome: string; admin_changed: boolean; disabled_changed: boolean; acct_disabled: boolean }[]>`
        SELECT * FROM sys_instance_update_account(${freshId()}::uuid, ${eventId}::uuid, NULL::cidr, ${target.id}::uuid, NULL::boolean, true)`;
    });

    expect(rows).toMatchObject([{ outcome: "updated", admin_changed: false, disabled_changed: true, acct_disabled: true }]);
    expect((await instanceEvents()).at(-1)).toMatchObject({ id: eventId, action: "instance.account_disabled" });
  });
});
