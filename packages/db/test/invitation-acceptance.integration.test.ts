import { createHash } from "node:crypto";
import type { InvitationAcceptResult } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationAcceptanceRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// sys_invitation_inspect and sys_invitation_accept through invitationAcceptanceRepository (doc 05 section 3.3, doc 02
// section 3.4, doc 04 section 10.5, doc 10 T1 and T19). The failure scenarios: a token that accepts twice, under
// parallel requests or after a resend; one that accepts after its expiry, its revocation or the deletion of its
// workspace; one that accepts for an account whose verified address is not the invited one, an unverified account
// holding the address included; a membership with a role other than the invited one; two acceptances that take the
// last seat; a refusal that leaves a membership, an accepted invitation or a half-written state behind; and an
// inspection that tells an unknown token from an expired or revoked one.

const HOOK_TIMEOUT_MS = 300_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(options: { email?: string; verified?: boolean; disabled?: boolean } = {}): Promise<{ id: string; email: string }> {
  emailNumber += 1;
  const id = freshId();
  const email = options.email ?? `accept${String(emailNumber)}@example.test`;
  await seedAccount(db, { id, email, passwordHash: "$argon2id$stub", emailVerified: options.verified ?? true, disabledAt: options.disabled === true ? new Date() : null });
  return { id, email };
}

interface Invitation {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly token: Buffer;
  readonly hash: Buffer;
}

async function invite(
  workspaceId: string,
  email: string,
  options: { role?: Role; expiresInSeconds?: number; invitedBy?: string | null; instanceIssued?: boolean } = {},
): Promise<Invitation> {
  const id = freshId();
  const { token, hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, invited_by, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, ${options.role ?? "member"}, ${options.instanceIssued ?? false}, ${hash}, ${options.invitedBy ?? null},
              now() + ${options.expiresInSeconds ?? 7 * 24 * 60 * 60} * interval '1 second')`,
  );
  return { id, workspaceId, email, token, hash };
}

async function workspaceWithOwner(): Promise<{ workspaceId: string; owner: string }> {
  const workspaceId = await seedWorkspace(db, { name: "Acceptance test" });
  const owner = await account();
  await seedMember(db, { workspaceId, accountId: owner.id, role: "owner" });
  return { workspaceId, owner: owner.id };
}

function accept(accountId: string, hash: Buffer, seatLimit: number | null = null): Promise<InvitationAcceptResult> {
  return db.tenant.withTenant({ accountId, requestId: "acceptance-test" }, (tx) => invitationAcceptanceRepository(tx).accept(hash, seatLimit));
}

interface InvitationRow {
  status: string;
  accepted_by: string | null;
  closed_at: Date | null;
  role: string;
}

async function invitationRow(id: string): Promise<InvitationRow> {
  const rows = await asSystem(db, (tx) => tx<InvitationRow[]>`SELECT status, accepted_by, closed_at, role::text AS role FROM workspace_invitations WHERE id = ${id}`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

async function members(workspaceId: string): Promise<Record<string, string>> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`);
  return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
}

interface PreviewRow {
  workspace_name: string;
  inviter_name: string | null;
  invited_email: string;
  invited_role: string;
  account_exists: boolean;
}

async function inspect(hash: Buffer): Promise<PreviewRow[]> {
  return [...(await db.app<PreviewRow[]>`SELECT * FROM sys_invitation_inspect(${hash}::bytea)`)];
}

describe("sys_invitation_accept", () => {
  it("adds the account with exactly the invited role, marks the invitation accepted by it and closed in the same statement, and names the workspace, the invitation and the role", async () => {
    const { workspaceId, owner } = await workspaceWithOwner();
    for (const role of ["member", "admin"] as const) {
      const invitee = await account();
      const invitation = await invite(workspaceId, invitee.email, { role, invitedBy: owner });

      const result = await accept(invitee.id, invitation.hash);

      expect(result).toEqual({ kind: "accepted", workspaceId, invitationId: invitation.id, role });
      expect((await members(workspaceId))[invitee.id]).toBe(role);
      const row = await invitationRow(invitation.id);
      expect(row).toMatchObject({ status: "accepted", accepted_by: invitee.id });
      expect(row.closed_at).toBeInstanceOf(Date);
    }
  });

  it("gives the owner role to an invitation that the instance issued for it, and to none other", async () => {
    const workspaceId = await seedWorkspace(db, { name: "Ownerless" });
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, { role: "owner", instanceIssued: true });

    expect(await accept(invitee.id, invitation.hash)).toMatchObject({ kind: "accepted", role: "owner" });
    expect(await members(workspaceId)).toEqual({ [invitee.id]: "owner" });
  });

  it("accepts a token at most once under parallel requests: one membership, one accepted invitation, the rest gone", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, { role: "admin" });

    const results = await Promise.all(Array.from({ length: 8 }, () => accept(invitee.id, invitation.hash)));

    expect(results.filter((result) => result.kind === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "gone")).toHaveLength(7);
    expect(Object.entries(await members(workspaceId)).filter(([id]) => id === invitee.id)).toEqual([[invitee.id, "admin"]]);
    expect((await invitationRow(invitation.id)).status).toBe("accepted");
  });

  it("refuses a token that was accepted already, also to the account that accepted it", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email);
    await accept(invitee.id, invitation.hash);

    expect(await accept(invitee.id, invitation.hash)).toEqual({ kind: "gone" });
  });

  it("refuses an expired invitation by the database's clock, writing nothing", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, { expiresInSeconds: -1 });

    expect(await accept(invitee.id, invitation.hash)).toEqual({ kind: "gone" });
    expect(await members(workspaceId)).not.toHaveProperty(invitee.id);
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });

  it("refuses an invitation revoked before the acceptance, and a token that a newer one replaced", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const revoked = await invite(workspaceId, invitee.email);
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${revoked.id}`);

    expect(await accept(invitee.id, revoked.hash)).toEqual({ kind: "gone" });

    const other = await account();
    const resent = await invite(workspaceId, other.email);
    const replacement = freshToken();
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${replacement.hash} WHERE id = ${resent.id}`);

    expect(await accept(other.id, resent.hash)).toEqual({ kind: "gone" });
    expect(await accept(other.id, replacement.hash)).toMatchObject({ kind: "accepted" });
    expect(Object.keys(await members(workspaceId))).not.toContain(invitee.id);
  });

  it("refuses an unknown token and an invitation of a workspace being deleted, writing nothing", async () => {
    const invitee = await account();
    const dying = await seedWorkspace(db, { name: "Dying", deletingAt: new Date() });
    const invitation = await invite(dying, invitee.email);

    expect(await accept(invitee.id, freshToken().hash)).toEqual({ kind: "gone" });
    expect(await accept(invitee.id, invitation.hash)).toEqual({ kind: "gone" });
    expect(await members(dying)).toEqual({});
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });

  it("refuses an account whose address is not the invited one, one whose address is unverified and one that is disabled, and leaves the invitation pending for the right account", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account({ verified: false });
    const stranger = await account();
    const disabled = await account({ email: "disabled-invitee@example.test", disabled: true });
    const invitation = await invite(workspaceId, invitee.email, { role: "admin" });
    const forDisabled = await invite(workspaceId, disabled.email);

    expect(await accept(stranger.id, invitation.hash)).toEqual({ kind: "email_mismatch" });
    expect(await accept(invitee.id, invitation.hash)).toEqual({ kind: "email_mismatch" });
    expect(await accept(disabled.id, forDisabled.hash)).toEqual({ kind: "gone" });
    expect(Object.keys(await members(workspaceId))).toHaveLength(1);
    expect((await invitationRow(invitation.id)).status).toBe("pending");

    await asSystem(db, (tx) => tx`UPDATE accounts SET email_verified_at = now() WHERE id = ${invitee.id}`);
    expect(await accept(invitee.id, invitation.hash)).toMatchObject({ kind: "accepted", role: "admin" });
  });

  it("compares the addresses without regard to case", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account({ email: "Mixed.Case@Example.test" });
    const invitation = await invite(workspaceId, "mixed.case@example.TEST");

    expect(await accept(invitee.id, invitation.hash)).toMatchObject({ kind: "accepted" });
  });

  it("answers already_member for a member and leaves the invitation pending", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email, { role: "admin" });
    await seedMember(db, { workspaceId, accountId: invitee.id, role: "member" });

    // a member is told so before the seats are counted
    expect(await accept(invitee.id, invitation.hash, 0)).toEqual({ kind: "already_member" });
    expect(await accept(invitee.id, invitation.hash)).toEqual({ kind: "already_member" });
    expect((await members(workspaceId))[invitee.id]).toBe("member");
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });

  it("takes the seat limit as an argument, counts the members under the lock of the workspace and lets none through at the limit", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const first = await account();
    const second = await account();
    const firstInvitation = await invite(workspaceId, first.email);
    const secondInvitation = await invite(workspaceId, second.email);

    // one member, a limit of two: exactly one of two parallel acceptances takes the last seat
    const results = await Promise.all([accept(first.id, firstInvitation.hash, 2), accept(second.id, secondInvitation.hash, 2)]);

    expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "seat_limit_reached"]);
    expect(Object.keys(await members(workspaceId))).toHaveLength(2);
    const firstRefused = results[0].kind === "seat_limit_reached";
    const refused = firstRefused ? firstInvitation : secondInvitation;
    const refusedAccount = firstRefused ? first : second;
    expect((await invitationRow(refused.id)).status).toBe("pending");
    expect(await accept(refusedAccount.id, refused.hash, null)).toMatchObject({ kind: "accepted" });
    expect(Object.keys(await members(workspaceId))).toHaveLength(3);
  });

  it("checks the address before the seats", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const stranger = await account();
    const invitation = await invite(workspaceId, invitee.email);

    expect(await accept(stranger.id, invitation.hash, 0)).toEqual({ kind: "email_mismatch" });
    expect(await accept(invitee.id, invitation.hash, 0)).toEqual({ kind: "seat_limit_reached" });
  });

  it("refuses an account other than the one the transaction acts for, and a hash or a limit that is not valid", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const other = await account();
    const invitation = await invite(workspaceId, invitee.email);

    const forged = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${other.id}, true)`;
      return tx<{ outcome: string }[]>`SELECT outcome FROM sys_invitation_accept(${invitation.hash}::bytea, ${invitee.id}::uuid, NULL)`;
    });

    expect(forged[0]?.outcome).toBe("gone");
    expect(Object.keys(await members(workspaceId))).not.toContain(invitee.id);
    await expect(db.app`SELECT * FROM sys_invitation_accept(${Buffer.alloc(31)}::bytea, ${invitee.id}::uuid, NULL)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT * FROM sys_invitation_accept(${invitation.hash}::bytea, ${invitee.id}::uuid, -1)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT * FROM sys_invitation_accept(${invitation.hash}::bytea, NULL, NULL)`).rejects.toMatchObject({ code: "22023" });
  });

  it("is not reachable by the application role as a way to change a row directly: slugbase_app cannot turn an invitation accepted or insert a member", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const invitation = await invite(workspaceId, invitee.email);

    const asInvitee = <T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${invitee.id}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
        return { value: await work(tx) };
      }).then((result) => result.value);

    await expect(asInvitee((tx) => tx`UPDATE workspace_invitations SET status = 'accepted' WHERE id = ${invitation.id}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asInvitee((tx) => tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceId}, ${invitee.id}, 'member')`)).rejects.toMatchObject({
      code: "42501",
    });
    expect((await invitationRow(invitation.id)).status).toBe("pending");
  });
});

describe("sys_invitation_inspect", () => {
  it("answers the workspace's name, the inviter's name, the address, the role and whether an account holds the address", async () => {
    const { workspaceId, owner } = await workspaceWithOwner();
    const known = await account();
    const forKnown = await invite(workspaceId, known.email, { role: "admin", invitedBy: owner });
    const forNobody = await invite(workspaceId, "nobody-yet@example.test", { invitedBy: owner });

    expect(await inspect(forKnown.hash)).toEqual([
      { workspace_name: "Acceptance test", inviter_name: "Test account", invited_email: known.email, invited_role: "admin", account_exists: true },
    ]);
    expect(await inspect(forNobody.hash)).toEqual([
      { workspace_name: "Acceptance test", inviter_name: "Test account", invited_email: "nobody-yet@example.test", invited_role: "member", account_exists: false },
    ]);
  });

  it("answers a null inviter once the inviting account is gone", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitation = await invite(workspaceId, "orphan@example.test");

    expect((await inspect(invitation.hash))[0]?.inviter_name).toBeNull();
  });

  it("answers no row for an unknown, accepted, revoked, expired or replaced token, a workspace being deleted and a hash of the wrong length, which are not told apart", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitee = await account();
    const accepted = await invite(workspaceId, invitee.email);
    await accept(invitee.id, accepted.hash);
    const revoked = await invite(workspaceId, "revoked@example.test");
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${revoked.id}`);
    const expired = await invite(workspaceId, "expired@example.test", { expiresInSeconds: -1 });
    const replaced = await invite(workspaceId, "replaced@example.test");
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${createHash("sha256").update("new").digest()} WHERE id = ${replaced.id}`);
    const dying = await seedWorkspace(db, { name: "Dying", deletingAt: new Date() });
    const inDying = await invite(dying, "dying@example.test");

    for (const hash of [freshToken().hash, accepted.hash, revoked.hash, expired.hash, replaced.hash, inDying.hash, Buffer.alloc(31)]) {
      expect(await inspect(hash)).toEqual([]);
    }
    expect(await inspect((await invite(workspaceId, "still-pending@example.test")).hash)).toHaveLength(1);
  });

  it("changes nothing", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const invitation = await invite(workspaceId, "unchanged@example.test");
    const before = await invitationRow(invitation.id);

    await inspect(invitation.hash);

    expect(await invitationRow(invitation.id)).toEqual(before);
    expect(await inspect(invitation.hash)).toHaveLength(1);
  });
});
