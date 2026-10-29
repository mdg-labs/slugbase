import type { InvitationAcceptResult } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthStore, invitationAcceptanceRepository, type AuthStore, type NewInvitationAccount } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The teams an invitation carries, joined by sys_invitation_accept and sys_invitation_accept_new_account (doc 05 sections 2.2 and
// 3.3, doc 02 sections 3.4 and 4, doc 10 T1 and T19). The failure scenario: an invitation created in workspace A that carries the
// identifier of a team of workspace B joins no team and answers like an invitation without teams, so it does not tell that the team
// exists; and a team deleted between the invitation and its acceptance, or while the acceptance waits for it, neither fails the
// acceptance nor leaves a membership behind. The accepted membership has exactly the invited role and a token still accepts once.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
const QUEUE = "event.member.joined";

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

async function account(email?: string): Promise<{ id: string; email: string }> {
  emailNumber += 1;
  const id = freshId();
  const address = email ?? `invitee-teams${String(emailNumber)}@example.test`;
  await seedAccount(db, { id, email: address, passwordHash: "$argon2id$stub", emailVerified: true });
  return { id, email: address };
}

interface Scene {
  readonly workspaceId: string;
  readonly owner: string;
}

async function scene(): Promise<Scene> {
  const workspaceId = await seedWorkspace(db, { name: "Invitation teams test" });
  const owner = await account();
  await seedMember(db, { workspaceId, accountId: owner.id, role: "owner" });
  return { workspaceId, owner: owner.id };
}

async function seedTeam(workspaceId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO teams (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${name})`);
  return id;
}

async function invite(workspaceId: string, email: string, teamIds: readonly string[], role: "admin" | "member" = "member"): Promise<{ id: string; hash: Buffer }> {
  const id = freshId();
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, team_ids, token_hash, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, ${role}, ${`{${teamIds.join(",")}}`}::uuid[], ${hash}, now() + interval '1 day')`,
  );
  return { id, hash };
}

function accept(accountId: string, hash: Buffer, seatLimit: number | null = null): Promise<InvitationAcceptResult> {
  return db.tenant.withTenant({ accountId, requestId: "invitation-teams-test" }, (tx) => invitationAcceptanceRepository(tx).accept(hash, seatLimit));
}

async function teamsOf(accountId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ team_id: string }[]>`SELECT team_id FROM team_members WHERE account_id = ${accountId} ORDER BY team_id`);
  return rows.map((row) => row.team_id);
}

async function roleOf(workspaceId: string, accountId: string): Promise<string | undefined> {
  const rows = await asSystem(db, (tx) => tx<{ role: string }[]>`SELECT role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`);
  return rows[0]?.role;
}

async function statusOf(invitationId: string): Promise<string | undefined> {
  const rows = await asSystem(db, (tx) => tx<{ status: string }[]>`SELECT status FROM workspace_invitations WHERE id = ${invitationId}`);
  return rows[0]?.status;
}

function newAccountInput(hash: Buffer, accountId: string): NewInvitationAccount {
  const session = freshToken();
  return {
    tokenHash: hash,
    accountId,
    displayName: "Grace Hopper",
    passwordHash: PASSWORD_HASH,
    locale: "de",
    seatLimit: null,
    session: { id: freshId(), tokenHash: session.hash, replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
    onAccepted: () => ({ audit: [], jobs: [] }),
  };
}

function settle<T>(work: Promise<T>): Promise<{ readonly value: T } | { readonly error: unknown }> {
  return work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

interface Holder {
  readonly pid: number;
  readonly release: () => void;
  readonly done: Promise<void>;
}

/** Runs `work` in a transaction of slugbase_system that stays open until released. */
async function holder(work: (tx: Parameters<Parameters<typeof asSystem>[1]>[0]) => Promise<unknown>): Promise<Holder> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const readied = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let pid = 0;
  const done = db.owner
    .begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      pid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? 0;
      await work(tx);
      ready();
      await released;
    })
    .then(() => undefined);
  await Promise.race([readied, done]);
  return { pid, release, done };
}

async function waitingPids(): Promise<number[]> {
  const rows = await db.app<{ pid: number }[]>`
    SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database() ORDER BY l.pid`;
  return rows.map((row) => row.pid);
}

async function waitUntilBlockedBy(holderPid: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  for (;;) {
    for (const pid of await waitingPids()) {
      const rows = await db.app<{ pids: number[] }[]>`SELECT pg_blocking_pids(${pid}) AS pids`;
      if (rows[0]?.pids.includes(holderPid) === true) {
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for the holder`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe("sys_invitation_accept with teams", () => {
  it("joins the invited teams in the transaction of the membership, with exactly the invited role", async () => {
    const { workspaceId, owner } = await scene();
    const design = await seedTeam(workspaceId, "Design");
    const support = await seedTeam(workspaceId, "Support");
    await seedTeam(workspaceId, "Untouched");
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, [design, support, design], "member");

    const result = await accept(invitee.id, invitation.hash);

    expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role: "member" });
    expect(await roleOf(workspaceId, invitee.id)).toBe("member");
    expect(await teamsOf(invitee.id)).toEqual([design, support].sort());
    expect(await teamsOf(owner)).toEqual([]);
  });

  it("joins no team and answers as it does for an invitation without teams when the invitation carries a team of another workspace", async () => {
    const mine = await scene();
    const theirs = await scene();
    const theirTeam = await seedTeam(theirs.workspaceId, "Theirs");
    const myTeam = await seedTeam(mine.workspaceId, "Mine");
    const withForeign = await account();
    const plain = await account();
    const foreignInvitation = await invite(mine.workspaceId, withForeign.email, [theirTeam, myTeam]);
    const plainInvitation = await invite(mine.workspaceId, plain.email, []);

    const foreign = await accept(withForeign.id, foreignInvitation.hash);
    const without = await accept(plain.id, plainInvitation.hash);

    expect(foreign).toMatchObject({ kind: "accepted", workspaceId: mine.workspaceId, role: "member" });
    expect(without).toMatchObject({ kind: "accepted", workspaceId: mine.workspaceId, role: "member" });
    // The team of the other workspace is not joined, and the one of this workspace is.
    expect(await teamsOf(withForeign.id)).toEqual([myTeam]);
    const rows = await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM team_members WHERE team_id = ${theirTeam}`);
    expect(rows[0]?.n).toBe(0);
    expect(await roleOf(theirs.workspaceId, withForeign.id)).toBeUndefined();
  });

  it("skips a team deleted since the invitation and joins the others", async () => {
    const { workspaceId } = await scene();
    const kept = await seedTeam(workspaceId, "Kept");
    const lost = await seedTeam(workspaceId, "Lost");
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, [lost, kept]);
    await asSystem(db, (tx) => tx`DELETE FROM teams WHERE id = ${lost}`);

    expect(await accept(invitee.id, invitation.hash)).toMatchObject({ kind: "accepted" });
    expect(await teamsOf(invitee.id)).toEqual([kept]);
  });

  it("is not failed by a team whose deletion is still open when the acceptance reaches it, and joins no team that the deletion removes", async () => {
    const { workspaceId } = await scene();
    const kept = await seedTeam(workspaceId, "Kept");
    const lost = await seedTeam(workspaceId, "Lost");
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, [lost, kept]);
    const deleting = await holder((tx) => tx`DELETE FROM teams WHERE id = ${lost}`);
    try {
      const accepting = settle(accept(invitee.id, invitation.hash));
      await waitUntilBlockedBy(deleting.pid, "the acceptance");
      deleting.release();

      expect(await accepting).toMatchObject({ value: { kind: "accepted", workspaceId } });
    } finally {
      deleting.release();
    }
    await deleting.done;
    expect(await teamsOf(invitee.id)).toEqual([kept]);
    expect(await statusOf(invitation.id)).toBe("accepted");
  }, TEST_TIMEOUT_MS);

  it("leaves no team membership behind when the acceptance is refused, and accepts the token once", async () => {
    const { workspaceId } = await scene();
    const team = await seedTeam(workspaceId, "Refused");
    const right = await account();
    const wrong = await account();
    const invitation = await invite(workspaceId, right.email, [team]);

    expect(await accept(wrong.id, invitation.hash)).toEqual({ kind: "email_mismatch" });
    expect(await teamsOf(wrong.id)).toEqual([]);
    expect(await statusOf(invitation.id)).toBe("pending");

    expect(await accept(right.id, invitation.hash)).toMatchObject({ kind: "accepted" });
    expect(await accept(right.id, invitation.hash)).toEqual({ kind: "gone" });
    expect(await teamsOf(right.id)).toEqual([team]);
  });
});

describe("sys_invitation_accept_new_account with teams", () => {
  it("creates the account, its membership with the invited role and its team memberships together, and skips a team of another workspace", async () => {
    const mine = await scene();
    const theirs = await scene();
    const design = await seedTeam(mine.workspaceId, "Design");
    const theirTeam = await seedTeam(theirs.workspaceId, "Theirs");
    emailNumber += 1;
    const email = `new-account-teams${String(emailNumber)}@example.test`;
    const invitation = await invite(mine.workspaceId, email, [theirTeam, design], "admin");
    const accountId = freshId();

    const result = await store.acceptInvitationWithNewAccount(newAccountInput(invitation.hash, accountId));

    expect(result).toMatchObject({ kind: "accepted", workspaceId: mine.workspaceId, role: "admin" });
    expect(await roleOf(mine.workspaceId, accountId)).toBe("admin");
    expect(await teamsOf(accountId)).toEqual([design]);
  });

  it("skips a team deleted since the invitation", async () => {
    const { workspaceId } = await scene();
    const lost = await seedTeam(workspaceId, "Lost");
    emailNumber += 1;
    const email = `new-account-lost${String(emailNumber)}@example.test`;
    const invitation = await invite(workspaceId, email, [lost]);
    await asSystem(db, (tx) => tx`DELETE FROM teams WHERE id = ${lost}`);
    const accountId = freshId();

    expect(await store.acceptInvitationWithNewAccount(newAccountInput(invitation.hash, accountId))).toMatchObject({ kind: "accepted" });
    expect(await teamsOf(accountId)).toEqual([]);
    expect(await roleOf(workspaceId, accountId)).toBe("member");
  });
});
