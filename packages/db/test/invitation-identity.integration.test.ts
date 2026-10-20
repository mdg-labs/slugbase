import { prepareAuditRecord, type InvitationIdentityResult } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type NewInvitationIdentity, type NewOidcLoginState } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sha256 } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// sys_invitation_accept_with_identity through AuthStore.acceptInvitationWithIdentity, and the invite intent of
// sys_oidc_state_create and sys_oidc_state_take (doc 05 sections 2.1 and 3.3, doc 02 sections 2.8 and 3.4, doc 10 T1, T19
// and T20). The failure scenarios: a provider that asserts another address than the invited one, or an account that
// does not hold the invited address verified, accepting the invitation, linking the identity or creating an account; an
// account created that the registration policy did not allow, or over an address an unverified account holds; a
// refusal that leaves an identity, an account, a membership, a session or a half-accepted invitation behind; an
// invitation token kept in the handshake record in the clear, or taken twice.

const HOOK_TIMEOUT_MS = 300_000;
const PARALLEL_CALLS = 6;
const QUEUE = "event.member.joined";
const PROVIDER = "idp";

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

const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;

let emailNumber = 0;
let subjectNumber = 0;

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

interface Invitation {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly hash: Buffer;
}

async function invite(workspaceId: string, options: { email?: string; role?: Role; expiresInSeconds?: number } = {}): Promise<Invitation> {
  emailNumber += 1;
  const id = freshId();
  const email = options.email ?? `Invitee${String(emailNumber)}@Example.test`;
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, ${options.role ?? "member"}, ${hash}, now() + ${options.expiresInSeconds ?? 7 * 24 * 60 * 60} * interval '1 second')`,
  );
  return { id, workspaceId, email, hash };
}

async function workspaceWithOwner(): Promise<string> {
  emailNumber += 1;
  const workspaceId = await seedWorkspace(db, { name: "Identity test" });
  const owner = freshId();
  await seedAccount(db, { id: owner, email: `owner${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  return workspaceId;
}

function newSubject(): string {
  subjectNumber += 1;
  return `subject-${String(subjectNumber)}`;
}

async function linkIdentity(accountId: string, subject: string, provider = PROVIDER): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${id}, ${accountId}, ${provider}, ${subject}, 'linked@example.test')`,
  );
  return id;
}

interface Acceptance {
  readonly input: NewInvitationIdentity;
  readonly sessionToken: Buffer;
}

function acceptance(invitation: Pick<Invitation, "hash" | "email">, overrides: Partial<NewInvitationIdentity> = {}): Acceptance {
  const session = freshToken();
  const input: NewInvitationIdentity = {
    tokenHash: invitation.hash,
    provider: PROVIDER,
    subject: newSubject(),
    email: invitation.email,
    identityId: freshId(),
    accountId: freshId(),
    displayName: "Grace Hopper",
    locale: "de",
    mayCreate: true,
    seatLimit: null,
    session: { id: freshId(), tokenHash: session.hash, replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
    onAccepted: ({ workspaceId, role, accountId, displayName, created }) => ({
      audit: [
        prepareAuditRecord(
          {
            action: "member.joined",
            workspaceId,
            actor: { type: "account", accountId, label: displayName },
            entity: { type: "member", id: accountId },
            metadata: { role },
            ipPrefix: "203.0.0.0/16",
          },
          freshId,
        ),
      ],
      jobs: [{ id: freshId(), queue: QUEUE, data: { workspaceId, accountId, role, created } }],
    }),
    ...overrides,
  };
  return { input, sessionToken: session.token };
}

function accept(invitation: Pick<Invitation, "hash" | "email">, overrides: Partial<NewInvitationIdentity> = {}): Promise<InvitationIdentityResult> {
  return store.acceptInvitationWithIdentity(acceptance(invitation, overrides).input);
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  locale: string;
  email_verified_at: Date | null;
  last_sign_in_at: Date | null;
}

async function accountsWithEmail(email: string): Promise<AccountRow[]> {
  return [
    ...(await asSystem(
      db,
      (tx) => tx<AccountRow[]>`SELECT id, email, display_name, password_hash, locale, email_verified_at, last_sign_in_at FROM accounts WHERE email = ${email}`,
    )),
  ];
}

async function accountCount(): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM accounts`);
  return Number(rows[0]?.n);
}

async function identityCount(): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM account_identities`);
  return Number(rows[0]?.n);
}

async function identitiesOf(accountId: string): Promise<{ provider: string; subject: string; email_at_link: string; last_used_at: Date | null }[]> {
  return [
    ...(await asSystem(
      db,
      (tx) => tx<{ provider: string; subject: string; email_at_link: string; last_used_at: Date | null }[]>`
        SELECT provider, subject, email_at_link, last_used_at FROM account_identities WHERE account_id = ${accountId}`,
    )),
  ];
}

async function members(workspaceId: string): Promise<Record<string, string>> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`);
  return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
}

async function invitationRow(id: string): Promise<{ status: string; accepted_by: string | null; closed_at: Date | null }> {
  const rows = await asSystem(db, (tx) => tx<{ status: string; accepted_by: string | null; closed_at: Date | null }[]>`SELECT status, accepted_by, closed_at FROM workspace_invitations WHERE id = ${id}`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

interface SessionSummary {
  id: string;
  level: string;
  token_hash: Buffer;
  active_workspace_id: string | null;
}

async function sessionsOf(accountId: string): Promise<SessionSummary[]> {
  return [...(await asSystem(db, (tx) => tx<SessionSummary[]>`SELECT id, level, token_hash, active_workspace_id FROM sessions WHERE account_id = ${accountId}`))];
}

async function jobs(): Promise<{ id: string; data: Record<string, unknown> }[]> {
  return [...(await db.app<{ id: string; data: Record<string, unknown> }[]>`SELECT id, data FROM pgboss.job ORDER BY id`)];
}

async function auditOf(workspaceId: string): Promise<{ action: string; actor_account_id: string; actor_label: string }[]> {
  return [
    ...(await asSystem(db, (tx) => tx<{ action: string; actor_account_id: string; actor_label: string }[]>`SELECT action, actor_account_id, actor_label FROM audit_events WHERE workspace_id = ${workspaceId}`)),
  ];
}

/** Everything a refused acceptance must leave as it was. */
async function snapshot(invitation: Invitation) {
  return {
    accounts: await accountCount(),
    identities: await identityCount(),
    members: await members(invitation.workspaceId),
    invitation: await invitationRow(invitation.id),
    jobs: await jobs(),
    audit: await auditOf(invitation.workspaceId),
    sessions: (await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM sessions`))[0]?.n,
  };
}

describe("sys_invitation_accept_with_identity", () => {
  it("creates the verified account of the invited address without a password, links the identity, makes it a member with the invited role, accepts the invitation and signs it in with a full session acting in the workspace, writing its audit event and jobs in the same transaction", async () => {
    const workspaceId = await workspaceWithOwner();
    for (const role of ["member", "admin"] as const) {
      const invitation = await invite(workspaceId, { role });
      const { input, sessionToken } = acceptance(invitation);

      const result = await store.acceptInvitationWithIdentity(input);

      expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role, accountId: input.accountId, created: true });
      const [account, ...rest] = await accountsWithEmail(invitation.email.toLowerCase());
      expect(rest).toEqual([]);
      expect(account).toMatchObject({ id: input.accountId, email: invitation.email, display_name: "Grace Hopper", password_hash: null, locale: "de" });
      expect(account?.email_verified_at).toBeInstanceOf(Date);
      expect(await identitiesOf(input.accountId)).toEqual([{ provider: PROVIDER, subject: input.subject, email_at_link: invitation.email, last_used_at: null }]);
      expect((await members(workspaceId))[input.accountId]).toBe(role);
      expect(await invitationRow(invitation.id)).toMatchObject({ status: "accepted", accepted_by: input.accountId });
      expect((await invitationRow(invitation.id)).closed_at).toBeInstanceOf(Date);
      expect(await sessionsOf(input.accountId)).toEqual([{ id: input.session.id, level: "full", token_hash: sha256(sessionToken), active_workspace_id: workspaceId }]);
      expect((await auditOf(workspaceId)).filter((event) => event.actor_account_id === input.accountId)).toEqual([
        { action: "member.joined", actor_account_id: input.accountId, actor_label: "Grace Hopper" },
      ]);
      expect((await jobs()).filter((job) => job.data.accountId === input.accountId)).toHaveLength(1);
    }
  });

  it("signs in and accepts for the account the identity is linked to, creating no account and linking nothing twice", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { email: "Linked.Person@Example.test", role: "admin" });
    const holder = freshId();
    await seedAccount(db, { id: holder, email: "linked.person@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const subject = newSubject();
    await linkIdentity(holder, subject);
    const before = await accountCount();
    const identities = await identityCount();
    const { input, sessionToken } = acceptance(invitation, { subject, email: "linked.person@EXAMPLE.test" });

    const result = await store.acceptInvitationWithIdentity(input);

    expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role: "admin", accountId: holder, created: false });
    expect(await accountCount()).toBe(before);
    expect(await identityCount()).toBe(identities);
    expect((await identitiesOf(holder))[0]?.last_used_at).toBeInstanceOf(Date);
    expect((await members(workspaceId))[holder]).toBe("admin");
    expect(await invitationRow(invitation.id)).toMatchObject({ status: "accepted", accepted_by: holder });
    expect(await sessionsOf(holder)).toEqual([{ id: input.session.id, level: "full", token_hash: sha256(sessionToken), active_workspace_id: workspaceId }]);
    expect((await auditOf(workspaceId)).filter((event) => event.actor_account_id === holder)).toEqual([
      { action: "member.joined", actor_account_id: holder, actor_label: "Test account" },
    ]);
    expect((await jobs()).map((job) => job.data)).toEqual([{ workspaceId, accountId: holder, role: "admin", created: false }]);
  });

  it("links the identity to the enabled account that holds the invited address verified, signs it in and accepts", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { email: "Holder@Example.test" });
    const holder = freshId();
    await seedAccount(db, { id: holder, email: "holder@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const before = await accountCount();
    const { input } = acceptance(invitation, { mayCreate: false });

    const result = await store.acceptInvitationWithIdentity(input);

    expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role: "member", accountId: holder, created: false });
    expect(await accountCount()).toBe(before);
    expect(await identitiesOf(holder)).toMatchObject([{ provider: PROVIDER, subject: input.subject }]);
    expect((await members(workspaceId))[holder]).toBe("member");
    expect(await sessionsOf(holder)).toHaveLength(1);
    expect(await invitationRow(invitation.id)).toMatchObject({ status: "accepted", accepted_by: holder });
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
    const { input } = acceptance(invitation);

    await store.acceptInvitationWithIdentity({ ...input, session: { ...input.session, replacedTokenHash: carried.hash } });

    expect(await sessionsOf(earlier)).toEqual([]);
    expect(await sessionsOf(input.accountId)).toHaveLength(1);
  });

  it("answers email_mismatch and writes nothing when the provider's address is not the invited one, for an account that would be created, for one the address links and for one the identity belongs to", async () => {
    const workspaceId = await workspaceWithOwner();
    const holder = freshId();
    await seedAccount(db, { id: holder, email: "holder.of.invited@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const other = freshId();
    await seedAccount(db, { id: other, email: "somebody.else@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const identified = newSubject();
    await linkIdentity(other, identified);
    const created = await invite(workspaceId, { email: "new.person@example.test" });
    const linked = await invite(workspaceId, { email: "holder.of.invited@example.test" });
    const owned = await invite(workspaceId, { email: "invited.for.other@example.test" });

    for (const [invitation, overrides] of [
      [created, { email: "somebody.else@example.test" }],
      [created, { email: "new.person@example.test.evil" }],
      [linked, { email: "somebody.else@example.test" }],
      [owned, { email: "somebody.else@example.test", subject: identified }],
    ] as const) {
      const before = await snapshot(invitation);

      expect(await accept(invitation, overrides)).toEqual({ kind: "email_mismatch" });

      expect(await snapshot(invitation)).toEqual(before);
    }
  });

  it("answers email_mismatch and writes nothing when the identity belongs to an account that does not hold the invited address, though the provider asserts the invited one", async () => {
    const workspaceId = await workspaceWithOwner();
    const other = freshId();
    await seedAccount(db, { id: other, email: "moved.on@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const subject = newSubject();
    await linkIdentity(other, subject);
    const invitation = await invite(workspaceId, { email: "invited@example.test" });
    const before = await snapshot(invitation);

    expect(await accept(invitation, { subject })).toEqual({ kind: "email_mismatch" });

    expect(await snapshot(invitation)).toEqual(before);
    expect(await sessionsOf(other)).toEqual([]);
  });

  it("answers gone for an identity of a disabled account, and email_taken, creating nothing, when the address is held by an account nobody verified, by a disabled one or by an unused undo token", async () => {
    const workspaceId = await workspaceWithOwner();
    const disabled = freshId();
    await seedAccount(db, { id: disabled, email: "disabled@example.test", passwordHash: "$argon2id$stub", emailVerified: true, disabledAt: new Date() });
    const subject = newSubject();
    await linkIdentity(disabled, subject);
    const unverified = freshId();
    await seedAccount(db, { id: unverified, email: "unverified@example.test", passwordHash: "$argon2id$stub" });
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO credential_tokens (id, account_id, purpose, token_hash, target_email, expires_at)
        VALUES (${freshId()}, ${unverified}, 'email_change_cancel', ${freshToken().hash}, 'reserved@example.test', now() + interval '1 day')`,
    );
    const identityOfDisabled = await invite(workspaceId, { email: "disabled@example.test" });
    const heldUnverified = await invite(workspaceId, { email: "unverified@example.test" });
    const reserved = await invite(workspaceId, { email: "reserved@example.test" });

    let before = await snapshot(identityOfDisabled);
    expect(await accept(identityOfDisabled, { subject })).toEqual({ kind: "gone" });
    expect(await snapshot(identityOfDisabled)).toEqual(before);

    before = await snapshot(identityOfDisabled);
    expect(await accept(identityOfDisabled)).toEqual({ kind: "email_taken" });
    expect(await snapshot(identityOfDisabled)).toEqual(before);

    for (const invitation of [heldUnverified, reserved]) {
      before = await snapshot(invitation);
      expect(await accept(invitation)).toEqual({ kind: "email_taken" });
      expect(await snapshot(invitation)).toEqual(before);
    }
  });

  it("answers not_permitted and writes nothing when an account would have to be created and mayCreate is false", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    const before = await snapshot(invitation);

    expect(await accept(invitation, { mayCreate: false })).toEqual({ kind: "not_permitted" });

    expect(await snapshot(invitation)).toEqual(before);
    expect(await accountsWithEmail(invitation.email.toLowerCase())).toEqual([]);
  });

  it("refuses an account that is a member already and a workspace that has no seat left, writing nothing", async () => {
    const workspaceId = await workspaceWithOwner();
    const holder = freshId();
    await seedAccount(db, { id: holder, email: "member@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    await seedMember(db, { workspaceId, accountId: holder, role: "member" });
    const already = await invite(workspaceId, { email: "member@example.test" });
    const full = await invite(workspaceId, { email: "late@example.test" });

    let before = await snapshot(already);
    expect(await accept(already, { mayCreate: false })).toEqual({ kind: "already_member" });
    expect(await snapshot(already)).toEqual(before);

    before = await snapshot(full);
    expect(await accept(full, { seatLimit: 2 })).toEqual({ kind: "seat_limit_reached" });
    expect(await snapshot(full)).toEqual(before);
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
    const unknown = { hash: freshToken().hash, email: "unknown@example.test" };
    const accounts = await accountCount();
    const identities = await identityCount();

    for (const target of [unknown, expired, revoked, replaced, inDying]) {
      expect(await accept(target)).toEqual({ kind: "gone" });
    }

    expect(await accountCount()).toBe(accounts);
    expect(await identityCount()).toBe(identities);
    expect(await members(dying)).toEqual({});
    for (const invitation of [expired, inDying]) {
      expect((await invitationRow(invitation.id)).status).toBe("pending");
    }
  });

  it("accepts a token once however many callbacks carry it: one account, one identity, one membership", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { role: "admin" });
    const before = await accountCount();

    const results = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => accept(invitation)));

    expect(results.filter((result) => result.kind === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "gone")).toHaveLength(PARALLEL_CALLS - 1);
    expect(await accountsWithEmail(invitation.email.toLowerCase())).toHaveLength(1);
    expect(await accountCount()).toBe(before + 1);
    expect(Object.values(await members(workspaceId)).sort()).toEqual(["admin", "owner"]);
    expect(await jobs()).toHaveLength(1);
  });

  it("leaves nothing behind, and rejects, when an audit event cannot be written after the account, the identity and the session exist", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId);
    const before = await snapshot(invitation);
    const { input } = acceptance(invitation, {
      onAccepted: () => ({ audit: [], jobs: [{ id: freshId(), queue: "event.does.not.exist", data: {} }] }),
    });

    await expect(store.acceptInvitationWithIdentity(input)).rejects.toThrow();

    expect(await snapshot(invitation)).toEqual(before);
    expect(await accountsWithEmail(invitation.email.toLowerCase())).toEqual([]);
    expect(await sessionsOf(input.accountId)).toEqual([]);
  });

  it("answers identity_in_use and undoes the acceptance when the identity went to another account after the lookup", async () => {
    const workspaceId = await workspaceWithOwner();
    const invitation = await invite(workspaceId, { email: "race@example.test" });
    const holder = freshId();
    await seedAccount(db, { id: holder, email: "race@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    const subject = newSubject();
    // The identity is linked by a transaction that has not committed when the acceptance looks, and commits while it waits for the holder's row.
    const other = freshId();
    await seedAccount(db, { id: other, email: "racer@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let linkedInside: () => void = () => undefined;
    const linked = new Promise<void>((resolve) => {
      linkedInside = resolve;
    });
    const racing = db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`SELECT 1 FROM accounts WHERE id = ${holder} FOR UPDATE`;
      await tx`INSERT INTO account_identities (id, account_id, provider, subject, email_at_link) VALUES (${freshId()}, ${other}, ${PROVIDER}, ${subject}, 'racer@example.test')`;
      linkedInside();
      await released;
    });
    await linked;
    const before = await snapshot(invitation);
    const accepting = accept(invitation, { subject, mayCreate: false });
    try {
      await waitUntilWaiting(1, "the acceptance");
    } finally {
      release();
    }
    await racing;

    expect(await accepting).toEqual({ kind: "identity_in_use" });

    expect(await snapshot(invitation)).toEqual({ ...before, identities: before.identities + 1 });
    expect(await sessionsOf(holder)).toEqual([]);
    expect((await members(workspaceId))[holder]).toBeUndefined();
  });
});

describe("the invite intent of the OIDC handshake record", () => {
  function state(overrides: Partial<NewOidcLoginState> = {}): NewOidcLoginState {
    return {
      stateHash: freshToken().hash,
      provider: PROVIDER,
      intent: "invite",
      nonce: "nonce-1",
      codeVerifier: { ciphertext: new Uint8Array([1, 2, 3]), keyId: "key-1" },
      returnTo: "/",
      linkAccountId: null,
      invitationTokenHash: freshToken().hash,
      ...overrides,
    };
  }

  function plainState(overrides: Partial<NewOidcLoginState> = {}): NewOidcLoginState {
    return {
      stateHash: freshToken().hash,
      provider: PROVIDER,
      intent: "login",
      nonce: "nonce-1",
      codeVerifier: { ciphertext: new Uint8Array([1, 2, 3]), keyId: "key-1" },
      returnTo: "/",
      linkAccountId: null,
      ...overrides,
    };
  }

  it("keeps the hash of the invitation token and nothing of the token, and hands it back once", async () => {
    const created = state();
    await store.createOidcLoginState(created);
    const stored = await asSystem(db, (tx) => tx<{ intent: string; invitation_token_hash: Buffer | null }[]>`SELECT intent, invitation_token_hash FROM oidc_login_states WHERE state_hash = ${created.stateHash}`);
    expect(stored).toEqual([{ intent: "invite", invitation_token_hash: created.invitationTokenHash }]);

    const first = await store.consumeOidcLoginState(created.stateHash, PROVIDER);
    expect(first).toMatchObject({ intent: "invite", returnTo: "/", linkAccountId: null, invitationTokenHash: created.invitationTokenHash });
    expect(await store.consumeOidcLoginState(created.stateHash, PROVIDER)).toBeUndefined();
    const left = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM oidc_login_states WHERE state_hash = ${created.stateHash}`);
    expect(left[0]?.n).toBe("0");
  });

  it("hands a state of another provider and an expired state to nobody, taking nothing", async () => {
    const created = state();
    await store.createOidcLoginState(created);
    expect(await store.consumeOidcLoginState(created.stateHash, "other")).toBeUndefined();
    await asSystem(db, (tx) => tx`UPDATE oidc_login_states SET expires_at = now() - interval '1 second' WHERE state_hash = ${created.stateHash}`);
    expect(await store.consumeOidcLoginState(created.stateHash, PROVIDER)).toBeUndefined();
  });

  it("hands the same state to one of many parallel callbacks", async () => {
    const created = state();
    await store.createOidcLoginState(created);

    const taken = await Promise.all(Array.from({ length: PARALLEL_CALLS }, () => store.consumeOidcLoginState(created.stateHash, PROVIDER)));

    expect(taken.filter((record) => record !== undefined)).toHaveLength(1);
  });

  it("refuses an invite intent without a token hash, a token hash on another intent, an invite intent with a link account and a token hash of the wrong length", async () => {
    const link = freshId();
    await seedAccount(db, { id: link, email: "link@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
    await expect(store.createOidcLoginState(plainState({ intent: "invite" }))).rejects.toThrow();
    await expect(store.createOidcLoginState(state({ intent: "login" }))).rejects.toThrow();
    await expect(store.createOidcLoginState(state({ linkAccountId: link }))).rejects.toThrow();
    await expect(store.createOidcLoginState(state({ invitationTokenHash: Buffer.alloc(31, 1) }))).rejects.toThrow();
  });

  it("keeps a login state free of an invitation", async () => {
    const created = plainState();
    await store.createOidcLoginState(created);
    expect(await store.consumeOidcLoginState(created.stateHash, PROVIDER)).toMatchObject({ intent: "login", invitationTokenHash: null });
  });
});
