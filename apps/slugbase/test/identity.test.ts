import { randomBytes } from "node:crypto";
import { PortUnavailable, type RateLimitPort } from "@slugbase/core";
import type { AuthStore, Database } from "@slugbase/db";
import { createServer, loadConfig, type Logger } from "@slugbase/server";
import { describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The composition root selects the identity adapter from the OIDC_<SLUG>_* keys of the server and passes it to
// the server as `adapters.identity`; GET /api/config lists its providers (doc 01 section 6, D22). Nothing here
// reaches the network: the issuer is a loopback address literal, which the egress port refuses before any
// connection, so the provider is unavailable and the adapter is shown by what it logs.

const lines: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
const logger: Logger = {
  info: (message, fields) => lines.push({ message, fields }),
  warn: (message, fields) => lines.push({ message, fields }),
  error: (message, fields) => lines.push({ message, fields }),
};

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
  resendVerification: unexpected,
  emailVerified: unexpected,
  close: () => Promise.resolve(),
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

const OIDC = {
  OIDC_LOOPBACK_CLIENT_ID: "client-id-qx88",
  OIDC_LOOPBACK_CLIENT_SECRET: "client-secret-qx89",
  OIDC_LOOPBACK_ISSUER_URL: "https://127.0.0.1:9",
};

const ALWAYS_ALLOWED: RateLimitPort = {
  available: true,
  consume: () => Promise.resolve({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
};

const unavailableLines = () => lines.filter((line) => line.message === "An OIDC provider is unavailable");

describe("identity in the composition root", () => {
  it("selects the unconfigured default without providers: unavailable, and it rejects when used", async () => {
    const config = loadConfig("server", environment).config;
    const identity = composeAdapters(config, logger).identity;
    expect(identity.available).toBe(false);
    await expect(identity.listProviders()).rejects.toBeInstanceOf(PortUnavailable);
  });

  it("selects the OIDC adapter for the server when a provider is configured, and degrades instead of failing", async () => {
    lines.length = 0;
    const config = loadConfig("server", { ...environment, ...OIDC }).config;
    const identity = composeAdapters(config, logger).identity;
    expect(identity.available).toBe(true);
    expect(await identity.listProviders()).toEqual([]);
    expect(unavailableLines()).toEqual([
      { message: "An OIDC provider is unavailable", fields: { provider: "loopback", reason: "discovery_failed", code: "egress_blocked" } },
    ]);
    expect(JSON.stringify(lines)).not.toContain("client-secret-qx89");
  });

  it("selects the unconfigured default for the worker, which has no providers", () => {
    const worker = loadConfig("worker", { ...environment, ...OIDC }).config;
    expect(composeAdapters(worker, logger).identity.available).toBe(false);
  });

  it("serves GET /api/config with no provider, and logs it, when the configured one cannot be reached", async () => {
    lines.length = 0;
    const config = loadConfig("server", { ...environment, ...OIDC }).config;
    const server = createServer({
      config,
      adapters: { ...composeAdapters(config, logger), rateLimit: ALWAYS_ALLOWED },
      modules: [],
      migrations: [],
      logger,
      database,
      authStore,
      buildInfo: { name: "SlugBase", version: "1.0.0", commit: "0123abc", builtAt: "2026-10-12T08:00:00Z" },
    });
    const response = await server.fetch(new Request("https://bookmarks.example.com/api/config"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect((JSON.parse(text) as { signIn: unknown }).signIn).toEqual({ registration: false, oidc: [] });
    expect(text).not.toContain("client-secret-qx89");
    expect(unavailableLines()).toHaveLength(1);
  });
});
