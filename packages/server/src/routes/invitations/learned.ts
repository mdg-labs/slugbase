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

  constructor(learned: LearnedInvitation) {
    super("the acceptance stopped once the workspace, the invitation and the account were known");
    this.name = "InvitationLearned";
    this.learned = learned;
  }
}
