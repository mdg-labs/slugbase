import { randomBytes } from "node:crypto";
import { unconfigured, type RateLimitPort } from "@slugbase/core";
import type { AuthStore, Database } from "@slugbase/db";
import { createServer, loadConfig, type Logger } from "@slugbase/server";

export const PRODUCT_NAME = "SlugBase Test Build";

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const database: Database = {
  withTenant: (_context, fn) => fn({ accountId: "", workspaceId: undefined, requestId: "" }),
  close: () => Promise.resolve(),
};

// GET /api/config asks the auth store whether first-run setup is pending; this test has no database, and setup is done.
const unexpected = (): Promise<never> => Promise.reject(new Error("this test has no database"));
const authStore: AuthStore = {
  emailKey: unexpected,
  loginLookup: unexpected,
  createSession: unexpected,
  signInAlertContext: unexpected,
  lookupSession: unexpected,
  lookupApiToken: unexpected,
  revokeSession: unexpected,
  listSessions: unexpected,
  revokeAllSessions: unexpected,
  passwordHashOf: unexpected,
  markReauthenticated: unexpected,
  changePassword: unexpected,
  mfaStateOf: unexpected,
  startMfaEnrollment: unexpected,
  resealMfaSecret: unexpected,
  activateMfa: unexpected,
  unusedBackupCodes: unexpected,
  completeMfaSignIn: unexpected,
  recordMfaFailure: unexpected,
  regenerateBackupCodes: unexpected,
  disableMfa: unexpected,
  reauthenticateWithStep: unexpected,
  createOidcLoginState: unexpected,
  consumeOidcLoginState: unexpected,
  signInWithIdentity: unexpected,
  linkIdentity: unexpected,
  unlinkIdentity: unexpected,
  reauthenticateWithIdentity: unexpected,
  setupPending: () => Promise.resolve(false),
  setSetupToken: unexpected,
  completeSetup: unexpected,
  registerAccount: unexpected,
  verifyEmail: unexpected,
  close: () => Promise.resolve(),
};

// The limiter that every public route passes through is the database one in the composition root;
// this test serves files and one public route and is not about limits.
const rateLimit: RateLimitPort = {
  available: true,
  consume: () => Promise.resolve({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
};

const environment = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
  MIGRATE_ON_START: "false",
};

/** The CE server over a fake database and the CE web build, when a web root is given. */
export function composedServer(webRoot?: string) {
  const config = loadConfig("server", environment).config;
  return createServer({
    config,
    adapters: { ...unconfigured(), rateLimit },
    modules: [],
    migrations: [],
    logger,
    database,
    authStore,
    buildInfo: { name: PRODUCT_NAME, version: "1.2.3", commit: "test", builtAt: "2026-01-01T00:00:00Z" },
    ...(webRoot === undefined ? {} : { webRoot }),
  });
}
