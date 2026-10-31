import { randomBytes } from "node:crypto";
import { PortUnavailable, UNSET_INSTANCE_SETTINGS, type AiSuggestRequest, type RateLimitPort } from "@slugbase/core";
import type { AuthStore, Database } from "@slugbase/db";
import { createServer, loadConfig, type Logger, type ServerModule } from "@slugbase/server";
import { describe, expect, it } from "vitest";
import { composeAdapters } from "../src/main.ts";

// The composition root selects the AI adapter from the AI keys and passes it to the server as `adapters.ai`; GET /api/config
// reports `features.ai` from it (doc 01 section 6, D22). The allowance for a private endpoint (Q90) is tested with the egress
// adapter, in egress.test.ts.

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
  instanceSettings: () => Promise.resolve(UNSET_INSTANCE_SETTINGS),
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
  acceptInvitationWithNewAccount: unexpected,
  acceptInvitationWithIdentity: unexpected,
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

const API_KEY = "provider-key-qx87-visible";
const ai = {
  AI_BASE_URL: "https://api.example.com/v1",
  AI_API_KEY: API_KEY,
  AI_MODEL: "small-model",
  AI_PROVIDER_NAME: "Example AI",
};

const request: AiSuggestRequest = { url: "https://example.com/", language: "en", tags: [] };

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

describe("the AI port in the composition root", () => {
  it("is the unconfigured default without AI keys: unavailable, and it rejects ai_unavailable", async () => {
    const config = loadConfig("server", environment).config;
    const adapters = composeAdapters(config, logger);
    expect(adapters.ai.available).toBe(false);
    const error = await adapters.ai.suggest(request).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PortUnavailable);
    expect(error).toMatchObject({ port: "ai", code: "ai_unavailable" });
  });

  it("is the OpenAI-compatible adapter with the AI keys set, and is not composed for the worker", () => {
    const server = loadConfig("server", { ...environment, ...ai }).config;
    const worker = loadConfig("worker", { ...environment, ...ai }).config;
    expect(composeAdapters(server, logger).ai.available).toBe(true);
    expect(composeAdapters(worker, logger).ai.available).toBe(false);
  });

  it("reports features.ai from /api/config only when the adapter is composed", async () => {
    expect(await features(serverWith({}))).toEqual({ mail: false, ai: false });
    expect(await features(serverWith(ai))).toEqual({ mail: false, ai: true });
    expect(await features(serverWith({ ...ai, AI_API_KEY: "" }))).toEqual({ mail: false, ai: true });
  });

  it("hands the port to the modules of the server", () => {
    const seen: boolean[] = [];
    const probe: ServerModule = {
      name: "probe",
      register: (context) => {
        seen.push(context.adapters.ai.available);
        return {};
      },
    };
    const config = loadConfig("server", { ...environment, ...ai }).config;
    createServer({ config, adapters: composeAdapters(config, logger), modules: [probe], migrations: [], logger, database, authStore });
    expect(seen).toEqual([true]);
  });

  it("logs the provider and never the key or the endpoint", () => {
    lines.length = 0;
    composeAdapters(loadConfig("server", { ...environment, ...ai }).config, logger);
    const written = JSON.stringify(lines);
    expect(written).toContain("Example AI");
    expect(written).not.toContain(API_KEY);
    expect(written).not.toContain("api.example.com");
  });

  it("refuses to start with an allowance that is not the host of AI_BASE_URL", () => {
    expect(() => loadConfig("server", { ...environment, ...ai, AI_ALLOWED_PRIVATE_HOST: "llm.lan" })).toThrow(/AI_ALLOWED_PRIVATE_HOST/);
  });
});
