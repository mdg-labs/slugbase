import type { ContractFixtures } from "./walker.ts";

// The fixtures of the operations of the committed document: the request the
// walker makes as the valid call of each. An operation added to the contract
// needs its entry here; until it has one the walker fails on it.

/** The account the walker signs in as; the contract test creates it before the walk. */
export const WALKER_ACCOUNT = { email: "walker@example.test", password: "a password for the walker" } as const;

/** A session id no account holds: the walker's request to revoke it is the declared 404. */
export const UNKNOWN_SESSION_ID = "0192f3a0-cccc-7000-8000-000000000001";

/** The workspace the walker that creates an API token, or switches its active workspace, is a member of. */
export const WALKER_WORKSPACE_ID = "0192f3a0-cccc-7000-8000-0000000000f1";

/** A token id no account holds: the walker's request to revoke it is the declared 404. */
export const UNKNOWN_API_TOKEN_ID = "0192f3a0-cccc-7000-8000-000000000002";

/** An identity id no account holds: the walker's request to unlink it is the declared 404. */
export const UNKNOWN_MEMBER_ID = "0192f3a0-cccc-7000-8000-000000000004";
export const UNKNOWN_IDENTITY_ID = "0192f3a0-cccc-7000-8000-000000000003";

/** A team no workspace holds: teams have no members to join yet, so any team named in an invitation is refused the same way. */
export const UNKNOWN_TEAM_ID = "0192f3a0-cccc-7000-8000-000000000005";

/** A workspace no instance holds: the walker's request to delete it is the declared 404. */
export const UNKNOWN_WORKSPACE_ID = "0192f3a0-dddd-7000-8000-000000000008";

/** An account no instance holds: the walker's request to change it is the declared 404. */
export const UNKNOWN_ACCOUNT_ID = "0192f3a0-dddd-7000-8000-000000000009";

/** The pending invitation the matrix seeds in workspace B, which the invitation operations of A name. */
export const B_INVITATION_ID = "0192f3a0-cccc-7000-8000-000000000007";

/** A bookmark no workspace holds: the walker's request to read it is the declared 404. */
export const UNKNOWN_BOOKMARK_ID = "0192f3a0-cccc-7000-8000-000000000008";

/** A tag no workspace holds: the walker's request to rename or delete it is the declared 404. */
export const UNKNOWN_TAG_ID = "0192f3a0-cccc-7000-8000-00000000000a";

/** A second tag no workspace holds: the target of the walker's request to merge a tag, which must not be the tag it merges. */
export const UNKNOWN_TARGET_TAG_ID = "0192f3a0-cccc-7000-8000-00000000000c";

/** A folder no workspace holds: the walker's request to read, change or delete it is the declared 404. */
export const UNKNOWN_FOLDER_ID = "0192f3a0-cccc-7000-8000-00000000000b";

/** An invitation no workspace holds: the walker's request to resend, link or revoke it is the declared 404. */
export const UNKNOWN_INVITATION_ID = "0192f3a0-cccc-7000-8000-000000000006";

export const FIXTURES: ContractFixtures = {
  getHealth: {},
  getReady: {},
  getVersion: {},
  getApiConfig: {},
  getOpenApiDocument: {},
  login: { body: { ...WALKER_ACCOUNT, remember: false } },
  // An account-level operation: no workspace or other account's identifier is part of it, and it acts on the session's own account. The walker's
  // session is a complete one, which has no second factor to give, so the valid request is the declared 422; the pending session is walked by the sign-in tests.
  verifyMfa: { body: { code: "000000" }, status: 422 },
  logout: {},
  // An anonymous operation: no identifier of any account is part of it. The walker's server leaves registration at its closed default, so the
  // valid request is the declared 403; the registration itself is walked by the register tests.
  register: {
    body: { displayName: "Walker", email: "register-walker@example.test", password: "a password for the register walker" },
    status: 403,
  },
  // An anonymous operation: it takes an email address and names no workspace or account identifier the caller could address; the answer is one 202 for
  // every address, so the walker's valid request is the declared 202.
  resendVerifyEmail: { body: { email: "resend-walker@example.test" }, status: 202 },
  // An anonymous operation: the token is its only credential and names no workspace or account the caller could address. The walker holds no
  // verification token, so the valid request is the declared 410; the verification itself is walked by the verify-email tests.
  verifyEmail: { body: { token: "A".repeat(43), password: "a password for the verify walker" }, status: 410 },
  // Anonymous operations: an email address, or the token that is the only credential, and nothing that names a workspace or an account the caller
  // could address. The answer to the request for a link is one 202 for every address; the walker holds no reset token, so the redemption's valid
  // request is the declared 410, and the reset itself is walked by the password-reset tests.
  forgotPassword: { body: { email: "forgot-walker@example.test" }, status: 202 },
  resetPassword: { body: { token: "A".repeat(43), newPassword: "a password for the reset walker" }, status: 410 },
  // Account-level operations: no workspace or other account's identifier is part of them, and the account they act on is the walker's own. The
  // walker's session has just re-authenticated, so the request is valid and answers the one 202 every address gets; the pending change is the
  // walker's own to cancel. The two redemptions are anonymous: the token is the only credential and names no workspace or account the caller could
  // address. The walker holds no email-change token, so their valid request is the declared 410; the redemptions are walked by the email-change tests.
  requestEmailChange: { body: { email: "email-change-walker@example.test" }, status: 202 },
  cancelPendingEmailChange: {},
  confirmEmailChange: { body: { token: "A".repeat(43) }, status: 410 },
  cancelEmailChange: { body: { token: "A".repeat(43) }, status: 410 },
  // Anonymous operations: the provider's slug is the only identifier, it names a deployment-wide setting and no workspace or account, and there is
  // nothing of another account's to name. The walker's server has no provider, so both answer the declared 302 to /login with the failure code;
  // the handshake itself is walked by the OIDC sign-in tests.
  startOidcSignIn: { path: { provider: "idp" }, status: 302 },
  completeOidcSignIn: { path: { provider: "idp" }, status: 302 },
  getMe: {},
  // An account-level operation: no workspace or other account's identifier is part of it, and the account it changes is the walker's own.
  updateMe: { body: { displayName: "Walker", locale: "en", theme: "system", accent: "periwinkle", defaultView: "grid", singleKeyShortcuts: true } },
  // The walker signs each session in with this password; the valid change is made by a session that has just re-authenticated with it.
  reauthenticate: { body: { password: WALKER_ACCOUNT.password } },
  changePassword: { body: { currentPassword: WALKER_ACCOUNT.password, newPassword: "a new password for the walker" } },
  // Account-level operations: no workspace or other account's identifier is part of them, and the account they act on is the walker's own.
  // The walker's session has just re-authenticated, so the start is valid; it stores a pending secret of the walker's own account.
  startMfaEnrollment: {},
  // The walker cannot know the code of the secret the start gave it: the valid request is the declared 422.
  confirmMfaEnrollment: { body: { code: "000000" }, status: 422 },
  // The walker's account has no second factor on, so a valid request has nothing to regenerate or turn off: the declared 422. Both act on the walker's own account only.
  regenerateMfaBackupCodes: { body: { code: "000000" }, status: 422 },
  disableMfa: { body: { password: WALKER_ACCOUNT.password, code: "000000" }, status: 422 },
  listSessions: {},
  // The walker has one session, which every call of the walk needs; a revocation that succeeds is covered by the session route tests.
  revokeSession: { path: { id: UNKNOWN_SESSION_ID }, status: 404 },
  revokeSessions: {},
  // Account-level operations: no workspace of another account is part of them, and the tokens they act on are the walker's own. The walker
  // that creates is a member of the workspace it names (the contract test seeds it, the stub tenant resolver knows no workspace of a real
  // session), so the valid request is the declared 201; a token that is not its own is the 404 the revocation answers.
  listApiTokens: {},
  createApiToken: { body: { name: "Walker token", scope: "read", workspaceId: WALKER_WORKSPACE_ID } },
  revokeApiToken: { path: { id: UNKNOWN_API_TOKEN_ID }, status: 404 },
  // An account-level operation: no workspace or other account's identifier is part of it, and it deletes the walker's own account, which every
  // call of the walk needs. The address it names is another one, so the valid request is the declared 422; the deletion itself is walked by the
  // account deletion route tests.
  deleteMe: { body: { email: "not-the-walker@example.test" }, status: 422 },
  // Account-level operations: no workspace or other account's identifier is part of them, and the identities they act on are the walker's own.
  // The walker has none, so a valid unlink names an identity that is not its own, which is the declared 404 whoever holds it.
  listIdentities: {},
  unlinkIdentity: { path: { id: UNKNOWN_IDENTITY_ID }, status: 404 },
  // Account-level operations: no workspace or other account's identifier is part of them, and the workspaces they act on are the walker's own.
  // The walker's server leaves workspace creation at its closed default, so the valid creation is the declared 403; the creation itself is walked
  // by the workspace route tests.
  listWorkspaces: {},
  createWorkspace: { body: { name: "Walker workspace" }, status: 403 },
  // An account-level operation: the workspace it names must be one the account belongs to, and a workspace of another account answers the declared
  // 404 whoever holds it (the session tests walk that). The walker that switches is a member of the workspace it names (the contract test seeds
  // it), so the valid request is the declared 204.
  setActiveWorkspace: { body: { workspaceId: WALKER_WORKSPACE_ID } },
  // Tenant-scoped operations that act in the workspace of the request and take no identifier of any workspace, so there is no workspace B
  // identifier to put in them: the walker that calls each is the owner of a workspace of its own (the contract test seeds it, with its settings
  // row), and the roles below are the member of that workspace and an account with none. What the matrix shows of them, that no request
  // reaches a workspace other than its own, is run by the workspace route tests.
  getWorkspace: {},
  renameWorkspace: { body: { name: "Walker's renamed workspace" } },
  getWorkspaceSettings: {},
  // The entitlements of the workspace of the request: it acts in the walker's own workspace and names no identifier of any workspace, so
  // there is none of workspace B to put in it. The walker's server composes a source that limits nothing, so the valid request is the declared 200.
  getEntitlements: {},
  updateWorkspaceSettings: { body: { aiEnabled: false } },
  // Tenant-scoped operations of the workspace of the request. The list names no identifier. The role change names a member by account
  // identifier, and the walker cannot know the identifier of a member of the workspace it owns, so its valid request names an account that is no
  // member of it, which is the declared 404 whoever holds it, and so is a member of workspace B; the route tests change roles, and the matrix puts the
  // members of workspace B in it.
  listMembers: {},
  updateMember: { path: { accountId: UNKNOWN_MEMBER_ID }, body: { role: "admin" }, status: 404, foreign: { path: { accountId: UNKNOWN_MEMBER_ID }, body: { role: "admin" } } },
  // The removal names a member by account identifier and the content choice may name a recipient, so its valid request is the declared 404
  // for an account that is no member, and a recipient that is a member of workspace B is the same 404. The walker owns the workspace it acts in
  // and leaving it would end its membership, so its valid request to leave names a recipient that is no member of it: the same declared 404, with
  // nothing removed; the route tests end memberships.
  removeMember: {
    path: { accountId: UNKNOWN_MEMBER_ID },
    body: { content: "transfer" },
    status: 404,
    foreign: { path: { accountId: UNKNOWN_MEMBER_ID }, body: { content: "transfer", transferTo: UNKNOWN_MEMBER_ID } },
  },
  leaveWorkspace: { body: { content: "transfer", transferTo: UNKNOWN_MEMBER_ID }, status: 404, foreign: { body: { content: "transfer", transferTo: UNKNOWN_MEMBER_ID } } },
  // A tenant-scoped operation that acts in the workspace of the request and takes no identifier. The walker that calls it is the owner of a
  // workspace of its own that no other operation uses, and it has just re-authenticated, so the valid request is the declared 202: it marks
  // that workspace as being deleted, and the walker's other calls to the operation are refused before the handler.
  deleteWorkspace: {},
  // The transfer names a member by account identifier in its body and takes an owner's re-authenticated session, so its valid request is the declared
  // 404 for an account that is no member of the workspace the walker owns, and a member of workspace B is the same 404; the route tests transfer ownership.
  transferWorkspaceOwnership: {
    body: { accountId: UNKNOWN_MEMBER_ID, demoteSelf: false },
    status: 404,
    foreign: { body: { accountId: UNKNOWN_MEMBER_ID, demoteSelf: false } },
  },
  // The invitation acts in the workspace of the request and names a team of it by identifier in its body. The walker's server holds the entitlement the
  // operation declares for every account but the one that has none, so the valid request is the declared 201. A team is refused with 422 whichever workspace
  // holds it, since no team can be invited into yet, so the request naming a team is the declared 422 for a team of workspace B as for any other; the matrix
  // and the walker hold that one answer to the 404 they expect for an identifier of another workspace (see contract.integration.test.ts).
  createInvitation: {
    body: { email: "walker-invitee@example.test", role: "member" },
    foreign: { body: { email: "walker-invitee@example.test", role: "member", teamIds: [UNKNOWN_TEAM_ID] } },
  },
  // The invitations of the workspace of the request. The list names no identifier. The other three name an invitation by identifier, and the walker
  // cannot know the identifier of one in the workspace it owns (it has none), so each valid request names an invitation that no workspace holds, which
  // is the declared 404 whoever would hold it, and so is an invitation of workspace B; the route tests resend, link and revoke invitations, and the
  // matrix puts a real invitation of workspace B in each.
  listInvitations: {},
  resendInvitation: { path: { id: UNKNOWN_INVITATION_ID }, status: 404, foreign: { path: { id: UNKNOWN_INVITATION_ID } } },
  createInvitationLink: { path: { id: UNKNOWN_INVITATION_ID }, status: 404, foreign: { path: { id: UNKNOWN_INVITATION_ID } } },
  revokeInvitation: { path: { id: UNKNOWN_INVITATION_ID }, status: 404, foreign: { path: { id: UNKNOWN_INVITATION_ID } } },
  // The two operations that redeem an invitation's token, both anonymous in the contract (the acceptance takes the signed-in account's form or the
  // registration form, told by its body). Neither names a workspace, an account or an invitation by identifier (the token is the only handle and a
  // workspace identifier cannot be put in it), and the walker holds no invitation token, so each valid request is the declared 410; the walker sends the
  // acceptance without a credential, which is the registration form. The redemptions themselves are walked by the invitation acceptance tests.
  inspectInvitation: { body: { token: "A".repeat(43) }, status: 410 },
  acceptInvitation: { body: { token: "A".repeat(43), displayName: "Walker", password: "a password for the walker" }, status: 410 },
  // An instance admin's operation: it names no workspace, account or other identifier, so there is none of workspace B or of another account to put in it.
  // The walker that calls it is an instance admin with a second factor on a complete session (the contract test makes it), and the account below the
  // policy is an ordinary one; the instance suite shows that a token, a pending session and an admin without a second factor are refused.
  getInstanceStatus: {},
  // The settings and the test email of the instance admin name no workspace, account or other identifier either, so the same holds. The walker's
  // server has no mail adapter, so the valid test-mail request is the declared 503 (mail_unavailable). The settings it writes are the ones it left.
  getInstanceSettings: {},
  updateInstanceSettings: { body: { displayName: "Walker" } },
  sendInstanceTestMail: { status: 503 },
  // The workspace operations of the instance admin. The list names nothing. The creation names the address of a first owner and no account, so
  // there is no account of another workspace to put in it: the valid request is the declared 201 and makes a workspace nobody is a member of. The
  // deletion names a workspace by identifier, which an instance admin may name whoever holds it, and the walker knows none it could delete without
  // taking the next call's workspace away: its valid request names one that does not exist, the declared 404; the route tests delete workspaces.
  listInstanceWorkspaces: {},
  createInstanceWorkspace: { body: { name: "Walker's instance workspace", ownerEmail: "walker-first-owner@example.test" } },
  deleteInstanceWorkspace: { path: { id: UNKNOWN_WORKSPACE_ID }, status: 404 },
  // The membership names a workspace by identifier, which an instance admin may name whoever holds it, and the walker knows none it could join
  // without giving its account a membership the next call would not expect: its valid request names one that does not exist, the declared 404;
  // the route tests add the admin to workspaces.
  addInstanceAdminMembership: { path: { id: UNKNOWN_WORKSPACE_ID }, status: 404 },
  // The owner invitation names a workspace by identifier too, which an instance admin may name whoever holds it, and the walker knows none that waits
  // for its first owner and is not another call's: its valid request names one that does not exist, the declared 404; the route tests issue the invitations.
  issueInstanceWorkspaceOwnerInvitation: { path: { id: UNKNOWN_WORKSPACE_ID }, body: { ownerEmail: "walker-next-owner@example.test" }, status: 404 },
  // The account operations of the instance admin. The list names nothing. The change names an account by identifier, which an instance admin may
  // name whoever it is, and the walker knows none it could disable or demote without taking the next call's caller away: its valid request names one
  // that does not exist, the declared 404; the route tests change accounts.
  listInstanceAccounts: {},
  updateInstanceAccount: { path: { id: UNKNOWN_ACCOUNT_ID }, body: { disabled: true }, status: 404 },
  // The recovery operations name an account by identifier too, and the walker knows none whose second factor it could reset or whose reset link it
  // could issue without taking the next call's caller away: the reset and the link name the one that does not exist, the declared 404. The walked
  // server has no mail adapter, which the resend of a verification email asks about first, so its valid request is the declared 503
  // (mail_unavailable). The route tests recover accounts.
  resetInstanceAccountMfa: { path: { id: UNKNOWN_ACCOUNT_ID }, status: 404 },
  issueInstanceAccountResetLink: { path: { id: UNKNOWN_ACCOUNT_ID }, status: 404 },
  resendInstanceAccountVerification: { path: { id: UNKNOWN_ACCOUNT_ID }, status: 503 },
  // The deletion names the account that does not exist too, the declared 404: the walker's own accounts are the callers of the calls that follow.
  deleteInstanceAccount: { path: { id: UNKNOWN_ACCOUNT_ID }, status: 404 },
  // The bookmarks of the workspace of the request. The creation takes a destination and a title and names no identifier of any workspace, so there
  // is none of workspace B to put in it; the walker that calls it is the owner of a workspace of its own and the server composes a source that limits
  // nothing, so the valid request is the declared 201. The reading names a bookmark by identifier, and the walker cannot know the identifier of one it
  // would own, so its valid request names a bookmark that no workspace holds, which is the declared 404 whoever would hold it, and so is a bookmark of
  // workspace B; the route tests read the walker's own bookmarks, and the matrix puts the bookmarks of workspace B in the path.
  // The creation also takes `folderIds` and `tagIds`, which the matrix picks as inputs that can carry an identifier: a folder or a tag of workspace B is
  // refused with the declared 404, and nothing is created, whoever would hold them.
  createBookmark: {
    body: { url: "https://example.com/walker", title: "Walker bookmark" },
    foreign: { body: { url: "https://example.com/walker", title: "Walker bookmark", folderIds: [UNKNOWN_FOLDER_ID], tagIds: [UNKNOWN_TAG_ID] } },
  },
  // The list names no identifier and acts in the workspace of the request: the walker lists the bookmarks of the workspace it owns. The matrix picks
  // the input `hasSlug` as one that can carry an identifier, because its name ends in `Slug`; it is a boolean filter, so the identifier the matrix puts
  // in it is refused as a malformed query (422) and never reaches a bookmark, whichever workspace holds it.
  listBookmarks: { foreign: { query: { hasSlug: UNKNOWN_BOOKMARK_ID } } },
  // The select-all takes the list's filters and names no identifier either; the matrix picks `hasSlug` by its name here as well, and the identifier it puts in
  // that boolean is refused as a malformed query (422) before any bookmark is looked at.
  listBookmarkIds: { foreign: { query: { hasSlug: UNKNOWN_BOOKMARK_ID } } },
  // The bulk request names bookmarks by identifier, and acts on the caller's own only: one that no workspace holds, one of workspace B and one that never
  // existed are skipped alike, which is a 200 with the identifier counted as not found and nothing written, never a 404 (doc 02 section 5.8). The valid
  // request and the request naming a bookmark of workspace B are therefore the same 200. The matrix picks `ids[]` and, by its name, `filter.hasSlug`; the
  // test that runs it sends the identifiers in `ids` only, since a request with both is refused as malformed.
  bulkBookmarks: { body: { action: "pin", ids: [UNKNOWN_BOOKMARK_ID] }, status: 200, foreign: { body: { action: "pin", ids: [UNKNOWN_BOOKMARK_ID] } } },
  getBookmark: { path: { id: UNKNOWN_BOOKMARK_ID }, status: 404, foreign: { path: { id: UNKNOWN_BOOKMARK_ID } } },
  // The change and the deletion name a bookmark by identifier too, so their valid request is the declared 404 for the same reason: a bookmark no
  // workspace holds, and the matrix puts the bookmarks of workspace B in the path. The change takes a body, which is valid whoever would hold the bookmark.
  updateBookmark: { path: { id: UNKNOWN_BOOKMARK_ID }, body: { title: "Walker bookmark" }, status: 404, foreign: { path: { id: UNKNOWN_BOOKMARK_ID }, body: { title: "Walker bookmark" } } },
  deleteBookmark: { path: { id: UNKNOWN_BOOKMARK_ID }, status: 404, foreign: { path: { id: UNKNOWN_BOOKMARK_ID } } },
  // The open names a bookmark by identifier as well, and counts it only for a bookmark the caller owns: the valid request is the declared 404 for
  // a bookmark no workspace holds, and the matrix puts the bookmarks of workspace B in the path.
  openBookmark: { path: { id: UNKNOWN_BOOKMARK_ID }, status: 404, foreign: { path: { id: UNKNOWN_BOOKMARK_ID } } },
  // The tags of the member who makes them. The creation takes a name and names no identifier of any workspace, so there is none of workspace B to put in it:
  // the walker that calls it owns a workspace of its own, so the valid request is the declared 201 (a second creation of the name by the same account is the
  // declared 409, which the matrix tolerates since it names no identifier). The list names none either and acts in the workspace of the request. The rename and
  // the deletion name a tag by identifier, which the walker cannot know for a tag it would own, so their valid request names a tag that no workspace holds, the
  // declared 404 whoever would hold it, and so is a tag of workspace B; the route tests rename and delete the walker's own tags, and the matrix puts the tag
  // of workspace B in the path.
  createTag: { body: { name: "Walker tag" } },
  listTags: {},
  renameTag: { path: { id: UNKNOWN_TAG_ID }, body: { name: "Walker tag" }, status: 404, foreign: { path: { id: UNKNOWN_TAG_ID }, body: { name: "Walker tag" } } },
  deleteTag: { path: { id: UNKNOWN_TAG_ID }, status: 404, foreign: { path: { id: UNKNOWN_TAG_ID } } },
  // The merge names two tags, the one in the path and the target in the body, and acts on the caller's own only: the valid request names two that no workspace holds,
  // the declared 404, and the matrix puts the tags of workspace B in both places, where it is the same 404 whichever of them it is (even the same tag twice, which is
  // judged only after the tags are found). The statistics name no identifier and act in the workspace of the request.
  mergeTag: {
    path: { id: UNKNOWN_TAG_ID },
    body: { intoTagId: UNKNOWN_TARGET_TAG_ID },
    status: 404,
    foreign: { path: { id: UNKNOWN_TAG_ID }, body: { intoTagId: UNKNOWN_TARGET_TAG_ID } },
  },
  getTagStats: {},
  // The folders of the member who makes them, like the tags: the creation and the list name no identifier of any workspace, so the walker's valid request
  // to create is the declared 201, and the read, the change and the deletion name a folder no workspace holds, the declared 404, which the matrix replaces
  // with the folder of workspace B.
  createFolder: { body: { name: "Walker folder" } },
  listFolders: {},
  getFolder: { path: { id: UNKNOWN_FOLDER_ID }, status: 404, foreign: { path: { id: UNKNOWN_FOLDER_ID } } },
  updateFolder: { path: { id: UNKNOWN_FOLDER_ID }, body: { name: "Walker folder" }, status: 404, foreign: { path: { id: UNKNOWN_FOLDER_ID }, body: { name: "Walker folder" } } },
  deleteFolder: { path: { id: UNKNOWN_FOLDER_ID }, status: 404, foreign: { path: { id: UNKNOWN_FOLDER_ID } } },
  // Filing names a folder in the path and the bookmarks in the body, and acts on the caller's own folders and bookmarks only: the valid request names a
  // folder and a bookmark that no workspace holds, the declared 404 whoever would hold them, and so does the request naming those of workspace B.
  addFolderBookmarks: {
    path: { id: UNKNOWN_FOLDER_ID },
    body: { bookmarkIds: [UNKNOWN_BOOKMARK_ID] },
    status: 404,
    foreign: { path: { id: UNKNOWN_FOLDER_ID }, body: { bookmarkIds: [UNKNOWN_BOOKMARK_ID] } },
  },
  removeFolderBookmarks: {
    path: { id: UNKNOWN_FOLDER_ID },
    body: { bookmarkIds: [UNKNOWN_BOOKMARK_ID] },
    status: 404,
    foreign: { path: { id: UNKNOWN_FOLDER_ID }, body: { bookmarkIds: [UNKNOWN_BOOKMARK_ID] } },
  },
  getSetupStatus: {},
  // The walker's database has accounts, so setup is closed for it: the valid request is the declared 403.
  completeSetup: {
    body: { displayName: "Walker", email: "setup-walker@example.test", password: "a password for the setup walker", workspaceName: "Walker's workspace" },
    status: 403,
  },
};
