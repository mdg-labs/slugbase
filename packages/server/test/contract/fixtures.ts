import type { ContractFixtures } from "./walker.ts";

// The fixtures of the operations of the committed document: the request the
// walker makes as the valid call of each. An operation added to the contract
// needs its entry here; until it has one the walker fails on it.

/** The account the walker signs in as; the contract test creates it before the walk. */
export const WALKER_ACCOUNT = { email: "walker@example.test", password: "a password for the walker" } as const;

/** A session id no account holds: the walker's request to revoke it is the declared 404. */
export const UNKNOWN_SESSION_ID = "0192f3a0-cccc-7000-8000-000000000001";

export const FIXTURES: ContractFixtures = {
  getHealth: {},
  getReady: {},
  getVersion: {},
  getApiConfig: {},
  getOpenApiDocument: {},
  login: { body: { ...WALKER_ACCOUNT, remember: false } },
  logout: {},
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
  listSessions: {},
  // The walker has one session, which every call of the walk needs; a revocation that succeeds is covered by the session route tests.
  revokeSession: { path: { id: UNKNOWN_SESSION_ID }, status: 404 },
  revokeSessions: {},
  getSetupStatus: {},
  // The walker's database has accounts, so setup is closed for it: the valid request is the declared 403.
  completeSetup: {
    body: { displayName: "Walker", email: "setup-walker@example.test", password: "a password for the setup walker", workspaceName: "Walker's workspace" },
    status: 403,
  },
};
