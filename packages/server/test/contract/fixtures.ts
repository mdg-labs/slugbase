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

/** The pending invitation the matrix seeds in workspace B, which the invitation operations of A name. */
export const B_INVITATION_ID = "0192f3a0-cccc-7000-8000-000000000007";

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
  getSetupStatus: {},
  // The walker's database has accounts, so setup is closed for it: the valid request is the declared 403.
  completeSetup: {
    body: { displayName: "Walker", email: "setup-walker@example.test", password: "a password for the setup walker", workspaceName: "Walker's workspace" },
    status: 403,
  },
};
