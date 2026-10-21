// The enforcement points of doc 01 section 7.5 (doc 10 T11) that are implemented, and the test that holds each one.
// `stage-9` points are the operations that declare an entitlement in their contract, which the authorization stage
// decides before the handler runs; `handler` points are decided by the handler because the operation names its
// workspace only through a credential in the request (an invitation token). A point enters this list in the commit that
// implements it, with its test; `enforcement-points.test.ts` fails for a declared entitlement that is missing here and
// for a point whose test file does not name its operation.

export interface EnforcementPoint {
  readonly operationId: string;
  readonly entitlement: string;
  readonly decidedBy: "stage-9" | "handler";
  /** The test file, relative to `packages/server/test/entitlements/`, that exercises the refusal and the grant of this operation. */
  readonly test: string;
}

const DECLARED = "declared-entitlements.integration.test.ts";
const INVITATIONS = "invitation-enforcement.integration.test.ts";

export const ENFORCEMENT_POINTS: readonly EnforcementPoint[] = [
  { operationId: "createInvitation", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "listInvitations", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "resendInvitation", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "createInvitationLink", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "acceptInvitation", entitlement: "members.invite", decidedBy: "handler", test: INVITATIONS },
];
