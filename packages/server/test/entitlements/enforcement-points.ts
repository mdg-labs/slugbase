// The enforcement points of doc 01 section 7.5 (doc 10 T11) that are implemented, and the test that holds each one.
// `stage-9` points are the operations that declare an entitlement in their contract, which the authorization stage
// decides before the handler runs; `handler` points are decided by the handler because the operation names its
// workspace only through a credential in the request (an invitation token), or because the limit is a count of the
// account's own rows that must be taken under a lock in the transaction that writes (`workspaces.ownMax`), or a count of
// the workspace's members that the acceptance counts under the workspace's lock (`seats.max`), or a count of the workspace's bookmarks
// that the creation takes under the workspace's lock (`bookmarks.max`), or because which of two entitlements a request needs follows the kind of
// target in it (`sharing.members` for a member, `sharing.teams` for a team). A point that
// leaves one kind of request out of its entitlement records that in `exemption`. A point enters this list in the commit that
// implements it, with its test; `enforcement-points.test.ts` fails for a declared entitlement that is missing here and
// for a point whose test file does not name its operation.

export interface EnforcementPoint {
  readonly operationId: string;
  readonly entitlement: string;
  readonly decidedBy: "stage-9" | "handler";
  /** The test file, relative to `packages/server/test/entitlements/`, that exercises the refusal and the grant of this operation. */
  readonly test: string;
  /** The requests this point does not hold to the entitlement, when it exempts any. */
  readonly exemption?: string;
}

const DECLARED = "declared-entitlements.integration.test.ts";
const INVITATIONS = "invitation-enforcement.integration.test.ts";
const WORKSPACE_LIMIT = "workspace-limit.integration.test.ts";
const SEATS = "seat-limit.integration.test.ts";
const OIDC_INVITATIONS = "../auth/oidc-invitation.integration.test.ts";
const BOOKMARK_LIMIT = "bookmark-limit.integration.test.ts";
const SHARING = "sharing-enforcement.integration.test.ts";
// Seating the first owner of a workspace is not the feature `members.invite` names (doc 01 section 7.5). The seat limit still applies.
const OWNER_INVITATION = "the owner invitation an instance admin issues";

export const ENFORCEMENT_POINTS: readonly EnforcementPoint[] = [
  { operationId: "createInvitation", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "listInvitations", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "resendInvitation", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "createInvitationLink", entitlement: "members.invite", decidedBy: "stage-9", test: DECLARED },
  { operationId: "createTeam", entitlement: "teams.manage", decidedBy: "stage-9", test: DECLARED },
  { operationId: "updateTeam", entitlement: "teams.manage", decidedBy: "stage-9", test: DECLARED },
  { operationId: "deleteTeam", entitlement: "teams.manage", decidedBy: "stage-9", test: DECLARED },
  { operationId: "replaceTeamMembers", entitlement: "teams.manage", decidedBy: "stage-9", test: DECLARED },
  { operationId: "acceptInvitation", entitlement: "members.invite", decidedBy: "handler", test: INVITATIONS, exemption: OWNER_INVITATION },
  { operationId: "acceptInvitation", entitlement: "seats.max", decidedBy: "handler", test: SEATS },
  { operationId: "completeOidcSignIn", entitlement: "members.invite", decidedBy: "handler", test: OIDC_INVITATIONS, exemption: OWNER_INVITATION },
  { operationId: "completeOidcSignIn", entitlement: "seats.max", decidedBy: "handler", test: OIDC_INVITATIONS },
  { operationId: "createWorkspace", entitlement: "workspaces.ownMax", decidedBy: "handler", test: WORKSPACE_LIMIT },
  { operationId: "createBookmark", entitlement: "bookmarks.max", decidedBy: "handler", test: BOOKMARK_LIMIT },
  { operationId: "listShareTargets", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "listShareTargets", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "listBookmarkShares", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "listBookmarkShares", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "createBookmarkShare", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "createBookmarkShare", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "deleteBookmarkShare", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "deleteBookmarkShare", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "listFolderShares", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "listFolderShares", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "createFolderShare", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "createFolderShare", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "deleteFolderShare", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "deleteFolderShare", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  // Only the `share` action of the bulk request and of its preview names a target, and so needs a sharing entitlement; the other actions need none.
  { operationId: "bulkBookmarks", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "bulkBookmarks", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
  { operationId: "previewBulkBookmarks", entitlement: "sharing.members", decidedBy: "handler", test: SHARING },
  { operationId: "previewBulkBookmarks", entitlement: "sharing.teams", decidedBy: "handler", test: SHARING },
];
