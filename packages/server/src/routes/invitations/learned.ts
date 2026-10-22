import type { WorkspaceRole } from "@slugbase/core";

/** What an acceptance run only to learn what its token names found: the inputs of the seat check (doc 01 section 13.1). */
export interface LearnedInvitation {
  readonly workspaceId: string;
  readonly invitationId: string;
  /** The account that accepts: the signed-in one, the one the provider's identity leads to, or the identifier a new account will get. */
  readonly accountId: string;
}

/**
 * Thrown from the transaction of an acceptance that is run with no seat limit only to learn what its token names, to
 * roll that transaction back. The entitlement and the seat limit are then decided before the acceptance that writes.
 */
export class InvitationLearned extends Error {
  readonly learned: LearnedInvitation;
  /** The role the invitation grants, which tells the owner invitation of an instance admin from a member's. */
  readonly role: WorkspaceRole;

  constructor(learned: LearnedInvitation, role: WorkspaceRole) {
    super("the acceptance stopped once the workspace, the invitation and the account were known");
    this.name = "InvitationLearned";
    this.learned = learned;
    this.role = role;
  }
}

/**
 * Whether accepting an invitation that grants `role` needs the workspace to hold `members.invite`. It does not for the
 * owner invitation an instance admin issues, which seats the first owner of a workspace and invites nobody (doc 01
 * section 7.5). An invitation granting the owner role is that one and no other: the CHECK of `workspace_invitations`
 * lets the role exist only on a row with `instance_issued`, a column `slugbase_app` cannot write, and `POST /invitations`
 * does not take the role.
 */
export function needsInviteEntitlement(role: WorkspaceRole): boolean {
  return role !== "owner";
}
