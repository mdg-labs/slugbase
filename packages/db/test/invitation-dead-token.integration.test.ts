import type { InvitationAcceptResult } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationAcceptanceRepository } from "../src/index.ts";
import { tenantHandle } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// A token that was issued and is now dead (expired, revoked or used) is answered through the same work as a token
// nobody issued: sys_invitation_accept and sys_invitation_accept_new_account decide 'gone' from the invitation row
// alone, before they take the lock of the workspace (doc 05 section 3.3, doc 10 T8 and T19). The failure scenario:
// a dead token takes the workspace lock before it is refused, so a holder of a real dead token measures a longer
// answer than for an unknown one. A holder keeps the workspace row locked, so an answer that waited for that lock
// would fail the lock timeout instead of coming back, and no timing is measured.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const LOCK_NOT_AVAILABLE = "55P03";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface Fixture {
  readonly workspaceId: string;
  readonly owner: string;
  readonly inviteeId: string;
  readonly inviteeEmail: string;
}

async function fixture(): Promise<Fixture> {
  const owner = freshId();
  const inviteeId = freshId();
  const inviteeEmail = `dead-token-${inviteeId}@example.test`;
  await seedAccount(db, { id: owner, email: `dead-token-owner-${owner}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  await seedAccount(db, { id: inviteeId, email: inviteeEmail, passwordHash: "$argon2id$stub", emailVerified: true });
  const workspaceId = await seedWorkspace(db, { name: "Dead token" });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  return { workspaceId, owner, inviteeId, inviteeEmail };
}

type Dying = "expired" | "revoked" | "used";

async function invite(f: Fixture, email: string, dying?: Dying): Promise<{ id: string; hash: Buffer }> {
  const id = freshId();
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${id}, ${f.workspaceId}, ${email}, 'member', ${hash}, ${f.owner},
              now() + ${dying === "expired" ? -1 : 3600} * interval '1 second')`,
  );
  if (dying === "revoked") {
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${id}`);
  }
  if (dying === "used") {
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'accepted', accepted_by = ${f.owner}, closed_at = now() WHERE id = ${id}`);
  }
  return { id, hash };
}

async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilWaiting(what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) < 1) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Holds the workspace row locked, as an acceptance into it does, until `release` is called, after `whileHeld` ran. */
async function holdingWorkspace<T>(workspaceId: string, whileHeld: (release: () => void, holder: Promise<void>) => Promise<T>): Promise<T> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held: () => void = () => undefined;
  const workspaceHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR NO KEY UPDATE`;
    held();
    await released;
  });
  const holderDone = holder.then(() => undefined);
  await workspaceHeld;
  try {
    return await whileHeld(release, holderDone);
  } finally {
    release();
    await holderDone;
  }
}

function acceptSignedIn(accountId: string, hash: Buffer, lockTimeout: string): Promise<InvitationAcceptResult> {
  return db.tenant.withTenant({ accountId, requestId: "dead-token-test" }, async (tx) => {
    await tenantHandle(tx).execute(sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`);
    return invitationAcceptanceRepository(tx).accept(hash, null);
  });
}

interface SignupRow {
  outcome: string;
}

function acceptWithNewAccount(hash: Buffer, lockTimeout: string): Promise<readonly SignupRow[]> {
  const accountId = freshId();
  const session = freshToken();
  return db.app.begin(async (tx) => {
    await tx`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
    return tx<SignupRow[]>`
      SELECT outcome FROM sys_invitation_accept_new_account(
        ${hash}::bytea, ${accountId}::uuid, 'Grace Hopper', ${PASSWORD_HASH}, 'en', NULL::integer,
        ${freshId()}::uuid, ${session.hash}::bytea, NULL::bytea, '203.0.0.0/16'::cidr, 'tests')`;
  });
}

function lockNotAvailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return code === LOCK_NOT_AVAILABLE || lockNotAvailable(cause);
}

async function refusedByLockTimeout(work: Promise<unknown>): Promise<boolean> {
  try {
    await work;
    return false;
  } catch (error) {
    return lockNotAvailable(error);
  }
}

const DEAD: readonly Dying[] = ["expired", "revoked", "used"];

describe("sys_invitation_accept", () => {
  it.each(DEAD)("answers an %s token without waiting for the workspace lock, which a pending token waits for", async (dying) => {
    const f = await fixture();
    const dead = await invite(f, f.inviteeEmail, dying);
    const unknown = freshToken().hash;
    const pending = await invite(f, `pending-${f.inviteeEmail}`);

    await holdingWorkspace(f.workspaceId, async () => {
      expect(await acceptSignedIn(f.inviteeId, unknown, "2s")).toEqual({ kind: "gone" });
      expect(await acceptSignedIn(f.inviteeId, dead.hash, "2s")).toEqual({ kind: "gone" });
      expect(await refusedByLockTimeout(acceptSignedIn(f.inviteeId, pending.hash, "300ms"))).toBe(true);
    });
  }, TEST_TIMEOUT_MS);

  it("refuses a token that is revoked while its acceptance waits for the workspace lock, and leaves it revoked", async () => {
    const f = await fixture();
    const invitation = await invite(f, f.inviteeEmail);

    await holdingWorkspace(f.workspaceId, async (release, holder) => {
      const accepting = acceptSignedIn(f.inviteeId, invitation.hash, "20s").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitUntilWaiting("the acceptance");
      await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${invitation.id}`);
      release();
      await holder;
      expect(await accepting).toEqual({ value: { kind: "gone" } });
    });

    const rows = await asSystem(db, (tx) => tx<{ status: string }[]>`SELECT status FROM workspace_invitations WHERE id = ${invitation.id}`);
    expect(rows).toEqual([{ status: "revoked" }]);
    const members = await asSystem(db, (tx) => tx<{ account_id: string }[]>`SELECT account_id FROM workspace_members WHERE workspace_id = ${f.workspaceId} AND account_id = ${f.inviteeId}`);
    expect(members).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

describe("sys_invitation_accept_new_account", () => {
  it.each(DEAD)("answers an %s token without waiting for the workspace lock, which a pending token waits for", async (dying) => {
    const f = await fixture();
    const dead = await invite(f, `new-${f.inviteeEmail}`, dying);
    const unknown = freshToken().hash;
    const pending = await invite(f, `new-pending-${f.inviteeEmail}`);

    await holdingWorkspace(f.workspaceId, async () => {
      expect(await acceptWithNewAccount(unknown, "2s")).toEqual([{ outcome: "gone" }]);
      expect(await acceptWithNewAccount(dead.hash, "2s")).toEqual([{ outcome: "gone" }]);
      expect(await refusedByLockTimeout(acceptWithNewAccount(pending.hash, "300ms"))).toBe(true);
    });
  }, TEST_TIMEOUT_MS);
});
