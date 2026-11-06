import type { AuditRecord } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type EmailVerification, type NewRegistration, type QueuedJob } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Verifying a registered address and the personal workspace (doc 05 section 3.3, doc 02 sections 2.2 and
// 2.6, doc 10 T4 and T8). The failure scenarios: a verification token that works twice, after its expiry,
// for another purpose or for another account; a replay that creates a second workspace; an account a
// visitor registered that keeps the visitor's password or sessions once the owner has verified it; a
// verification that commits without the workspace it was to create, or the other way round.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
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

/** The audit event of a personal workspace, built from the name the database gave it, as the application's core service does. */
function workspaceAudit(accountId: string, workspaceId: string, overrides: Partial<AuditRecord> = {}) {
  return ({ name, displayName }: { name: string; displayName: string }): AuditRecord => ({
    id: freshId(),
    workspaceId,
    actorType: "account",
    actorAccountId: accountId,
    actorLabel: displayName,
    actorTokenId: null,
    action: "workspace.created",
    entityType: "workspace",
    entityId: workspaceId,
    metadata: { name },
    ipPrefix: null,
    ...overrides,
  });
}

async function auditRows(): Promise<{ workspace_id: string; actor_account_id: string | null; actor_label: string; action: string; metadata: unknown }[]> {
  return asSystem(db, (tx) => tx`SELECT workspace_id, actor_account_id, actor_label, action, metadata FROM audit_events ORDER BY created_at, id`);
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
      await workspaces.create({
        accountId,
        workspaceId,
        nameSuffix: SUFFIX,
        ownedMax: null,
        jobs: [workspaceCreated(accountId, workspaceId)],
        audit: workspaceAudit(accountId, workspaceId),
      });
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
    expect(systemOperations).not.toContain("sys_create_personal_workspace");
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

  it("writes the workspace.created audit event of the personal workspace in the same transaction, named from what the database made", async () => {
    const owner = await account({ displayName: "Ada Lovelace" });

    await store.verifyEmail(verification(await issue(owner)));

    const [workspace] = await workspacesOf(owner);
    expect(await auditRows()).toEqual([
      { workspace_id: workspace?.id, actor_account_id: owner, actor_label: "Ada Lovelace", action: "workspace.created", metadata: { name: "Ada Lovelace's workspace" } },
    ]);
  });

  it("writes one audit event however often the link is used, and none for an account that already owns a workspace", async () => {
    const owner = await account();
    const token = await issue(owner);
    await store.verifyEmail(verification(token));
    await store.verifyEmail(verification(token));
    expect(await auditRows()).toHaveLength(1);

    const second = await account();
    const existing = freshId();
    await asSystem(db, (tx) => tx`SELECT sys_create_workspace(${second}::uuid, ${existing}::uuid, 'Already here'::text)`);
    await store.verifyEmail(verification(await issue(second)));

    expect((await workspacesOf(second)).map((workspace) => workspace.name)).toEqual(["Already here"]);
    expect(await auditRows()).toHaveLength(1);
  });

  it("undoes the verification, the workspace and its event when the audit event cannot be written", async () => {
    const owner = await account();
    const token = await issue(owner);

    await expect(
      store.verifyEmail(
        verification(token, {
          afterVerified: async (accountId, workspaces) => {
            const workspaceId = freshId();
            await workspaces.create({
              accountId,
              workspaceId,
              nameSuffix: SUFFIX,
        ownedMax: null,
              jobs: [workspaceCreated(accountId, workspaceId)],
              audit: workspaceAudit(accountId, workspaceId, { action: "x".repeat(65) as AuditRecord["action"] }),
            });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect(await workspacesOf(owner)).toEqual([]);
    expect(await queued()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("refuses an audit event that names another workspace than the one it made, and leaves nothing", async () => {
    const owner = await account();
    const token = await issue(owner);

    await expect(
      store.verifyEmail(
        verification(token, {
          afterVerified: async (accountId, workspaces) => {
            await workspaces.create({
              accountId,
              workspaceId: freshId(),
              nameSuffix: SUFFIX,
        ownedMax: null,
              jobs: [],
              audit: workspaceAudit(accountId, freshId()),
            });
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    expect(await workspacesOf(owner)).toEqual([]);
    expect(await auditRows()).toEqual([]);
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
            await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX,
        ownedMax: null, jobs: [] });
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
            await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX,
        ownedMax: null, jobs: [{ id: freshId(), queue: "event.missing", data: {} }] });
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

interface Planted {
  readonly workspaceId: string;
  readonly bookmarkId: string;
  readonly folderId: string;
  readonly teamId: string;
}

/**
 * A workspace as `creator` set up in it: a bookmark and a folder of the creator's, a team with the members, a share of the bookmark and of
 * the folder with each member and one of the bookmark with the team, an API token of each member and a pending invitation sent by the
 * creator. `members` join with their role; the creator joins with `creatorRole` (none when null).
 */
async function plantWorkspace(
  creator: string,
  members: readonly { readonly accountId: string; readonly role: "owner" | "admin" | "member" }[],
  options: { readonly creatorRole?: "owner" | "admin" | "member" | null } = {},
): Promise<Planted> {
  const workspaceId = await seedWorkspace(db, { createdBy: creator });
  if (options.creatorRole !== null) {
    await seedMember(db, { workspaceId, accountId: creator, role: options.creatorRole ?? "owner" });
  }
  for (const member of members) {
    await seedMember(db, { workspaceId, accountId: member.accountId, role: member.role });
  }
  const bookmarkId = freshId();
  const folderId = freshId();
  const teamId = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${bookmarkId}, ${workspaceId}, ${creator}, 'https://example.com/', 'https://example.com', 'example.com', 'Planted')`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folderId}, ${workspaceId}, ${creator}, 'Planted')`;
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${teamId}, ${workspaceId}, 'Planted team')`;
    for (const member of members) {
      await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${teamId}, ${member.accountId})`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${bookmarkId}, ${member.accountId}, ${creator})`;
      await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${folderId}, ${member.accountId}, ${creator})`;
    }
    await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_team_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${bookmarkId}, ${teamId}, ${creator})`;
    await tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at, invited_by)
      VALUES (${freshId()}, ${workspaceId}, ${`invitee-${workspaceId}@example.test`}, 'member', ${freshToken().hash}, now() + interval '7 days', ${creator})`;
  });
  for (const member of members) {
    // The table is closed to slugbase_system for inserts; the owner writes the row under the member's own policy, as a token is created.
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${member.accountId}, true)`;
      await tx`
        INSERT INTO api_tokens (id, account_id, workspace_id, name, token_hash, token_prefix, scope)
        VALUES (${freshId()}, ${member.accountId}, ${workspaceId}, ${`token ${workspaceId}`}, ${freshToken().hash}, 'abcdef', 'read')`;
    });
  }
  return { workspaceId, bookmarkId, folderId, teamId };
}

/** A bookmark and a folder that `ownerId` owns in the workspace. */
async function seedContent(workspaceId: string, ownerId: string): Promise<void> {
  const bookmarkId = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${bookmarkId}, ${workspaceId}, ${ownerId}, ${`https://example.com/${bookmarkId}`}, ${`https://example.com/${bookmarkId}`}, 'example.com', 'Own')`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${workspaceId}, ${ownerId}, ${`Own ${bookmarkId}`})`;
  });
}

interface WorkspaceState {
  readonly exists: boolean;
  readonly members: string[];
  readonly teams: number;
  readonly teamMembers: number;
  readonly bookmarkShares: number;
  readonly folderShares: number;
  readonly pendingInvitations: number;
  readonly apiTokens: number;
  readonly bookmarks: number;
  readonly folders: number;
  readonly ownedBookmarks: number;
}

async function workspaceState(workspaceId: string): Promise<WorkspaceState> {
  const rows = await asSystem(
    db,
    (tx) => tx<
      {
        exists: boolean;
        members: string[] | null;
        teams: number;
        team_members: number;
        bookmark_shares: number;
        folder_shares: number;
        invitations: number;
        tokens: number;
        bookmarks: number;
        folders: number;
        owned: number;
      }[]
    >`
      SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${workspaceId} AND w.deleting_at IS NULL) AS exists,
             (SELECT array_agg(account_id::text ORDER BY account_id) FROM workspace_members WHERE workspace_id = ${workspaceId}) AS members,
             (SELECT count(*)::int FROM teams WHERE workspace_id = ${workspaceId}) AS teams,
             (SELECT count(*)::int FROM team_members WHERE workspace_id = ${workspaceId}) AS team_members,
             (SELECT count(*)::int FROM bookmark_shares WHERE workspace_id = ${workspaceId}) AS bookmark_shares,
             (SELECT count(*)::int FROM folder_shares WHERE workspace_id = ${workspaceId}) AS folder_shares,
             (SELECT count(*)::int FROM workspace_invitations WHERE workspace_id = ${workspaceId} AND status = 'pending') AS invitations,
             (SELECT count(*)::int FROM api_tokens WHERE workspace_id = ${workspaceId}) AS tokens,
             (SELECT count(*)::int FROM bookmarks WHERE workspace_id = ${workspaceId}) AS bookmarks,
             (SELECT count(*)::int FROM folders WHERE workspace_id = ${workspaceId}) AS folders,
             (SELECT count(*)::int FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id IS NOT NULL) AS owned`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("the state query returned no row");
  }
  return {
    exists: row.exists,
    members: row.members ?? [],
    teams: row.teams,
    teamMembers: row.team_members,
    bookmarkShares: row.bookmark_shares,
    folderShares: row.folder_shares,
    pendingInvitations: row.invitations,
    apiTokens: row.tokens,
    bookmarks: row.bookmarks,
    folders: row.folders,
    ownedBookmarks: row.owned,
  };
}

async function queuedJobCount(): Promise<number> {
  return (await queued()).filter((job) => job.name !== QUEUE && job.name !== MAIL_QUEUE).length;
}

async function workspaceIdsOf(accountId: string): Promise<string[]> {
  return (await workspacesOf(accountId)).map((workspace) => workspace.id);
}

/**
 * A workspace as the instance console makes it: `adminId` (an instance admin) creates it with the existing account `ownerId` as its first
 * owner, which records the admin as its creator, and then adds itself to it as a member.
 */
async function consoleWorkspace(adminId: string, ownerId: string): Promise<string> {
  const workspaceId = freshId();
  await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${adminId}, true)`;
    const created = await tx`
      SELECT * FROM sys_instance_create_workspace(${freshId()}::uuid, NULL::cidr, ${workspaceId}::uuid, 'Console workspace', ${ownerId}::uuid, NULL::citext, NULL::uuid, NULL::bytea, NULL::integer)`;
    expect(created[0]).toMatchObject({ outcome: "created" });
  });
  return workspaceId;
}

async function addInstanceAdminMembership(adminId: string, workspaceId: string): Promise<void> {
  await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${adminId}, true)`;
    const added = await tx`SELECT sys_instance_add_membership(${freshId()}::uuid, ${freshId()}::uuid, NULL::cidr, ${workspaceId}::uuid) AS outcome`;
    expect(added[0]?.["outcome"]).toBe("added");
  });
}

/** A member, a team, a share and a pending invitation of the workspace, as its owner set them up. */
async function populate(workspaceId: string, ownerId: string, memberId: string): Promise<void> {
  await seedMember(db, { workspaceId, accountId: memberId, role: "member" });
  const bookmarkId = freshId();
  const teamId = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${bookmarkId}, ${workspaceId}, ${ownerId}, 'https://example.com/', 'https://example.com', 'example.com', 'Owner')`;
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${teamId}, ${workspaceId}, 'Team')`;
    await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${teamId}, ${memberId})`;
    await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${bookmarkId}, ${memberId}, ${ownerId})`;
    await tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at, invited_by)
      VALUES (${freshId()}, ${workspaceId}, ${`invitee-${workspaceId}@example.test`}, 'member', ${freshToken().hash}, now() + interval '7 days', ${ownerId})`;
  });
}

/** How many backends of this database wait for a lock. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilBlocked(): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) === 0) {
    if (Date.now() > deadline) {
      throw new Error("the redemption never waited for a lock");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe("verifyEmail and what the visitor set up in workspaces", () => {
  it("leaves the account no workspace it owns alone with another member, a team, an invitation or a share, whatever was planted before the address was verified", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "admin" }]);
    expect(await workspaceState(planted.workspaceId)).toMatchObject({ members: [accomplice, owner].sort(), teams: 1, pendingInvitations: 1, apiTokens: 1 });

    expect(await store.verifyEmail(verification(await issue(owner)))).toEqual({ accountId: owner, next: "done" });

    expect(await workspaceState(planted.workspaceId)).toEqual({
      exists: true,
      members: [owner],
      teams: 0,
      teamMembers: 0,
      bookmarkShares: 0,
      folderShares: 0,
      pendingInvitations: 0,
      apiTokens: 0,
      bookmarks: 1,
      folders: 1,
      ownedBookmarks: 1,
    });
    expect(await workspacesOf(owner)).toMatchObject([{ id: planted.workspaceId, role: "owner" }]);
    expect(await workspacesOf(accomplice)).toEqual([]);
    expect(await accountRow(accomplice)).toMatchObject({ verified: true });
    expect(await queuedJobCount()).toBe(0);
  });

  it("keeps the account's own content in a workspace it strips, and the content of a removed member as ownerless content", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    await seedContent(planted.workspaceId, owner);
    await seedContent(planted.workspaceId, accomplice);

    await store.verifyEmail(verification(await issue(owner)));

    const state = await workspaceState(planted.workspaceId);
    expect(state).toMatchObject({ bookmarks: 3, folders: 3, ownedBookmarks: 2 });
    const owners = await asSystem(db, (tx) => tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks WHERE workspace_id = ${planted.workspaceId} ORDER BY owner_id NULLS FIRST`);
    expect(owners.map((row) => row.owner_id)).toEqual([null, owner, owner]);
  });

  it("strips every workspace the account owns alone and gives it no new one, since it already owns a workspace", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const first = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    const second = await plantWorkspace(owner, [{ accountId: accomplice, role: "admin" }]);
    let created: string | undefined;

    await store.verifyEmail(
      verification(await issue(owner), {
        afterVerified: async (accountId, workspaces) => {
          created = await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX, ownedMax: 1, jobs: [] });
        },
      }),
    );

    expect(created).toBe("exists");
    expect((await workspaceIdsOf(owner)).sort()).toEqual([first.workspaceId, second.workspaceId].sort());
    for (const planted of [first, second]) {
      expect(await workspaceState(planted.workspaceId)).toMatchObject({ exists: true, members: [owner], teams: 0, bookmarkShares: 0, folderShares: 0, pendingInvitations: 0 });
    }
    expect(await workspacesOf(accomplice)).toEqual([]);
  });

  it("strips a workspace the account created even when it made another account an owner of it, with the shares, teams and invitations it added", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const member = await account({ verified: true });
    const planted = await plantWorkspace(owner, [
      { accountId: accomplice, role: "owner" },
      { accountId: member, role: "member" },
    ]);
    expect(await workspaceState(planted.workspaceId)).toMatchObject({ members: [accomplice, member, owner].sort(), teams: 1, pendingInvitations: 1, bookmarkShares: 3, folderShares: 2 });

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(planted.workspaceId)).toEqual({
      exists: true,
      members: [owner],
      teams: 0,
      teamMembers: 0,
      bookmarkShares: 0,
      folderShares: 0,
      pendingInvitations: 0,
      apiTokens: 0,
      bookmarks: 1,
      folders: 1,
      ownedBookmarks: 1,
    });
    expect(await workspacesOf(owner)).toMatchObject([{ id: planted.workspaceId, role: "owner" }]);
    expect(await workspacesOf(accomplice)).toEqual([]);
    expect(await accountRow(accomplice)).toMatchObject({ verified: true });
  });

  it("strips a workspace the account created that it shares with an owner it promoted, whoever else owns it, and leaves the account its owner", async () => {
    const owner = await account();
    const first = await account({ verified: true });
    const second = await account({ verified: true });
    const planted = await plantWorkspace(owner, [
      { accountId: first, role: "owner" },
      { accountId: second, role: "owner" },
    ]);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(planted.workspaceId)).toMatchObject({ members: [owner], teams: 0, bookmarkShares: 0, folderShares: 0, pendingInvitations: 0 });
    expect(await workspacesOf(owner)).toMatchObject([{ id: planted.workspaceId, role: "owner" }]);
  });

  it("strips a workspace the account created and then demoted itself in, after promoting an accomplice to owner, and leaves the account its only member and owner", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const member = await account({ verified: true });
    const planted = await plantWorkspace(
      owner,
      [
        { accountId: accomplice, role: "owner" },
        { accountId: member, role: "member" },
      ],
      { creatorRole: "admin" },
    );
    expect(await workspacesOf(owner)).toMatchObject([{ id: planted.workspaceId, role: "admin" }]);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(planted.workspaceId)).toMatchObject({ exists: true, members: [owner], teams: 0, bookmarkShares: 0, folderShares: 0, pendingInvitations: 0, apiTokens: 0, bookmarks: 1, folders: 1 });
    expect(await workspacesOf(owner)).toMatchObject([{ id: planted.workspaceId, role: "owner" }]);
    expect(await workspacesOf(accomplice)).toEqual([]);
  });

  it("leaves a workspace the instance console created for another owner as it was, though its creator is the account and a member of it", async () => {
    const admin = await account({ mfa: true });
    await asSystem(db, (tx) => tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${admin}`);
    const owner = await account({ verified: true });
    const member = await account({ verified: true });
    const workspaceId = await consoleWorkspace(admin, owner);
    await populate(workspaceId, owner, member);
    await addInstanceAdminMembership(admin, workspaceId);
    const before = await workspaceState(workspaceId);
    expect(before).toMatchObject({ members: [admin, member, owner].sort(), teams: 1, bookmarkShares: 1, pendingInvitations: 1 });

    await store.verifyEmail(verification(await issue(admin)));

    expect(await workspaceState(workspaceId)).toEqual(before);
    expect(await workspacesOf(owner)).toMatchObject([{ id: workspaceId, role: "owner" }]);
    expect(await workspacesOf(admin)).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspaceId, role: "member" })]));
  });

  it("leaves a console workspace made before self_created existed as it was, though its creator is the account and a member of it", async () => {
    // A row as the instance console wrote it before the column existed: the admin is created_by, another account is the first owner, and both
    // flags read false because nothing wrote them.
    const admin = await account();
    const owner = await account({ verified: true });
    const member = await account({ verified: true });
    const workspaceId = await seedWorkspace(db, { createdBy: admin, selfCreated: false });
    await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
    await populate(workspaceId, owner, member);
    await seedMember(db, { workspaceId, accountId: admin, role: "member" });
    const before = await workspaceState(workspaceId);
    expect(before).toMatchObject({ members: [admin, member, owner].sort(), teams: 1, bookmarkShares: 1, pendingInvitations: 1 });

    await store.verifyEmail(verification(await issue(admin)));

    expect(await workspaceState(workspaceId)).toEqual(before);
    expect(await workspacesOf(owner)).toMatchObject([{ id: workspaceId, role: "owner" }]);
    expect(await workspacesOf(admin)).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspaceId, role: "member" })]));
  });

  it("still judges a workspace made before self_created existed by the only-owner rule, stripping it when the account is its only owner", async () => {
    const owner = await account();
    const member = await account({ verified: true });
    const workspaceId = await seedWorkspace(db, { createdBy: owner, selfCreated: false });
    await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
    await populate(workspaceId, owner, member);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(workspaceId)).toMatchObject({ members: [owner], teams: 0, bookmarkShares: 0, pendingInvitations: 0 });
  });

  it("leaves a workspace the account created and then left alone, since it is no member of it to strip", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const workspaceId = await seedWorkspace(db, { createdBy: owner });
    await seedMember(db, { workspaceId, accountId: accomplice, role: "owner" });
    const before = await workspaceState(workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(workspaceId)).toEqual(before);
    expect(before.members).toEqual([accomplice]);
    expect((await workspacesOf(owner)).map((workspace) => workspace.id)).not.toContain(workspaceId);
  });

  it(
    "takes the row of a workspace the account created but no longer owns before the account row, so a lock on that workspace is waited for first",
    async () => {
      const owner = await account();
      const accomplice = await account({ verified: true });
      const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "owner" }], { creatorRole: "admin" });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = db.owner
        .begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`SELECT 1 FROM workspaces WHERE id = ${planted.workspaceId} FOR NO KEY UPDATE`;
          held();
          await released;
        })
        .then(
          () => undefined,
          (error: unknown) => ({ error }),
        );
      await holding;
      const redemption = store.verifyEmail(verification(await issue(owner))).then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      let accountRowFree = false;
      try {
        await waitUntilBlocked();
        // The redemption is waiting for the workspace, so it holds no lock on the account row yet.
        await db.owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`SELECT 1 FROM accounts WHERE id = ${owner} FOR UPDATE NOWAIT`;
          accountRowFree = true;
        });
      } finally {
        release();
      }

      expect(await Promise.all([holder, redemption])).toEqual([undefined, undefined]);
      expect(accountRowFree).toBe(true);
      expect(await workspaceState(planted.workspaceId)).toMatchObject({ members: [owner] });
    },
    TEST_TIMEOUT_MS,
  );

  it("leaves a workspace another account created and owns, where the account is one of the owners, exactly as it was", async () => {
    const owner = await account();
    const founder = await account({ verified: true });
    const member = await account({ verified: true });
    const theirs = await plantWorkspace(founder, [
      { accountId: owner, role: "owner" },
      { accountId: member, role: "member" },
    ]);
    const before = await workspaceState(theirs.workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    // Only the API token the account held there goes with its credentials (account_mark_verified).
    expect(await workspaceState(theirs.workspaceId)).toEqual({ ...before, apiTokens: before.apiTokens - 1 });
    expect(before.members).toHaveLength(3);
    expect(await workspaceIdsOf(owner)).toContain(theirs.workspaceId);
  });

  it("leaves a workspace whose creator is gone and that another owner holds exactly as it was, since nothing says the account made that owner", async () => {
    const owner = await account();
    const coOwner = await account({ verified: true });
    const member = await account({ verified: true });
    const orphan = await plantWorkspace(owner, [
      { accountId: coOwner, role: "owner" },
      { accountId: member, role: "member" },
    ]);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET created_by = NULL WHERE id = ${orphan.workspaceId}`);
    const before = await workspaceState(orphan.workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(orphan.workspaceId)).toEqual(before);
    expect(before.members).toHaveLength(3);
  });

  it("leaves a workspace someone else owns that the account joined, and the account stays a member of it", async () => {
    const owner = await account();
    const realOwner = await account({ verified: true });
    const colleague = await account({ verified: true });
    const theirs = await plantWorkspace(realOwner, [
      { accountId: colleague, role: "member" },
      { accountId: owner, role: "admin" },
    ]);
    await seedContent(theirs.workspaceId, owner);
    const before = await workspaceState(theirs.workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    // The API token the account held there goes with the credentials (account_mark_verified), as for any account nobody had verified.
    expect(await workspaceState(theirs.workspaceId)).toEqual({ ...before, apiTokens: before.apiTokens - 1 });
    expect(before.members).toContain(owner);
    expect(await workspacesOf(owner)).toEqual(expect.arrayContaining([expect.objectContaining({ id: theirs.workspaceId, role: "admin" })]));
  });

  it("leaves the workspaces of another account untouched, even one the two share a member in", async () => {
    const owner = await account();
    const bystander = await account();
    const friend = await account({ verified: true });
    const plantedByOwner = await plantWorkspace(owner, [{ accountId: friend, role: "member" }]);
    const plantedByBystander = await plantWorkspace(bystander, [{ accountId: friend, role: "member" }]);
    const before = await workspaceState(plantedByBystander.workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(plantedByBystander.workspaceId)).toEqual(before);
    expect((await workspaceState(plantedByOwner.workspaceId)).members).toEqual([owner]);
    expect(await workspaceIdsOf(friend)).toEqual([plantedByBystander.workspaceId]);
  });

  it("leaves a workspace that is being deleted as it was", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${planted.workspaceId}`);
    const before = await workspaceState(planted.workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(planted.workspaceId)).toEqual(before);
    expect(before.members).toHaveLength(2);
  });

  it("changes nothing for an account whose address was already verified", async () => {
    const owner = await account({ verified: true });
    const member = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: member, role: "member" }]);
    const before = await workspaceState(planted.workspaceId);

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspaceState(planted.workspaceId)).toEqual(before);
    expect(before).toMatchObject({ teams: 1, pendingInvitations: 1 });
    expect(before.bookmarkShares).toBeGreaterThan(0);
  });

  it("does nothing more when the link is used again", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    const token = await issue(owner);
    await store.verifyEmail(verification(token));
    const stripped = await workspaceState(planted.workspaceId);
    // Someone is let in afterwards, as an owner who has verified may do: a replay of the link must not take it away.
    const later = await account({ verified: true });
    await seedMember(db, { workspaceId: planted.workspaceId, accountId: later, role: "member" });

    expect(await store.verifyEmail(verification(token))).toBeUndefined();

    expect(await workspaceState(planted.workspaceId)).toEqual({ ...stripped, members: [owner, later].sort() });
  });

  it("does not strip in account_mark_verified itself, which the admin's mark follows with account_strip_workspaces, and the later link strips nothing", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    const before = await workspaceState(planted.workspaceId);
    const token = await issue(owner);
    await asSystem(db, (tx) => tx`SELECT account_mark_verified(${owner}::uuid, NULL::text)`);

    expect(await workspaceState(planted.workspaceId)).toEqual(before);
    await store.verifyEmail(verification(token));

    expect(await workspaceState(planted.workspaceId)).toEqual(before);
  });

  it("strips nothing for an account that owns no workspace and belongs to none, and gives it its personal workspace", async () => {
    const owner = await account();

    await store.verifyEmail(verification(await issue(owner)));

    expect(await workspacesOf(owner)).toMatchObject([{ name: "Ada's workspace", role: "owner" }]);
    expect(await queuedJobCount()).toBe(0);
  });

  it("keeps everything the visitor set up when afterVerified rejects", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    const before = await workspaceState(planted.workspaceId);

    await expect(store.verifyEmail(verification(await issue(owner), { afterVerified: () => Promise.reject(new Error("the workspace step failed")) }))).rejects.toThrow("the workspace step failed");

    expect(await workspaceState(planted.workspaceId)).toEqual(before);
    expect((await accountRow(owner))?.verified).toBe(false);
  });

  it("keeps the whole setup, the credentials included, when the last removal fails after the shares, invitations and teams went", async () => {
    const owner = await account();
    const accomplice = await account({ verified: true });
    const planted = await plantWorkspace(owner, [{ accountId: accomplice, role: "member" }]);
    await plantFootholds(owner);
    const before = await workspaceState(planted.workspaceId);
    const footholdsBefore = await footholds(owner);
    const token = await issue(owner);
    await db.owner.unsafe(`
      CREATE FUNCTION fail_member_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'member removal failed'; END $$;
      CREATE TRIGGER fail_member_delete BEFORE DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION fail_member_delete_fn();`);

    try {
      await expect(store.verifyEmail(verification(token))).rejects.toThrow("member removal failed");
    } finally {
      await db.owner.unsafe("DROP TRIGGER fail_member_delete ON workspace_members; DROP FUNCTION fail_member_delete_fn()");
    }

    expect(await workspaceState(planted.workspaceId)).toEqual(before);
    expect(await footholds(owner)).toEqual(footholdsBefore);
    expect(await accountRow(owner)).toEqual({ password_hash: OLD_HASH, verified: false, password_changed: false });
    expect(await tokenRows(owner)).toEqual([{ used: false }]);
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
    await workspaces.create({ accountId, workspaceId, nameSuffix: SUFFIX,
        ownedMax: null, jobs: [workspaceCreated(accountId, workspaceId)] });
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
        await workspaces.create({ accountId, workspaceId: freshId(), nameSuffix: SUFFIX,
        ownedMax: null, jobs: [] });
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
