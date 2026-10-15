import type { ContractFixtures } from "./walker.ts";

// The fixtures of the operations of the committed document: the request the
// walker makes as the valid call of each. An operation added to the contract
// needs its entry here; until it has one the walker fails on it.

/** The account the walker signs in as; the contract test creates it before the walk. */
export const WALKER_ACCOUNT = { email: "walker@example.test", password: "a password for the walker" } as const;

/** A session id no account holds: the walker's request to revoke it is the declared 404. */
export const UNKNOWN_SESSION_ID = "0192f3a0-cccc-7000-8000-000000000001";

/** The workspace the walker that creates an API token is a member of. */
export const WALKER_WORKSPACE_ID = "0192f3a0-cccc-7000-8000-0000000000f1";

/** A token id no account holds: the walker's request to revoke it is the declared 404. */
export const UNKNOWN_API_TOKEN_ID = "0192f3a0-cccc-7000-8000-000000000002";

/** An identity id no account holds: the walker's request to unlink it is the declared 404. */
export const UNKNOWN_IDENTITY_ID = "0192f3a0-cccc-7000-8000-000000000003";

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
  // Account-level operations: no workspace or other account's identifier is part of them, and the identities they act on are the walker's own.
  // The walker has none, so a valid unlink names an identity that is not its own, which is the declared 404 whoever holds it.
  listIdentities: {},
  unlinkIdentity: { path: { id: UNKNOWN_IDENTITY_ID }, status: 404 },
  getSetupStatus: {},
  // The walker's database has accounts, so setup is closed for it: the valid request is the declared 403.
  completeSetup: {
    body: { displayName: "Walker", email: "setup-walker@example.test", password: "a password for the setup walker", workspaceName: "Walker's workspace" },
    status: 403,
  },
};
