import type { AuditRecord, InvitationSignupResult } from "@slugbase/core";
import { prepareAuditRecord } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, invitationAcceptanceRepository, type AuthStore, type NewInvitationAccount } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sha256 } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// sys_invitation_accept_new_account through AuthStore.acceptInvitationWithNewAccount (doc 05 section 3.3, doc 02
// sections 2.2 and 3.4, doc 04 section 10.5, doc 10 T1, T8 and T19). The failure scenarios: a token that creates an
// account twice, under parallel requests or after it was used; one that creates one after its expiry, its
// revocation, a newer link or the deletion of its workspace; an account created for an address other than the
// invited one; a refusal (an address that has an account, no seat left) that leaves an account, a membership, a
// session or a half-accepted invitation behind; a job or an audit event that cannot be written and leaves the
// account behind; and a personal workspace made for the account.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 8;
const QUEUE = "event.member.joined";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

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
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
});

let emailNumber = 0;

interface Invitation {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly token: Buffer;
  readonly hash: Buffer;
}

// A mailed invitation holds the identifier of its mail job as the mail ticket; `mailed: false` is a row no mail job wrote, the shape
// of a copyable link an earlier release stored before workspace_invitations.link_issued existed.
async function invite(
  workspaceId: string,
  options: { email?: string; role?: Role; expiresInSeconds?: number; mailed?: boolean } = {},
): Promise<Invitation> {
  emailNumber += 1;
  const id = freshId();
  const email = options.email ?? `Invitee${String(emailNumber)}@Example.test`;
  const { token, hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, mail_ticket, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, ${options.role ?? "member"}, ${hash}, ${options.mailed === false ? null : id},
              now() + ${options.expiresInSeconds ?? 7 * 24 * 60 * 60} * interval '1 second')`,
  );
  return { id, workspaceId, email, token, hash };
}

async function workspaceWithOwner(): Promise<string> {
  emailNumber += 1;
  const workspaceId = await seedWorkspace(db, { name: "Signup test" });
  const owner = freshId();
  await seedAccount(db, { id: owner, email: `owner${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  return workspaceId;
}

interface Acceptance {
  readonly input: NewInvitationAccount;
  readonly sessionToken: Buffer;
}

function acceptance(hash: Buffer, overrides: Partial<NewInvitationAccount> = {}): Acceptance {
  const accountId = overrides.accountId ?? freshId();
  const session = freshToken();
  return {
    sessionToken: session.token,
    input: {
      tokenHash: hash,
      accountId,
      displayName: "Grace Hopper",
      passwordHash: PASSWORD_HASH,
      locale: "de",
      seatLimit: null,
      emailVerificationRequired: false,
      session: { id: freshId(), tokenHash: session.hash, replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
      onAccepted: ({ workspaceId, role }) => ({
        audit: [
          prepareAuditRecord(
            {
              action: "member.joined",
              workspaceId,
              actor: { type: "account", accountId, label: "Grace Hopper" },
              entity: { type: "member", id: accountId },
              metadata: { role },
              ipPrefix: "203.0.0.0/16",
            },
            freshId,
          ),
        ],
        jobs: [{ id: freshId(), queue: QUEUE, data: { workspaceId, accountId, role } }],
      }),
      ...overrides,
    },
  };
}

function accept(hash: Buffer, overrides: Partial<NewInvitationAccount> = {}): Promise<InvitationSignupResult> {
  return store.acceptInvitationWithNewAccount(acceptance(hash, overrides).input);
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  locale: string;
  email_verified_at: Date | null;
  is_instance_admin: boolean;
}

async function accountsWithEmail(email: string): Promise<AccountRow[]> {
  return [
    ...(await asSystem(
      db,
      (tx) => tx<AccountRow[]>`SELECT id, email, display_name, password_hash, locale, email_verified_at, is_instance_admin FROM accounts WHERE email = ${email}`,
    )),
  ];
}

async function accountCount(): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM accounts`);
  return Number(rows[0]?.n);
}

async function members(workspaceId: string): Promise<Record<string, string>> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`);
  return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
}

interface InvitationRow {
  status: string;
  accepted_by: string | null;
  closed_at: Date | null;
  link_issued: boolean;
  mail_ticket: string | null;
}

async function invitationRow(id: string): Promise<InvitationRow> {
  const rows = await asSystem(db, (tx) => tx<InvitationRow[]>`SELECT status, accepted_by, closed_at, link_issued, mail_ticket FROM workspace_invitations WHERE id = ${id}`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

async function sessionsOf(accountId: string): Promise<{ id: string; level: string; token_hash: Buffer; active_workspace_id: string | null; ip_prefix: string | null }[]> {
  return [
    ...(await asSystem(db, (tx) => tx<{ id: string; level: string; token_hash: Buffer; active_workspace_id: string | null; ip_prefix: string | null }[]>`
      SELECT id, level, token_hash, active_workspace_id, ip_prefix FROM sessions WHERE account_id = ${accountId}`)),
  ];
}

async function workspacesCreatedBy(accountId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM workspaces WHERE created_by = ${accountId}`);
  return Number(rows[0]?.n);
}

async function jobs(): Promise<{ id: string; name: string; data: Record<string, unknown> }[]> {
  return [...(await db.app<{ id: string; name: string; data: Record<string, unknown> }[]>`SELECT id, name, data FROM pgboss.job ORDER BY id`)];
}

async function auditOf(workspaceId: string): Promise<{ action: string; actor_account_id: string }[]> {
  return [...(await asSystem(db, (tx) => tx<{ action: string; actor_account_id: string }[]>`SELECT action, actor_account_id FROM audit_events WHERE workspace_id = ${workspaceId}`))];
}

describe("sys_invitation_accept_new_account", () => {
  it("creates the verified account of the invited address with the invited role, accepts the invitation as it and signs it in with a full session acting in the workspace, writing its audit event and jobs in the same transaction", async () => {
    const workspaceId = await workspaceWithOwner();
    for (const role of ["member", "admin"] as const) {
      const invitation = await invite(workspaceId, { role });
      const { input, sessionToken } = acceptance(invitation.hash);

      const result = await store.acceptInvitationWithNewAccount(input);

      expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role, sessionCreated: true });
      const [account, ...rest] = await accountsWithEmail(invitation.email.toLowerCase());
      expect(rest).toEqual([]);
      expect(account).toMatchObject({
        id: input.accountId,
        email: invitation.email,
        display_name: "Grace Hopper",
        password_hash: PASSWORD_HASH,
        locale: "de",
        is_instance_admin: false,
      });
      expect(account?.email_verified_at).toBeInstanceOf(Date);
      expect((await members(workspaceId))[input.accountId]).toBe(role);
      expect(await invitationRow(invitation.id)).toMatchObject({ status: "accepted", accepted_by: input.accountId });
      expect((await invitationRow(invitation.id)).closed_at).toBeInstanceOf(Date);
      expect(await sessionsOf(input.accountId)).toEqual([
        { id: input.session.id, level: "full", token_hash: sha256(sessionToken), active_workspace_id: workspaceId, ip_prefix: "203.0.0.0/16" },
      ]);
      expect(await workspacesCreatedBy(input.accountId)).toBe(0);
      expect((await auditOf(workspaceId)).filter((event) => event.actor_account_id === input.accountId)).toEqual([
        { action: "member.joined", actor_account_id: input.accountId },
      ]);
      expect((await jobs()).filter((job) => job.data.accountId === input.accountId)).toHaveLength(1);
    }
  });

  it("makes no session for the account of a link an admin took where verification is required, and answers sessionCreated false with everything else written", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { role: "admin" });
    const link = freshToken();
    // How the invitation route issues a link: a new token hash and no mail ticket.
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${link.hash}, mail_ticket = NULL WHERE id = ${invitation.id}`);
    const { input } = acceptance(link.hash, { emailVerificationRequired: true });
    const carried = freshToken();
    const bystander = freshId();
    await seedAccount(db, { id: bystander, email: `bystander${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
        VALUES (${freshId()}, ${carried.hash}, ${bystander}, 'full', false, now() + interval '1 day', now() + interval '1 day')`,
    );

    const result = await store.acceptInvitationWithNewAccount({ ...input, session: { ...input.session, replacedTokenHash: carried.hash } });

    expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role: "admin", sessionCreated: false });
    const [account] = await accountsWithEmail(invitation.email);
    expect(account?.email_verified_at).toBeNull();
    expect((await members(workspaceId))[input.accountId]).toBe("admin");
    expect(await invitationRow(invitation.id)).toMatchObject({ status: "accepted", accepted_by: input.accountId });
    expect(await sessionsOf(input.accountId)).toEqual([]);
    expect(await sessionsOf(bystander)).toHaveLength(1);
    expect((await jobs()).filter((job) => job.data.accountId === input.accountId)).toHaveLength(1);
  });

  it("treats a pending invitation with no mail ticket and link_issued false, as an upgraded copyable link is, as a link an admin took", async () => {
    const workspaceId = await workspaceWithOwner();
    const upgraded = await invite(workspaceId, { role: "admin", mailed: false });
    expect(await invitationRow(upgraded.id)).toMatchObject({ link_issued: false, mail_ticket: null });
    const required = acceptance(upgraded.hash, { emailVerificationRequired: true }).input;

    expect(await store.acceptInvitationWithNewAccount(required)).toEqual({
      kind: "accepted",
      workspaceId,
      invitationId: upgraded.id,
      role: "admin",
      sessionCreated: false,
    });

    expect((await accountsWithEmail(upgraded.email))[0]?.email_verified_at).toBeNull();
    expect(await sessionsOf(required.accountId)).toEqual([]);
    expect((await members(workspaceId))[required.accountId]).toBe("admin");

    const optional = await invite(workspaceId, { mailed: false });
    const notRequired = acceptance(optional.hash, { emailVerificationRequired: false }).input;
    expect(await store.acceptInvitationWithNewAccount(notRequired)).toMatchObject({ kind: "accepted", sessionCreated: true });
    expect((await accountsWithEmail(optional.email))[0]?.email_verified_at).toBeNull();
  });

  it("keeps a link an admin took link-issued after a re-invite gives the row a mail ticket without replacing the token", async () => {
    const workspaceId = await workspaceWithOwner();
    const held = await invite(workspaceId);
    const link = freshToken();
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${link.hash}, mail_ticket = NULL WHERE id = ${held.id}`);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET mail_ticket = ${freshId()} WHERE id = ${held.id}`);
    expect(await invitationRow(held.id)).toMatchObject({ link_issued: true });
    const input = acceptance(link.hash, { emailVerificationRequired: true }).input;

    expect(await store.acceptInvitationWithNewAccount(input)).toMatchObject({ kind: "accepted", sessionCreated: false });
    expect((await accountsWithEmail(held.email))[0]?.email_verified_at).toBeNull();
  });

  it("keeps an upgraded link, whose row held no mail ticket, a link after a re-invite where no mail can be sent gives it one and keeps the token", async () => {
    const workspaceId = await workspaceWithOwner();
    const upgraded = await invite(workspaceId, { role: "admin", mailed: false });
    expect(await invitationRow(upgraded.id)).toMatchObject({ link_issued: false, mail_ticket: null });
    // The write of POST /invitations for a pending address on an instance without mail: a new ticket, the stored hash kept.
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET role = 'member', mail_ticket = ${freshId()} WHERE id = ${upgraded.id}`);
    expect(await invitationRow(upgraded.id)).toMatchObject({ link_issued: true });
    const input = acceptance(upgraded.hash, { emailVerificationRequired: true }).input;

    expect(await store.acceptInvitationWithNewAccount(input)).toMatchObject({ kind: "accepted", role: "member", sessionCreated: false });

    expect((await accountsWithEmail(upgraded.email))[0]?.email_verified_at).toBeNull();
    expect(await sessionsOf(input.accountId)).toEqual([]);
  });

  it("keeps a mailed invitation mailed when a re-invite where no mail can be sent gives it a new ticket and keeps the token", async () => {
    const workspaceId = await workspaceWithOwner();
    const mailed = await invite(workspaceId);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET role = 'admin', mail_ticket = ${freshId()} WHERE id = ${mailed.id}`);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET expires_at = expires_at + interval '1 day' WHERE id = ${mailed.id}`);
    expect(await invitationRow(mailed.id)).toMatchObject({ link_issued: false });
    const input = acceptance(mailed.hash, { emailVerificationRequired: true }).input;

    expect(await store.acceptInvitationWithNewAccount(input)).toMatchObject({ kind: "accepted", role: "admin", sessionCreated: true });

    expect((await accountsWithEmail(mailed.email))[0]?.email_verified_at).not.toBeNull();
  });

  it("signs the account of a link an admin took in where verification is not required, and the account of a mailed token under either setting", async () => {
    const workspaceId = await workspaceWithOwner();
    const held = await invite(workspaceId);
    const link = freshToken();
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${link.hash}, mail_ticket = NULL WHERE id = ${held.id}`);
    const notRequired = acceptance(link.hash, { emailVerificationRequired: false }).input;
    expect(await store.acceptInvitationWithNewAccount(notRequired)).toMatchObject({ kind: "accepted", sessionCreated: true });
    expect(await sessionsOf(notRequired.accountId)).toHaveLength(1);

    for (const emailVerificationRequired of [true, false]) {
      const mailed = await invite(workspaceId);
      const input = acceptance(mailed.hash, { emailVerificationRequired }).input;
      expect(await store.acceptInvitationWithNewAccount(input)).toMatchObject({ kind: "accepted", sessionCreated: true });
      expect(await sessionsOf(input.accountId)).toHaveLength(1);
      expect((await accountsWithEmail(mailed.email))[0]?.email_verified_at).toBeInstanceOf(Date);
    }
  });

  it("keeps the eleven-argument form, which the provider form and replicas of the previous release call, signing in the account of a link an admin took", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    const link = freshToken();
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${link.hash}, mail_ticket = NULL WHERE id = ${invitation.id}`);
    const accountId = freshId();
    const session = freshToken();
    const sessionId = freshId();

    const rows = await db.app.begin(
      (tx) => tx<{ outcome: string }[]>`
        SELECT * FROM sys_invitation_accept_new_account(
          ${link.hash}::bytea, ${accountId}::uuid, 'Grace Hopper', ${PASSWORD_HASH}, 'en', NULL::integer,
          ${sessionId}::uuid, ${session.hash}::bytea, NULL::bytea, '203.0.0.0/16'::cidr, 'tests')`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "accepted" });
    expect(Object.keys(rows[0] ?? {})).toEqual(["outcome", "accepted_workspace_id", "accepted_invitation_id", "accepted_role"]);
    expect(await sessionsOf(accountId)).toEqual([expect.objectContaining({ id: sessionId, level: "full", active_workspace_id: workspaceId })]);
  });

  it("refuses to decide without knowing whether verification is required", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    const session = freshToken();

    await expect(
      db.app.begin(
        (tx) => tx`
          SELECT * FROM sys_invitation_accept_new_account(
            ${invitation.hash}::bytea, ${freshId()}::uuid, 'Grace Hopper', ${PASSWORD_HASH}, 'en', NULL::integer,
            ${freshId()}::uuid, ${session.hash}::bytea, NULL::bytea, '203.0.0.0/16'::cidr, 'tests', NULL::boolean)`,
      ),
    ).rejects.toThrow();
    expect(await invitationRow(invitation.id)).toMatchObject({ status: "pending" });
  });

  it("makes the account of the address the invitation names and no other: the request carries no address", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { email: "Forwarded@Example.test" });
    const before = await accountCount();

    const result = await accept(invitation.hash);

    expect(result.kind).toBe("accepted");
    expect(await accountCount()).toBe(before + 1);
    expect(await accountsWithEmail("forwarded@example.test")).toHaveLength(1);
  });

  it("replaces the session the request carried when it signs the account in", async () => {
    const workspaceId = await workspaceWithOwner();
    const earlier = freshId();
    await seedAccount(db, { id: earlier, email: `earlier${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
    const carried = freshToken();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
        VALUES (${freshId()}, ${carried.hash}, ${earlier}, 'full', false, now() + interval '1 day', now() + interval '1 day')`,
    );
    const invitation = await invite(workspaceId);
    const { input } = acceptance(invitation.hash);

    await store.acceptInvitationWithNewAccount({ ...input, session: { ...input.session, replacedTokenHash: carried.hash } });

    expect(await sessionsOf(earlier)).toEqual([]);
    expect(await sessionsOf(input.accountId)).toHaveLength(1);
  });

  it("creates one account and one membership when parallel requests carry one token, and answers gone to the rest", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { role: "admin" });
    const before = await accountCount();

    const results = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => accept(invitation.hash)));

    expect(results.filter((result) => result.kind === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "gone")).toHaveLength(PARALLEL_CALLS - 1);
    expect(await accountsWithEmail(invitation.email.toLowerCase())).toHaveLength(1);
    expect(await accountCount()).toBe(before + 1);
    expect(Object.values(await members(workspaceId)).sort()).toEqual(["admin", "owner"]);
    expect(await jobs()).toHaveLength(1);
    expect((await invitationRow(invitation.id)).status).toBe("accepted");
  });

  it("refuses a token that was used, and creates nothing the second time", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    await accept(invitation.hash);
    const before = await accountCount();

    expect(await accept(invitation.hash)).toEqual({ kind: "gone" });
    expect(await accountCount()).toBe(before);
  });

  it("answers gone and writes nothing for an unknown token, an expired invitation, a revoked one, a replaced token and a workspace being deleted", async () => {
    const workspaceId = await workspaceWithOwner();
    const expired = await invite(workspaceId, { expiresInSeconds: -1 });
    const revoked = await invite(workspaceId);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${revoked.id}`);
    const replaced = await invite(workspaceId);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${freshToken().hash} WHERE id = ${replaced.id}`);
    const dying = await seedWorkspace(db, { name: "Dying", deletingAt: new Date() });
    const inDying = await invite(dying);
    const before = await accountCount();

    for (const hash of [freshToken().hash, expired.hash, revoked.hash, replaced.hash, inDying.hash]) {
      expect(await accept(hash)).toEqual({ kind: "gone" });
    }

    expect(await accountCount()).toBe(before);
    expect(await members(dying)).toEqual({});
    for (const invitation of [expired, inDying]) {
      expect((await invitationRow(invitation.id)).status).toBe("pending");
    }
  });

  it("answers email_taken for an address an account holds, in any case, creating nothing and leaving the invitation pending for the account that holds it", async () => {
    const workspaceId = await workspaceWithOwner();
    const holder = freshId();
    await seedAccount(db, { id: holder, email: "Holder@Example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const invitation = await invite(workspaceId, { email: "holder@example.TEST" });
    const before = await accountCount();
    const { input } = acceptance(invitation.hash);

    expect(await store.acceptInvitationWithNewAccount(input)).toEqual({ kind: "email_taken" });

    expect(await accountCount()).toBe(before);
    expect(await members(workspaceId)).not.toHaveProperty(input.accountId);
    expect(await sessionsOf(input.accountId)).toEqual([]);
    expect(await invitationRow(invitation.id)).toMatchObject({ status: "pending", accepted_by: null, closed_at: null });
    expect(await jobs()).toEqual([]);
    expect(await auditOf(workspaceId)).toEqual([]);
    const joined = await db.tenant.withTenant({ accountId: holder, requestId: "email-taken-test" }, (tx) => invitationAcceptanceRepository(tx).accept(invitation.hash, null));
    expect(joined).toMatchObject({ kind: "accepted", workspaceId });
  });

  it("answers email_taken for an address that an unused undo token reserves", async () => {
    const workspaceId = await workspaceWithOwner();
    const owner = freshId();
    await seedAccount(db, { id: owner, email: `moved${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO credential_tokens (id, account_id, purpose, token_hash, target_email, expires_at)
        VALUES (${freshId()}, ${owner}, 'email_change_cancel', ${freshToken().hash}, 'reserved@example.test', now() + interval '1 day')`,
    );
    const invitation = await invite(workspaceId, { email: "reserved@example.test" });

    expect(await accept(invitation.hash)).toEqual({ kind: "email_taken" });

    expect(await accountsWithEmail("reserved@example.test")).toEqual([]);
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });

  it("answers seat_limit_reached without creating the account, and lets two requests for the last seat take it once", async () => {
    const workspaceId = await workspaceWithOwner();
    const full = await invite(workspaceId);
    const before = await accountCount();

    expect(await accept(full.hash, { seatLimit: 1 })).toEqual({ kind: "seat_limit_reached" });
    expect(await accountCount()).toBe(before);
    expect((await invitationRow(full.id)).status).toBe("pending");

    const first = await invite(workspaceId);
    const second = await invite(workspaceId);
    const results = await Promise.all([accept(first.hash, { seatLimit: 2 }), accept(second.hash, { seatLimit: 2 })]);

    expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "seat_limit_reached"]);
    expect(Object.keys(await members(workspaceId))).toHaveLength(2);
  });

  it("leaves no account, membership, session or accepted invitation behind when a job cannot be queued", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    const before = await accountCount();
    const { input } = acceptance(invitation.hash, { onAccepted: () => ({ audit: [], jobs: [{ id: freshId(), queue: "event.no.such.queue", data: {} }] }) });

    await expect(store.acceptInvitationWithNewAccount(input)).rejects.toThrow();

    expect(await accountCount()).toBe(before);
    expect(await members(workspaceId)).not.toHaveProperty(input.accountId);
    expect(await sessionsOf(input.accountId)).toEqual([]);
    expect(await invitationRow(invitation.id)).toMatchObject({ status: "pending", accepted_by: null, closed_at: null });
    expect((await accept(invitation.hash)).kind).toBe("accepted");
  });

  it("leaves nothing behind when an audit event names another workspace", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    const before = await accountCount();
    const stray: AuditRecord = prepareAuditRecord(
      { action: "member.joined", workspaceId: freshId(), actor: { type: "system", label: "test" }, entity: { type: "member", id: freshId() }, metadata: { role: "member" }, ipPrefix: null },
      freshId,
    );
    const { input } = acceptance(invitation.hash, { onAccepted: () => ({ audit: [stray], jobs: [] }) });

    await expect(store.acceptInvitationWithNewAccount(input)).rejects.toThrow();

    expect(await accountCount()).toBe(before);
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });

  it("rejects a token hash or a seat limit that cannot be one, writing nothing", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);

    await expect(accept(Buffer.alloc(31))).rejects.toThrow(RangeError);
    await expect(accept(invitation.hash, { seatLimit: -1 })).rejects.toThrow();
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });
});
