import { UNSET_INSTANCE_SETTINGS, unconfigured, type Adapters, type SeatEntitlements, type TenantResolver } from "@slugbase/core";
import type { AuthStore, Database } from "@slugbase/db";
import { defineOperation, jsonResponse, problemResponse, type OperationDefinition } from "@slugbase/contracts";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { z } from "zod";
import type { ChainDependencies } from "../src/http/chain.ts";
import { createRateLimitRegistry, loadConfig } from "../src/config/index.ts";
import { HookResult, createHookDispatcher, type HookDispatcher, type HookRegistration } from "../src/hooks/index.ts";
import type { ContractDocument, Logger, ModuleContext, ServerModule } from "../src/create-server.ts";
import { productionEnv } from "./config/support.ts";
import { memoryRateLimiter } from "./http/rate-limit-support.ts";

export interface RecordedLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The message of the line the request-context stage writes once per request. */
export const REQUEST_LINE = "Request completed";

/**
 * Records what is logged. `entries` holds every line except the per-request
 * line, which a test of another stage does not look at; that one is in `requests`.
 */
export function recordingLogger(): Logger & { readonly entries: RecordedLog[]; readonly requests: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const requests: RecordedLog[] = [];
  const record =
    (level: RecordedLog["level"]) =>
    (message: string, fields: Readonly<Record<string, unknown>> = {}): void => {
      (message === REQUEST_LINE ? requests : entries).push({ level, message, fields });
    };
  return { entries, requests, info: record("info"), warn: record("warn"), error: record("error") };
}

// A server under test does not migrate when it starts unless the test asks for it: the databases of most
// tests are fakes, and the migration of the real one has tests of its own.
export function serverConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig("server", productionEnv({ MIGRATE_ON_START: "false", ...overrides })).config;
}

/**
 * Every port unconfigured except the rate limiter, which is in memory: the unconfigured one refuses every limited route.
 * The entitlement source is unconfigured too (stage 9 refuses every declared entitlement) apart from the account-scoped
 * ceiling, which is unlimited: every registration, verification and workspace creation asks for it, so a source that
 * cannot answer would end each of them in `503`. It also reads the workspace as the full, unlimited source does, since
 * accepting an invitation reads the seat limit from it whichever check decides the flags.
 */
export function adapters(config: ModuleContext["config"] = serverConfig()): Adapters {
  const unconfiguredSource = unconfigured().entitlements;
  const full = new LimitedEntitlementSource();
  return {
    ...unconfigured(),
    rateLimit: memoryRateLimiter(createRateLimitRegistry(config)),
    entitlements: { ...unconfiguredSource, forWorkspace: (workspaceId) => full.forWorkspace(workspaceId), forAccount: () => Promise.resolve({ "workspaces.ownMax": "unlimited" }) },
  };
}

/** A seat entitlement that grants every workspace no ceiling, for tests that do not exercise seats. */
export const unlimitedSeats: SeatEntitlements = { limit: () => Promise.resolve(null) };

/** A hook dispatcher over the unconfigured client error-report source, for tests that do not exercise hooks. */
export function hookDispatcher(registrations: readonly HookRegistration[] = [], logger: Logger = recordingLogger()): HookDispatcher {
  return createHookDispatcher({ registrations, clientErrorReport: adapters().clientErrorReport, seats: unlimitedSeats, logger });
}

export interface FakeDatabase extends Database {
  readonly closed: { count: number };
}

export function fakeDatabase(): FakeDatabase {
  const closed = { count: 0 };
  return {
    closed,
    withTenant: (_context, fn) => fn({ accountId: "", workspaceId: undefined, requestId: "" }),
    close: () => {
      closed.count += 1;
      return Promise.resolve();
    },
  };
}

/**
 * An auth store for a test with no database: every operation but the ones given rejects, and `setupPending`
 * answers false (setup is done) and `instanceSettings` answers that no setting was ever saved, which is all
 * `GET /api/config` asks of it.
 */
export function fakeAuthStore(overrides: Partial<AuthStore> = {}): AuthStore {
  const unexpected = (name: string) => () => Promise.reject(new Error(`the fake auth store was asked for ${name}`));
  return {
    emailKey: unexpected("emailKey"),
    loginLookup: unexpected("loginLookup"),
    createSession: unexpected("createSession"),
    signInAlertContext: unexpected("signInAlertContext"),
    lookupSession: unexpected("lookupSession"),
    lookupApiToken: unexpected("lookupApiToken"),
    revokeSession: unexpected("revokeSession"),
    listSessions: unexpected("listSessions"),
    revokeAllSessions: unexpected("revokeAllSessions"),
    passwordHashOf: unexpected("passwordHashOf"),
    markReauthenticated: unexpected("markReauthenticated"),
    changePassword: unexpected("changePassword"),
    mfaStateOf: unexpected("mfaStateOf"),
    startMfaEnrollment: unexpected("startMfaEnrollment"),
    resealMfaSecret: unexpected("resealMfaSecret"),
    activateMfa: unexpected("activateMfa"),
    unusedBackupCodes: unexpected("unusedBackupCodes"),
    completeMfaSignIn: unexpected("completeMfaSignIn"),
    recordMfaFailure: unexpected("recordMfaFailure"),
    regenerateBackupCodes: unexpected("regenerateBackupCodes"),
    disableMfa: unexpected("disableMfa"),
    reauthenticateWithStep: unexpected("reauthenticateWithStep"),
    createOidcLoginState: unexpected("createOidcLoginState"),
    consumeOidcLoginState: unexpected("consumeOidcLoginState"),
    signInWithIdentity: unexpected("signInWithIdentity"),
    linkIdentity: unexpected("linkIdentity"),
    unlinkIdentity: unexpected("unlinkIdentity"),
    reauthenticateWithIdentity: unexpected("reauthenticateWithIdentity"),
    setupPending: () => Promise.resolve(false),
    instanceSettings: () => Promise.resolve(UNSET_INSTANCE_SETTINGS),
    setSetupToken: unexpected("setSetupToken"),
    completeSetup: unexpected("completeSetup"),
    registerAccount: unexpected("registerAccount"),
    verifyEmail: unexpected("verifyEmail"),
    resendVerification: unexpected("resendVerification"),
    requestPasswordReset: unexpected("requestPasswordReset"),
    resetPassword: unexpected("resetPassword"),
    requestEmailChange: unexpected("requestEmailChange"),
    cancelPendingEmailChange: unexpected("cancelPendingEmailChange"),
    confirmEmailChange: unexpected("confirmEmailChange"),
    cancelEmailChange: unexpected("cancelEmailChange"),
    emailVerified: unexpected("emailVerified"),
    inspectInvitation: unexpected("inspectInvitation"),
    acceptInvitationWithNewAccount: unexpected("acceptInvitationWithNewAccount"),
    acceptInvitationWithIdentity: unexpected("acceptInvitationWithIdentity"),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

/** The tenant dependencies of the chain for a test that does not exercise tenancy: nothing is resolved, and no transaction is opened. */
export function tenantDependencies(): Pick<ChainDependencies, "tenantResolver" | "withTenant"> {
  const database = fakeDatabase();
  return { tenantResolver: adapters().tenantResolver, withTenant: database.withTenant.bind(database) };
}

/** The rate-limit dependencies of the chain for a test that does not exercise limits: the default registry over an in-memory limiter. */
export function rateLimitDependencies(): Pick<ChainDependencies, "rateLimit" | "rateLimits"> {
  const rateLimits = createRateLimitRegistry(serverConfig());
  return { rateLimit: memoryRateLimiter(rateLimits), rateLimits };
}

export function operation(method: "get" | "post", path: string, operationId: string): OperationDefinition {
  return defineOperation({
    method,
    path,
    operationId,
    tag: "test",
    auth: "anonymous",
    rate: "none",
    responses: {
      200: jsonResponse("ok", z.record(z.string(), z.unknown())),
      404: problemResponse("not found"),
    },
  });
}

export function moduleContext(config: ModuleContext["config"] = serverConfig()): ModuleContext {
  const database = fakeDatabase();
  return { config, logger: recordingLogger(), adapters: adapters(), withTenant: database.withTenant.bind(database) };
}

/** The document entry of an operation, with the policy extensions a real generated document carries. */
export function documentEntry(operation: OperationDefinition): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    "x-slugbase-auth": operation.auth,
    "x-slugbase-rate": operation.rate,
    ...(operation.scope === undefined ? {} : { "x-slugbase-scope": operation.scope }),
    ...(operation.entitlement === undefined ? {} : { "x-slugbase-entitlement": operation.entitlement }),
    ...(operation.audience === undefined ? {} : { "x-slugbase-audience": operation.audience }),
    ...(operation.reauth === true ? { "x-slugbase-reauth": true } : {}),
    ...(operation.idempotency === true ? { "x-slugbase-idempotency": true } : {}),
  };
}

/** A document that declares exactly the given operations. */
export function documentFor(operations: readonly OperationDefinition[]): ContractDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    (paths[operation.path] ??= {})[operation.method] = documentEntry(operation);
  }
  return { paths };
}

/** The document a test server is registered against: the operations its modules contribute, so a test of another stage is not also a test of the document. */
export function documentOf(modules: readonly ServerModule[]): ContractDocument {
  const operations: OperationDefinition[] = [];
  for (const module of modules) {
    try {
      operations.push(...(module.register(moduleContext()).routes ?? []).map((binding) => binding.operation));
    } catch {
      // A module that fails to register is the test's subject; createServer reports it.
    }
  }
  return documentFor(operations);
}

const BEARER_ACCOUNT = "0190a000-0000-7000-8000-0000000000b1";
const BEARER_WORKSPACE = "0190a000-0000-7000-8000-000000000001";

/**
 * A module whose bearer authenticator accepts every `Authorization` header as a read-write token of one
 * account, and the tenant resolver that gives that account a workspace. For a test of a stage other than
 * authentication that sends an `Authorization` header through the whole server: the built-in authenticator
 * refuses a header that is not a token it knows, so such a request would be answered 401 before the stage
 * under test.
 */
export function acceptAnyBearer(): { readonly module: ServerModule; readonly tenantResolver: TenantResolver } {
  return {
    module: {
      name: "accept-any-bearer",
      register: () => ({
        routes: [],
        authenticators: [
          {
            credential: "bearer",
            authenticate: () => Promise.resolve({ kind: "api-token", accountId: BEARER_ACCOUNT, workspaceId: BEARER_WORKSPACE, scope: "read-write" }),
          },
        ],
      }),
    },
    tenantResolver: { available: true, resolve: () => Promise.resolve({ workspaceId: BEARER_WORKSPACE, memberId: BEARER_ACCOUNT, role: "member" }) },
  };
}

export interface RegistrationPolicyModuleOptions {
  readonly name?: string;
  /** The email domain the module refuses, without the `@`; every other address is allowed. */
  readonly domain?: string;
  /** The reason the hook gives; the dispatcher answers `registration_refused` whatever it is. */
  readonly reason?: string;
}

/**
 * A module whose registration policy refuses one email domain and allows every other address, for the tests of
 * the account-creation paths (self-registration, invitation, OIDC) to compose. It refuses on any path.
 */
export function registrationPolicyModule(options: RegistrationPolicyModuleOptions = {}): ServerModule {
  const { name = "registration-policy", domain = "blocked.example", reason = "domain_blocked" } = options;
  return {
    name,
    hooks: {
      registrationPolicy: ({ email }) => (email.toLowerCase().endsWith(`@${domain.toLowerCase()}`) ? HookResult.refuse(reason) : HookResult.allow()),
    },
    register: () => ({}),
  };
}
