import { randomBytes } from "node:crypto";
import { PortUnavailable, type RateLimitPort } from "@slugbase/core";
import type { AuthStore, Database } from "@slugbase/db";
import { createServer, createWorker, loadConfig, type Logger, type ServerModule } from "@slugbase/server";
import { describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The composition root selects the mail adapter from the SMTP keys and passes it to the server and the
// worker as `adapters.mail`; GET /api/config reports `features.mail` from it (doc 01 section 6, D22).

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
  requestPasswordReset: unexpected,
  resetPassword: unexpected,
  requestEmailChange: unexpected,
  cancelPendingEmailChange: unexpected,
  confirmEmailChange: unexpected,
  cancelEmailChange: unexpected,
  emailVerified: unexpected,
  inspectInvitation: unexpected,
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

const smtp = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURITY: "starttls",
  SMTP_USER: "relay-user",
  SMTP_PASS: "relay-pass-Zq8",
  SMTP_FROM: "SlugBase <slugbase@example.com>",
};

const authless = { SMTP_HOST: smtp.SMTP_HOST, SMTP_PORT: smtp.SMTP_PORT, SMTP_SECURITY: smtp.SMTP_SECURITY, SMTP_FROM: smtp.SMTP_FROM };

const message = { template: "welcome", to: "Member@Example.org", locale: "en", data: { link: "https://bookmarks.example.com/t/seedtokenAAAA" } };

const ALWAYS_ALLOWED: RateLimitPort = {
  available: true,
  consume: () => Promise.resolve({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
};

function serverWith(extra: Record<string, string>) {
  const config = loadConfig("server", { ...environment, ...extra }).config;
  return createServer({
    config,
    // The rate limiter composed for the process keeps its tokens in Postgres; this test has no database.
    adapters: { ...composeAdapters(config, logger), rateLimit: ALWAYS_ALLOWED },
    modules: [],
    migrations: [],
    logger,
    database,
    authStore,
    buildInfo: { name: "SlugBase", version: "1.0.0", commit: "0123abc", builtAt: "2026-10-12T08:00:00Z" },
  });
}

async function features(server: ReturnType<typeof serverWith>): Promise<unknown> {
  const response = await server.fetch(new Request("https://bookmarks.example.com/api/config"));
  expect(response.status).toBe(200);
  return ((await response.json()) as { features: unknown }).features;
}

describe("mail in the composition root", () => {
  it("selects the log-only adapter without SMTP keys: unavailable, logs the domain and template only, rejects mail_unavailable", async () => {
    lines.length = 0;
    const config = loadConfig("server", environment).config;
    const mail = composeAdapters(config, logger).mail;
    expect(mail.available).toBe(false);
    const error = await mail.send(message).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PortUnavailable);
    expect(error).toMatchObject({ port: "mail", code: "mail_unavailable" });
    const written = JSON.stringify(lines);
    expect(written).toContain("example.org");
    expect(written).toContain("welcome");
    for (const secret of ["Member", "seedtokenAAAA", "bookmarks.example.com/t/"]) {
      expect(written).not.toContain(secret);
    }
  });

  it("selects the SMTP adapter with the SMTP keys set, for the server and the worker", () => {
    const server = loadConfig("server", { ...environment, ...smtp }).config;
    const worker = loadConfig("worker", { ...environment, ...smtp }).config;
    expect(composeAdapters(server, logger).mail.available).toBe(true);
    expect(composeAdapters(worker, logger).mail.available).toBe(true);
  });

  it("selects the SMTP adapter without credentials, for the server and the worker", () => {
    const server = loadConfig("server", { ...environment, ...authless }).config;
    const worker = loadConfig("worker", { ...environment, ...authless }).config;
    expect(composeAdapters(server, logger).mail.available).toBe(true);
    expect(composeAdapters(worker, logger).mail.available).toBe(true);
  });

  it("reports features.mail from /api/config only when the SMTP adapter is configured, with or without credentials", async () => {
    expect(await features(serverWith({}))).toEqual({ mail: false, ai: false });
    expect(await features(serverWith(smtp))).toEqual({ mail: true, ai: false });
    expect(await features(serverWith(authless))).toEqual({ mail: true, ai: false });
  });

  it("refuses to start with one credential, or with credentials and no relay", () => {
    expect(() => loadConfig("server", { ...environment, ...authless, SMTP_USER: smtp.SMTP_USER })).toThrow(/SMTP_PASS/);
    expect(() => loadConfig("server", { ...environment, SMTP_USER: smtp.SMTP_USER, SMTP_PASS: smtp.SMTP_PASS })).toThrow(/SMTP_HOST/);
  });

  it("refuses a message whose template is not registered instead of sending it", async () => {
    const config = loadConfig("server", { ...environment, ...smtp }).config;
    await expect(composeAdapters(config, logger).mail.send(message)).rejects.toMatchObject({ reason: "unknown_template" });
  });

  it("hands the mail port to the modules of the server and the worker", () => {
    const seen: boolean[] = [];
    const probe: ServerModule = {
      name: "probe",
      register: (context) => {
        seen.push(context.adapters.mail.available);
        return {};
      },
    };
    const serverConfig = loadConfig("server", { ...environment, ...smtp }).config;
    createServer({ config: serverConfig, adapters: composeAdapters(serverConfig, logger), modules: [probe], migrations: [], logger, database, authStore });
    const workerConfig = loadConfig("worker", environment).config;
    createWorker({ config: workerConfig, adapters: composeAdapters(workerConfig, logger), modules: [probe], logger });
    expect(seen).toEqual([true, false]);
  });
});
