import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type EmailVerification, type NewRegistration, type QueuedJob } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";

// Verifying a registered address and the personal workspace (doc 05 section 3.3, doc 02 sections 2.2 and
// 2.6, doc 10 T4 and T8). The failure scenarios: a verification token that works twice, after its expiry,
// for another purpose or for another account; a replay that creates a second workspace; an account a
// visitor registered that keeps the visitor's password or sessions once the owner has verified it; a
// verification that commits without the workspace it was to create, or the other way round.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;
const DAY_SECONDS = 86_400;
const SUFFIX = "'s workspace";
const QUEUE = "event.workspace.created";
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
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);
    INSERT INTO pgboss.queue VALUES ('${MAIL_QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  await db.owner`TRUNCATE accounts CASCADE`;
  await db.owner`TRUNCATE workspaces CASCADE`;
});

let emailNumber = 0;

interface Options {
  readonly verified?: boolean;
  readonly disabled?: boolean;
  readonly mfa?: boolean;
  readonly displayName?: string;
}

/** An account as a visitor registered it: a password, no verified address, and by default no second factor. */
async function account(options: Options = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `verify${String(emailNumber)}@example.test`, passwordHash: OLD_HASH, disabledAt: options.disabled === true ? new Date() : null });
  await asSystem(
    db,
    (tx) => tx`
      UPDATE accounts SET
        display_name = ${options.displayName ?? "Ada"},
        email_verified_at = ${options.verified === true ? new Date() : null},
        mfa_secret = ${options.mfa === true ? Buffer.from("sealed") : null},
        mfa_secret_key_id = ${options.mfa === true ? "key-1" : null},
        mfa_enabled_at = ${options.mfa === true ? new Date() : null}
      WHERE id = ${id}`,
  );
  return id;
}

async function session(accountId: string): Promise<string> {
  const { hash } = freshToken();
  const id = freshId();
  expect((await db.app`SELECT sys_session_create(${id}::uuid, ${accountId}::uuid, 'full', false, NULL, NULL, ${hash}::bytea, NULL) AS created`)[0]?.["created"]).toBe(true);
  return id;
}

async function issue(accountId: string, overrides: { purpose?: string; ttl?: number } = {}): Promise<Buffer> {
  const { hash } = freshToken();
  const result = await db.app`
    SELECT sys_credential_token_issue(${freshId()}::uuid, ${overrides.purpose ?? "email_verify"}::text, ${accountId}::uuid, ${hash}::bytea, NULL::text, ${overrides.ttl ?? DAY_SECONDS}::integer) AS issued`;
  expect(result[0]?.["issued"]).toBe(true);
  return hash;
}

function workspaceCreated(accountId: string, workspaceId: string): QueuedJob {
  return { id: freshId(), queue: QUEUE, data: { eventId: freshId(), workspaceId, accountId } };
}

/** A verification whose `afterVerified` provisions the personal workspace, as the application's does. */
function verification(tokenHash: Buffer, overrides: Partial<EmailVerification> = {}): EmailVerification {
  return {
    tokenHash,
    passwordHash: NEW_HASH,
    sessionId: freshId(),
    sessionTokenHash: freshToken().hash,
    ipPrefix: null,
    userAgent: null,
    replacedTokenHash: null,
    afterVerified: async (accountId, workspaces) => {
      const workspaceId = freshId();
      await workspaces.create({ accountId, workspaceId, nameSuffix: SUFFIX, jobs: [workspaceCreated(accountId, workspaceId)] });
    },
    ...overrides,
  };
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

interface WorkspaceRow {
  id: string;
  name: string;
  created_by: string;
  role: string;
}

async function workspacesOf(accountId: string): Promise<WorkspaceRow[]> {
  return [
    ...(await asSystem(
      db,
      (tx) => tx<WorkspaceRow[]>`
        SELECT w.id, w.name, w.created_by, m.role::text AS role
        FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.account_id = ${accountId} ORDER BY w.created_at, w.id`,
    )),
  ];
}

async function tokenRows(accountId: string): Promise<{ used: boolean }[]> {
  return [...(await asSystem(db, (tx) => tx<{ used: boolean }[]>`SELECT used_at IS NOT NULL AS used FROM credential_tokens WHERE account_id = ${accountId} ORDER BY created_at`))];
}

interface Footholds {
  readonly mfa: boolean;
  readonly backupCodes: number;
  readonly apiTokens: number;
  readonly identities: number;
  readonly pendingLinks: number;
}

/** What a visitor who registered the address can have set up: a second factor with a recovery code, an API token, a linked identity and a pending link handshake. */
async function plantFootholds(accountId: string, options: { readonly pendingEnrolment?: boolean } = {}): Promise<void> {
  const workspaceId = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      UPDATE accounts SET mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1', mfa_enabled_at = ${options.pendingEnrolment === true ? null : new Date()}
      WHERE id = ${accountId}`;
    await tx`INSERT INTO mfa_backup_codes (id, account_id, code_hash) VALUES (${freshId()}, ${accountId}, ${Buffer.alloc(8, 1)})`;
    await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${freshId()}, ${accountId}, 'idp', ${`subject-${accountId}`}, 'visitor@example.test')`;
    await tx`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, 'Visitor workspace')`;
    await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceId}, ${accountId}, 'member')`;
    await tx`
      INSERT INTO oidc_login_states (state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, link_account_id, expires_at)
      VALUES (${freshToken().hash}, 'idp', 'link', 'nonce', ${Buffer.alloc(8, 2)}, 'key-1', '/', ${accountId}, now() + interval '10 minutes')`;
  });
  // The table is closed to slugbase_system for inserts; the owner writes the row under the account's own policy, as a token is created.
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`
      INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope)
      VALUES (${freshId()}, ${accountId}, ${workspaceId}, 'visitor', ${freshToken().hash}, 'abcdef', 'read')`;
  });
}

async function footholds(accountId: string): Promise<Footholds> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ mfa: boolean; codes: number; tokens: number; identities: number; links: number }[]>`
      SELECT (a.mfa_secret IS NOT NULL OR a.mfa_secret_key_id IS NOT NULL OR a.mfa_enabled_at IS NOT NULL OR a.mfa_last_step IS NOT NULL) AS mfa,
             (SELECT count(*)::int FROM mfa_backup_codes WHERE account_id = a.id) AS codes,
             (SELECT count(*)::int FROM api_tokens WHERE account_id = a.id) AS tokens,
             (SELECT count(*)::int FROM account_identities WHERE account_id = a.id) AS identities,
             (SELECT count(*)::int FROM oidc_login_states WHERE link_account_id = a.id) AS links
      FROM accounts a WHERE a.id = ${accountId}`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the account is missing");
  }
  return { mfa: row.mfa, backupCodes: row.codes, apiTokens: row.tokens, identities: row.identities, pendingLinks: row.links };
}

const NONE: Footholds = { mfa: false, backupCodes: 0, apiTokens: 0, identities: 0, pendingLinks: 0 };
const ALL: Footholds = { mfa: true, backupCodes: 1, apiTokens: 1, identities: 1, pendingLinks: 1 };

async function queued(): Promise<{ name: string; data: Record<string, unknown> }[]> {
  return [...(await db.app<{ name: string; data: Record<string, unknown> }[]>`SELECT name, data FROM pgboss.job ORDER BY id`)];
}

describe("the system operations", () => {
  it("are registered", () => {
    expect(systemOperations).toContain("sys_email_verify");
    expect(systemOperations).toContain("sys_create_personal_workspace");
    expect(systemOperations).toContain("sys_account_email_verified");
  });
});

describe("verifyEmail", () => {
  it("verifies an account, replaces the password a visitor registered it with, deletes every session it had and signs it in", async () => {
    const owner = await account();
    const before = [await session(owner), await session(owner)];
    const token = await issue(owner);
    const sessionTokenHash = freshToken().hash;
    const input = verification(token, { sessionTokenHash });

    expect(await store.verifyEmail(input)).toEqual({ accountId: owner, next: "done" });

    expect(await accountRow(owner)).toEqual({ password_hash: NEW_HASH, verified: true, password_changed: true });
    const sessions = await sessionRows(db, owner);
    expect(sessions.map((row) => row.id)).toEqual([input.sessionId]);
    expect(sessions[0]).toMatchObject({ level: "full", token_hash: sessionTokenHash });
    expect(before).not.toContain(input.sessionId);
    expect(await store.lookupSession(sessionTokenHash)).toMatchObject({ accountId: owner, level: "full" });
  });

  it("creates the personal workspace named after the display name, with the account as owner, and queues the event in the same transaction", async () => {
    const owner = await account({ displayName: "Ada Lovelace" });

    await store.verifyEmail(verification(await issue(owner)));

    const [workspace, ...rest] = await workspacesOf(owner);
    expect(rest).toEqual([]);
    expect(workspace).toMatchObject({ name: "Ada Lovelace's workspace", created_by: owner, role: "owner" });
    const events = await queued();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe(QUEUE);
    expect(events[0]?.data).toMatchObject({ workspaceId: workspace?.id, accountId: owner });
  });

  it("answers nothing for the same token the second time, and a replay changes no password, no session and no workspace", async () => {
    const owner = await account();
    const token = await issue(owner);
    expect(await store.verifyEmail(verification(token))).toBeDefined();
    const accountAfter = await accountRow(owner);
    const sessionsAfter = await sessionRows(db, owner);
    const workspacesAfter = await workspacesOf(owner);
    const eventsAfter = await queued();

    const replay = verification(token, { passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$bWFsbG9yeQ" });
    expect(await store.verifyEmail(replay)).toBeUndefined();

    expect(await accountRow(owner)).toEqual(accountAfter);
    expect(await sessionRows(db, owner)).toEqual(sessionsAfter);
    expect(await workspacesOf(owner)).toEqual(workspacesAfter);
    expect(await queued()).toEqual(eventsAfter);
    expect(workspacesAfter).toHaveLength(1);
  });

  it("lets exactly one of several simultaneous redemptions of one token through, and leaves one workspace", async () => {
    const owner = await account();
    const token = await issue(owner);

    const answers = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.verifyEmail(verification(token))));

    expect(answers.filter((answer) => answer !== undefined)).toHaveLength(1);
    expect(await workspacesOf(owner)).toHaveLength(1);
    expect(await sessionRows(db, owner)).toHaveLength(1);
  });

  it("refuses a token after 24 hours, an unknown token and a token of another purpose, all alike, changing nothing", async () => {
    const owner = await account();
    const expired = await issue(owner, { ttl: 1 });
    await asSystem(db, (tx) => tx`UPDATE credential_tokens SET expires_at = now() - interval '1 second'`);
    const other = await issue(owner, { purpose: "password_reset" });
    const stale = await account();
    const staleToken = await issue(stale);
    await asSystem(db, (tx) => tx`UPDATE credential_tokens SET expires_at = now() - (interval '24 hours' + interval '1 second') WHERE account_id = ${stale}`);

    for (const hash of [expired, other, staleToken, freshToken().hash]) {
      expect(await store.verifyEmail(verification(hash))).toBeUndefined();
    }

    for (const id of [owner, stale]) {
      expect(await accountRow(id)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
      expect(await workspacesOf(id)).toEqual([]);
      expect(await sessionRows(db, id)).toEqual([]);
    }
  });

  it("verifies only the account the token was issued to", async () => {
    const owner = await account();
    const bystander = await account();
    const bystanderSession = await session(bystander);
    const token = await issue(owner);

    expect(await store.verifyEmail(verification(token))).toMatchObject({ accountId: owner });

    expect(await accountRow(bystander)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect((await sessionRows(db, bystander)).map((row) => row.id)).toEqual([bystanderSession]);
    expect(await workspacesOf(bystander)).toEqual([]);
  });

  it("keeps the password and the sessions of an account that is already verified, and gives it no second workspace", async () => {
    const owner = await account({ verified: true });
    const kept = await session(owner);
    await store.verifyEmail(verification(await issue(owner)));
    const sessionsBefore = (await sessionRows(db, owner)).map((row) => row.id);
    expect(sessionsBefore).toContain(kept);

    expect(await store.verifyEmail(verification(await issue(owner)))).toMatchObject({ accountId: owner });

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: true, password_changed: false });
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual(expect.arrayContaining(sessionsBefore));
    expect(await workspacesOf(owner)).toHaveLength(1);
  });

  it("removes the second factor and its recovery codes, the API tokens, the linked identities and the pending link handshakes of an account nobody had verified, in the same transaction", async () => {
    const owner = await account();
    await plantFootholds(owner);
    expect(await footholds(owner)).toEqual(ALL);

    expect(await store.verifyEmail(verification(await issue(owner)))).toEqual({ accountId: owner, next: "done" });

    expect(await footholds(owner)).toEqual(NONE);
  });

  it("removes a second factor that was only begun, so no secret of the visitor's survives", async () => {
    const owner = await account();
    await plantFootholds(owner, { pendingEnrolment: true });

    await store.verifyEmail(verification(await issue(owner)));

    expect(await footholds(owner)).toEqual(NONE);
  });

  it("removes nothing of another account", async () => {
    const owner = await account();
    const bystander = await account();
    await plantFootholds(owner);
    await plantFootholds(bystander);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await footholds(owner)).toEqual(NONE);
    expect(await footholds(bystander)).toEqual(ALL);
  });

  it("keeps all of it for an account that is already verified", async () => {
    const owner = await account({ verified: true });
    await plantFootholds(owner);

    expect(await store.verifyEmail(verification(await issue(owner)))).toEqual({ accountId: owner, next: "mfa" });

    expect(await footholds(owner)).toEqual(ALL);
  });

  it("deletes the unused password-reset tokens of an account nobody had verified, so a reset requested before the owner verified cannot be redeemed after", async () => {
    const owner = await account();
    const reset = await issue(owner, { purpose: "password_reset" });
    const verify = await issue(owner);

    expect(await store.verifyEmail(verification(verify))).toEqual({ accountId: owner, next: "done" });

    expect(await tokenRows(owner)).toEqual([{ used: true }]);
    expect(await store.resetPassword({ tokenHash: reset, passwordHash: OLD_HASH, sessionId: freshId(), sessionTokenHash: freshToken().hash, ipPrefix: null, userAgent: null, replacedTokenHash: null })).toBeUndefined();
    expect((await accountRow(owner))?.password_hash).toBe(NEW_HASH);
  });

  it("clears the pending change of email and deletes its unused confirmation and cancel tokens of an account nobody had verified, so a change started before the owner verified cannot complete after", async () => {
    const owner = await account();
    await asSystem(db, (tx) => tx`UPDATE accounts SET pending_email = 'registrant@example.test' WHERE id = ${owner}`);
    const confirm = await issue(owner, { purpose: "email_change" });
    const cancel = await issue(owner, { purpose: "email_change_cancel" });
    const verify = await issue(owner);

    expect(await store.verifyEmail(verification(verify))).toEqual({ accountId: owner, next: "done" });

    expect(await tokenRows(owner)).toEqual([{ used: true }]);
    expect(await store.confirmEmailChange(confirm)).toBeUndefined();
    expect(await store.cancelEmailChange(cancel)).toBeUndefined();
    const [row] = await asSystem(db, (tx) => tx<{ email: string; pending_email: string | null }[]>`SELECT email, pending_email FROM accounts WHERE id = ${owner}`);
    expect(row?.pending_email).toBeNull();
    expect(row?.email).not.toBe("registrant@example.test");
  });

  it("keeps the pending change of email and its tokens of an account that is already verified, and of every other account", async () => {
    const verified = await account({ verified: true });
    const bystander = await account();
    await asSystem(db, (tx) => tx`UPDATE accounts SET pending_email = 'pending@example.test' WHERE id IN (${verified}, ${bystander})`);
    await issue(verified, { purpose: "email_change" });
    await issue(verified, { purpose: "email_change_cancel" });
    await issue(bystander, { purpose: "email_change" });

    await store.verifyEmail(verification(await issue(verified)));

    expect(await tokenRows(verified)).toEqual([{ used: false }, { used: false }, { used: true }]);
    expect(await tokenRows(bystander)).toEqual([{ used: false }]);
    const rows = await asSystem(db, (tx) => tx<{ pending_email: string | null }[]>`SELECT pending_email FROM accounts WHERE id IN (${verified}, ${bystander})`);
    expect(rows.map((row) => row.pending_email)).toEqual(["pending@example.test", "pending@example.test"]);
  });

  it("keeps the unused password-reset tokens of an account that is already verified, and of every other account", async () => {
    const verified = await account({ verified: true });
    const bystander = await account();
    await issue(verified, { purpose: "password_reset" });
    await issue(bystander, { purpose: "password_reset" });

    await store.verifyEmail(verification(await issue(verified)));

    expect(await tokenRows(verified)).toEqual([{ used: false }, { used: true }]);
    expect(await tokenRows(bystander)).toEqual([{ used: false }]);
  });

  it("keeps everything the visitor planted when afterVerified rejects", async () => {
    const owner = await account();
    await plantFootholds(owner);

    await expect(
      store.verifyEmail(
        verification(await issue(owner), {
          afterVerified: () => Promise.reject(new Error("the workspace step failed")),
        }),
      ),
    ).rejects.toThrow("the workspace step failed");

    expect(await footholds(owner)).toEqual(ALL);
  });

  it("makes a partial session for a verified account whose second factor is on", async () => {
    const owner = await account({ mfa: true, verified: true });
    const input = verification(await issue(owner));

    expect(await store.verifyEmail(input)).toEqual({ accountId: owner, next: "mfa" });

    expect((await sessionRows(db, owner)).map((row) => row.level)).toEqual(["partial"]);
  });

  it("ends the session of the cookie the request carried", async () => {
    const owner = await account();
    const stranger = await account({ verified: true });
    const carried = freshToken().hash;
    await db.app`SELECT sys_session_create(${freshId()}::uuid, ${stranger}::uuid, 'full', false, NULL, NULL, ${carried}::bytea, NULL)`;

    await store.verifyEmail(verification(await issue(owner), { replacedTokenHash: carried }));

    expect(await sessionRows(db, stranger)).toEqual([]);
  });

  it("answers nothing for a disabled account and gives it no session or workspace", async () => {
    const owner = await account();
    const token = await issue(owner);
    await asSystem(db, (tx) => tx`UPDATE accounts SET disabled_at = now() WHERE id = ${owner}`);

    expect(await store.verifyEmail(verification(token))).toBeUndefined();

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect(await sessionRows(db, owner)).toEqual([]);
    expect(await workspacesOf(owner)).toEqual([]);
  });

  it("undoes the verification, the new password, the deleted sessions and the use of the token when afterVerified rejects", async () => {
    const owner = await account();
    const kept = await session(owner);
    const token = await issue(owner);

    await expect(
      store.verifyEmail(
        verification(token, {
          afterVerified: async (accountId, workspaces) => {
            await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX, jobs: [] });
            throw new Error("the workspace step failed");
          },
        }),
      ),
    ).rejects.toThrow("the workspace step failed");

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect((await sessionRows(db, owner)).map((row) => row.id)).toEqual([kept]);
    expect(await workspacesOf(owner)).toEqual([]);
    expect(await tokenRows(owner)).toEqual([{ used: false }]);
    expect(await queued()).toEqual([]);
    expect(await store.verifyEmail(verification(token))).toMatchObject({ accountId: owner });
  });

  it("undoes the verification when the workspace event cannot be queued", async () => {
    const owner = await account();
    const token = await issue(owner);

    await expect(
      store.verifyEmail(
        verification(token, {
          afterVerified: async (accountId, workspaces) => {
            await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX, jobs: [{ id: freshId(), queue: "event.missing", data: {} }] });
          },
        }),
      ),
    ).rejects.toThrow(/does not exist/);

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect(await workspacesOf(owner)).toEqual([]);
  });

  it("refuses a malformed argument before it consumes anything", async () => {
    const owner = await account();
    const token = await issue(owner);

    await expect(store.verifyEmail(verification(Buffer.alloc(31)))).rejects.toThrow(RangeError);
    await expect(db.app`SELECT * FROM sys_email_verify(${token}::bytea, NULL, ${freshId()}::uuid, ${freshToken().hash}::bytea, NULL, NULL, NULL)`).rejects.toMatchObject({ code: "22023" });

    expect(await tokenRows(owner)).toEqual([{ used: false }]);
  });

  it("is not reachable by the application role through the tables it reads", async () => {
    await expect(db.app`SELECT 1 FROM credential_tokens`).rejects.toMatchObject({ code: "42501" });
  });
});

describe("sys_create_personal_workspace", () => {
  async function create(accountId: string, workspaceId = freshId(), suffix = SUFFIX): Promise<string> {
    const rows = await db.app`SELECT sys_create_personal_workspace(${accountId}::uuid, ${workspaceId}::uuid, ${suffix}::text) AS outcome`;
    return String(rows[0]?.["outcome"]);
  }

  it("creates the workspace through sys_create_workspace, with the owner membership and the settings row, once", async () => {
    const owner = await account({ displayName: "Grace" });

    expect(await create(owner)).toBe("created");
    expect(await create(owner)).toBe("exists");

    expect(await workspacesOf(owner)).toMatchObject([{ name: "Grace's workspace", created_by: owner, role: "owner" }]);
    const settings = await asSystem(db, (tx) => tx`SELECT count(*)::int AS n FROM workspace_settings`);
    expect(settings[0]?.["n"]).toBe(1);
  });

  it("creates one workspace when called at once", async () => {
    const owner = await account();

    const outcomes = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => create(owner)));

    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "exists")).toHaveLength(PARALLEL_CALLS - 1);
    expect(await workspacesOf(owner)).toHaveLength(1);
  });

  it("cuts a long display name so the whole name is 64 characters at most", async () => {
    const owner = await account({ displayName: "Ö".repeat(100) });

    expect(await create(owner)).toBe("created");

    const [workspace] = await workspacesOf(owner);
    expect(Array.from(workspace?.name ?? "")).toHaveLength(64);
    expect(workspace?.name.endsWith(SUFFIX)).toBe(true);
  });

  it("answers unavailable, writing nothing, for an unknown or a disabled account", async () => {
    const disabled = await account({ disabled: true });

    expect(await create(freshId())).toBe("unavailable");
    expect(await create(disabled)).toBe("unavailable");

    expect(await workspacesOf(disabled)).toEqual([]);
  });

  it("refuses a missing argument and a suffix that is empty or too long", async () => {
    const owner = await account();

    for (const suffix of ["", "x".repeat(33)]) {
      await expect(create(owner, freshId(), suffix)).rejects.toMatchObject({ code: "22023" });
    }
    await expect(db.app`SELECT sys_create_personal_workspace(${owner}::uuid, NULL, ${SUFFIX}::text)`).rejects.toMatchObject({ code: "22023" });
  });
});

describe("registerAccount with afterCreated", () => {
  let number = 0;

  function registration(overrides: Partial<NewRegistration> = {}): NewRegistration {
    number += 1;
    return {
      accountId: freshId(),
      email: `afterCreated${String(number)}@example.test`,
      displayName: "Ada",
      passwordHash: OLD_HASH,
      locale: "en",
      onCreated: [],
      onTaken: [],
      ...overrides,
    };
  }

  const provision: NewRegistration["afterCreated"] = async (accountId, workspaces) => {
    const workspaceId = freshId();
    await workspaces.create({ accountId, workspaceId, nameSuffix: SUFFIX, jobs: [workspaceCreated(accountId, workspaceId)] });
  };

  it("creates the personal workspace and queues its event in the transaction that creates the account", async () => {
    const input = registration({ afterCreated: provision });

    expect(await store.registerAccount(input)).toBe(true);

    expect(await workspacesOf(input.accountId)).toMatchObject([{ name: "Ada's workspace", role: "owner" }]);
    expect((await queued()).map((job) => job.name)).toEqual([QUEUE]);
  });

  it("creates nothing for an address that has an account, and never runs afterCreated for it", async () => {
    const first = registration({ email: "Same@Example.test" });
    await store.registerAccount(first);
    let ran = false;

    expect(
      await store.registerAccount(
        registration({
          email: "same@example.TEST",
          afterCreated: async () => {
            ran = true;
            await Promise.resolve();
          },
        }),
      ),
    ).toBe(false);

    expect(ran).toBe(false);
    expect(await workspacesOf(first.accountId)).toEqual([]);
  });

  it("leaves no account when afterCreated rejects", async () => {
    const input = registration({
      afterCreated: async (accountId, workspaces) => {
        await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX, jobs: [] });
        throw new Error("the workspace step failed");
      },
    });

    await expect(store.registerAccount(input)).rejects.toThrow("the workspace step failed");

    const rows = await asSystem(db, (tx) => tx`SELECT count(*)::int AS n FROM accounts`);
    expect(rows[0]?.["n"]).toBe(0);
    expect(await workspacesOf(input.accountId)).toEqual([]);
  });
});

describe("resendVerification", () => {
  function mail(accountId: string): QueuedJob {
    return { id: freshId(), queue: MAIL_QUEUE, data: { template: "verifyEmail", accountId } };
  }

  async function addressOf(accountId: string): Promise<string> {
    const rows = await asSystem(db, (tx) => tx<{ email: string }[]>`SELECT email::text AS email FROM accounts WHERE id = ${accountId}`);
    return rows[0]?.email ?? "";
  }

  it("queues the job built for the account that holds the address, in any case, whether or not it is verified", async () => {
    const unverified = await account();
    const verified = await account({ verified: true });
    const jobFor = (accountId: string) => [mail(accountId)];
    const unknown = [mail(freshId())];

    for (const id of [unverified, verified]) {
      await store.resendVerification({ email: (await addressOf(id)).toUpperCase(), onKnown: jobFor, onUnknown: unknown });
    }

    expect((await queued()).map((job) => job.data["accountId"]).sort()).toEqual([unverified, verified].sort());
  });

  it("queues the onUnknown jobs, and not the onKnown ones, for an address no account holds", async () => {
    const stranger = freshId();
    let asked = false;

    await store.resendVerification({
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

  it("creates and changes nothing but the job: no token, session, password or verification state", async () => {
    const id = await account();
    const snapshot = async () =>
      asSystem(db, async (tx) => ({
        account: (await tx`SELECT password_hash, email_verified_at, password_changed_at, updated_at FROM accounts WHERE id = ${id}`)[0],
        tokens: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM credential_tokens`)[0]?.n,
        sessions: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions`)[0]?.n,
      }));
    const before = await snapshot();

    await store.resendVerification({ email: await addressOf(id), onKnown: (accountId) => [mail(accountId)], onUnknown: [mail(freshId())] });

    expect(await snapshot()).toEqual(before);
    expect(await queued()).toHaveLength(1);
  });

  it("undoes the jobs already queued when a later one cannot be, and rejects", async () => {
    const id = await account();
    const missing: QueuedJob = { id: freshId(), queue: "no.such.queue", data: {} };

    await expect(store.resendVerification({ email: await addressOf(id), onKnown: (accountId) => [mail(accountId), missing], onUnknown: [] })).rejects.toThrow();

    expect(await queued()).toEqual([]);
  });
});

describe("emailVerified", () => {
  it("is true only for an account whose address was verified, and false for a missing account", async () => {
    const unverified = await account();
    const verified = await account({ verified: true });

    expect(await store.emailVerified(unverified)).toBe(false);
    expect(await store.emailVerified(verified)).toBe(true);
    expect(await store.emailVerified(freshId())).toBe(false);
  });

  it("reads a disabled account as it is, without telling the caller anything else", async () => {
    expect(await store.emailVerified(await account({ disabled: true }))).toBe(false);
    expect(await store.emailVerified(await account({ disabled: true, verified: true }))).toBe(true);
  });
});
