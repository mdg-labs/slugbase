import { setTimeout as sleep } from "node:timers/promises";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { getHealth, getReady, getVersion } from "@slugbase/contracts";
import { createBookmarkEntitlements, createEntitlementCheck, createEntitlementService, createEntitlementUpgradeCheck, createOwnedWorkspaceEntitlements, createPasswordPolicy, createSeatEntitlements, loadBreachedPasswords, sessionCookieSpec, type Adapters, type RegistrationSettings } from "@slugbase/core";
import { createAuthStore, createDatabase, entitlementRepository, instanceRepository, type AuthStore, type Database, type MigrationChain } from "@slugbase/db";
import { Hono } from "hono";
import { DEVELOPMENT_BUILD_INFO, type BuildInfo } from "./build-info.ts";
import { renderQrSvg } from "./auth/qr.ts";
import { createPasswordVerifier, hashPassword, verifyHash } from "./auth/password.ts";
import { DEFAULT_REGISTRATION, registrationSettings } from "./auth/registration-settings.ts";
import { ensureSetupToken } from "./auth/setup-token.ts";
import { createMembershipTenantResolver, defersToMembershipResolver } from "./auth/tenant-resolver.ts";
import { createTokenRedeemLimit } from "./auth/token-redeem-limit.ts";
import { createRateLimitRegistry, type ServerConfig, type WorkerConfig } from "./config/index.ts";
import type { Authenticator } from "./http/authenticate.ts";
import { denyEntitlements, noUpgradeAvailable, type EntitlementCheck, type SecondFactorCheck } from "./http/authorize.ts";
import { bodyLimits } from "./http/body-limits.ts";
import {
  RouteTable,
  installChain,
  type ChainEnv,
  type ChainContext,
  type RouteBinding,
  type StageImplementations,
  type StageName,
} from "./http/chain.ts";
import { invalidSubscriber, registeredSubscriber, type EventSubscriber, type RegisteredSubscriber } from "./events/index.ts";
import { createHookDispatcher, invalidHookRefusals, invalidHooks, type HookRefusals, type HookRegistration, type ServerHooks } from "./hooks/index.ts";
import { ProblemError, responseStage } from "./http/problem.ts";
import { validation } from "./http/validation.ts";
import { createMetrics, startMetricsListener, type MetricsListener } from "./metrics/index.ts";
import { assertApplicationRole, runMigrations } from "./migrate/index.ts";
import { loadCommittedDocument } from "./routes/committed-document.ts";
import { probeRoutes } from "./routes/health.ts";
import { authContribution } from "./routes/auth/index.ts";
import { apiTokenRoutes } from "./routes/me/api-tokens.ts";
import { accountDeletionRoutes } from "./routes/me/delete.ts";
import { emailChangeRoutes } from "./routes/me/email.ts";
import { identityRoutes } from "./routes/me/identities.ts";
import { mfaRoutes } from "./routes/me/mfa.ts";
import { profileRoutes } from "./routes/me/profile.ts";
import { apiConfigRoute } from "./routes/meta/config.ts";
import { apiDocs } from "./routes/meta/docs.ts";
import { isOpenApiDocument, openApiRoute } from "./routes/meta/openapi.ts";
import { setupRoutes } from "./routes/setup/index.ts";
import { invitationRoutes } from "./routes/invitations/index.ts";
import { bookmarkRoutes } from "./routes/bookmarks/index.ts";
import { entitlementRoutes } from "./routes/entitlements.ts";
import { instanceRoutes, type InstanceAdminGrantCheck } from "./routes/instance/index.ts";
import { memberRoutes } from "./routes/members/index.ts";
import { workspaceRoutes } from "./routes/workspaces/index.ts";
import { checkRegistrations, type ContractDocument } from "./routes/register.ts";
import { WebRootError, serveWebRoot } from "./routes/static.ts";
import type { JobDefinition, ScheduleDefinition } from "./worker/job.ts";

export type { ChainContext, ChainEnv, MatchedRoute, RouteBinding, RouteHandler, StageName, ValidatedInput } from "./http/chain.ts";
export type { RateLimitState, TakeEmailLimit, TakenLimit } from "./http/rate-limit.ts";
export type {
  ApiTokenPrincipal,
  Authenticator,
  BearerAuthenticator,
  CookieAuthenticator,
  Principal,
  SessionPrincipal,
} from "./http/authenticate.ts";
export type { RequestTenant } from "./http/tenant.ts";
export { CHAIN_STAGES } from "./http/chain.ts";
export type { ContractDocument } from "./routes/register.ts";

/** The structured logger the server, its modules and the core code share. */
export interface Logger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** What a module receives: the same logger, ports and tenant helper as core code (doc 01 section 7.1). */
export interface ModuleContext {
  /** The configuration every process type has; the server's own keys are not part of it. */
  readonly config: WorkerConfig;
  readonly logger: Logger;
  readonly adapters: Readonly<Adapters>;
  /** Every tenant query runs through it (doc 01 section 5.3). */
  readonly withTenant: Database["withTenant"];
}

export interface ModuleContribution {
  /** Operations declared in `@slugbase/contracts`, each with its handler. */
  readonly routes?: readonly RouteBinding[];
  /** Jobs the worker runs, declared with `defineJob`. */
  readonly jobs?: readonly JobDefinition[];
  /** Schedules the worker registers, declared with `defineSchedule`. */
  readonly schedules?: readonly ScheduleDefinition[];
  /** Migration sets applied after the CE chain (doc 01 section 7.3). */
  readonly migrations?: readonly MigrationChain[];
  /**
   * Resolvers of the session cookie and of the API token for stage 4. They add
   * credentials to the chain; they cannot change where authentication runs.
   */
  readonly authenticators?: readonly Authenticator[];
  /**
   * Bindings to the domain events of `@slugbase/core`, each handled by the worker after the change that emitted
   * the event is committed. Delivery is at least once, so a handler is idempotent on `eventId`; an event
   * never vetoes or changes the flow that emitted it (doc 01 section 7.1).
   */
  readonly subscribers?: readonly EventSubscriber[];
}

/**
 * A unit of routes, jobs and migrations composed into the server. A module adds
 * to the middleware chain's routes only: it has no handle on the stages, so it
 * cannot reorder or remove one. Its `hooks` take part in a decision inside a core
 * flow (doc 01 section 13) and receive plain values only.
 */
export interface ServerModule {
  readonly name: string;
  readonly hooks?: ServerHooks;
  /** The refusal codes the module's `deletionGuard` may answer with; each must be on the closed list. */
  readonly hookRefusals?: HookRefusals;
  register(context: ModuleContext): ModuleContribution;
}

export interface CreateServerOptions {
  readonly config: ServerConfig;
  readonly adapters: Adapters;
  readonly modules: readonly ServerModule[];
  /** Migration sets beyond the CE chain, applied in order after it. */
  readonly migrations: readonly MigrationChain[];
  readonly logger: Logger;
  /** How long one hook may take to answer before it counts as failed; by default two seconds. */
  readonly hookTimeoutMs?: number;
  /**
   * The OpenAPI document every route is registered against: an operation must be
   * in it, with the policy it declares. By default the document committed with
   * `@slugbase/contracts`; a composition that adds operations passes the merged one.
   */
  readonly openApiDocument?: ContractDocument;
  /** What `GET /version` reports; by default a development run. The composition root reads it from the build-info file with `loadBuildInfo`. */
  readonly buildInfo?: BuildInfo;
  /**
   * The directory of the built web app, passed in by the composition root. It is served as
   * files, with `index.html` for a browser navigation to a path the app owns; without it the
   * server serves no app. A directory that does not exist or has no `index.html` refuses the start.
   */
  readonly webRoot?: string;
  /**
   * The tenant database; by default a pool on `DATABASE_URL`, opened on first use. The server closes it on shutdown.
   * The role of `DATABASE_URL` is checked at start in production (Q56) only for the pool the server opens itself:
   * a database passed in is connected by the caller, who answers for its role.
   */
  readonly database?: Database;
  /**
   * The system operations of sign-in and the session cookie; by default a pool on `DATABASE_URL`, opened on first use.
   * The server closes it on shutdown, like the tenant database.
   */
  readonly authStore?: AuthStore;
  /**
   * What `PUBLIC_REGISTRATION` and `EMAIL_VERIFICATION_REQUIRED` mean when the operator left them unset
   * (doc 01 section 11): the composition root's choice, never an edition flag (D4). By default registration
   * is closed and verification is not required, the Community Edition's.
   */
  readonly registrationDefaults?: RegistrationSettings;
  /**
   * Whether ordinary accounts may create workspaces on this deployment: the composition root's choice, never an
   * edition flag (D4, doc 02 section 3.2). By default they may not, the Community Edition's; the managed
   * composition passes `true`. The instance setting `allow_workspace_creation` overrides it from the very next request
   * once an instance admin stores a value (doc 02 section 3.2).
   */
  readonly allowWorkspaceCreation?: boolean;
  /**
   * The instant, in milliseconds, the re-authentication window of doc 04 section 4.4 is measured against;
   * by default the system clock. A test passes a clock it moves.
   */
  readonly now?: () => number;
  /**
   * Replaces the entitlement check of stage 9 (doc 01 section 7.5). By default the engine over the
   * composition's `entitlements` adapter decides, and with no source configured (`available: false`) every
   * declared entitlement is refused (`403 entitlement_required`). A test passes a check of its own.
   */
  readonly entitlements?: EntitlementCheck;
  /**
   * Replaces the second-factor check of stage 9 (doc 04 section 10.10, Q45), which by default reads whether the
   * account has a second factor enrolled from the database. A test passes a check of its own.
   */
  readonly secondFactor?: SecondFactorCheck;
  /**
   * Whether an instance admin may grant the instance-admin flag to an account (doc 04 section 10.10, Q44): the
   * composition's choice, never an edition flag (D4). By default it may, the Community Edition's; a composition
   * that must never have an admin passes a check that refuses, and `PATCH /instance/accounts/{id}` answers 403
   * `forbidden` to a request that grants the flag, writing nothing.
   */
  readonly instanceAdminGrant?: InstanceAdminGrantCheck;
  /** How long a shutdown lets in-flight requests finish before cutting them (doc 01 section 3 rule 2). */
  readonly shutdownTimeoutMs?: number;
}

/** The operations that stay answered while the server migrates: the process probes. */
const PROBE_OPERATIONS: ReadonlySet<string> = new Set([getHealth.operationId, getReady.operationId, getVersion.operationId]);

export interface StartOptions {
  /** Overrides `PORT`; 0 picks a free port. */
  readonly port?: number;
  /** Overrides `METRICS_PORT`, which also turns the metrics listener on; 0 picks a free port. */
  readonly metricsPort?: number;
}

export interface RunningServer {
  readonly port: number;
  /** The port of the internal metrics listener; absent when `METRICS_PORT` is unset. */
  readonly metricsPort?: number;
  /**
   * Stops accepting connections, lets in-flight requests finish within the
   * deadline, cuts the rest and closes the database pool. Calling it again
   * returns the same shutdown.
   */
  shutdown(): Promise<void>;
}

export interface Server {
  /** The stages in the order they run. */
  readonly stages: readonly StageName[];
  /** Migration sets in the order they are applied after the CE chain: the argument's, then the modules'. */
  readonly migrations: readonly MigrationChain[];
  readonly jobs: readonly JobDefinition[];
  readonly schedules: readonly ScheduleDefinition[];
  /** Serves one request through the chain. */
  fetch(request: Request): Promise<Response>;
  /**
   * Listens on `PORT`, and on `METRICS_PORT` for the internal `/metrics` listener when it is set.
   * In production it first refuses a `DATABASE_URL` role that is a superuser or owns the database
   * (Q56). With `MIGRATE_ON_START` it then migrates as `DATABASE_MIGRATE_URL` and resolves when that
   * is done; meanwhile the probes answer, `/ready` is `503` and every other route is `503 unavailable`.
   * A failed migration stops the listeners and rejects. Once the database is migrated, a deployment that requires a setup
   * token while the instance has no account generates a new one, replacing the stored one, and prints it to the log.
   */
  start(options?: StartOptions): Promise<RunningServer>;
}

export type CompositionErrorCode =
  | "missing_adapter"
  | "invalid_module"
  | "duplicate_module"
  | "invalid_hook"
  | "invalid_subscriber"
  | "module_failed"
  | "duplicate_route"
  | "invalid_route"
  | "invalid_web_root"
  | "missing_policy"
  | "undocumented_operation"
  | "policy_mismatch"
  | "duplicate_job"
  | "unknown_job"
  | "duplicate_schedule"
  | "invalid_schedule";

/** The composition is invalid; thrown by `createServer` before anything listens. */
export class CompositionError extends Error {
  readonly code: CompositionErrorCode;

  constructor(code: CompositionErrorCode, message: string) {
    super(message);
    this.name = "CompositionError";
    this.code = code;
  }
}

// A Record over every port, so a port added to Adapters without an entry here does not compile.
const ADAPTER_PORTS: Record<keyof Adapters, true> = {
  mail: true,
  ai: true,
  identity: true,
  analytics: true,
  billing: true,
  errors: true,
  clientErrorReport: true,
  challenge: true,
  egress: true,
  rateLimit: true,
  secretBox: true,
  tenantResolver: true,
  entitlements: true,
};

const REQUIRED_ADAPTERS = Object.keys(ADAPTER_PORTS) as (keyof Adapters)[];

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

const DEFAULT_SERVER_POOL_SIZE = 10;

const DEFAULT_AUTH_POOL_SIZE = 4;

// The request id of the transaction that reads a workspace's entitlement version: it writes nothing the audit trail follows.
const ENTITLEMENT_VERSION_REQUEST = "entitlement-version";

export function assertAdapters(adapters: Adapters): void {
  const missing = REQUIRED_ADAPTERS.filter((port) => {
    const adapter = adapters[port] as unknown;
    return typeof adapter !== "object" || adapter === null || typeof (adapter as { available?: unknown }).available !== "boolean";
  });
  if (missing.length > 0) {
    throw new CompositionError(
      "missing_adapter",
      `createServer needs an adapter for ${missing.length === 1 ? "the port" : "the ports"} ${missing.join(", ")}; pass unconfigured() entries for the ports an instance leaves unconfigured`,
    );
  }
}

export interface Composition {
  readonly routes: readonly RouteBinding[];
  readonly jobs: readonly JobDefinition[];
  readonly schedules: readonly ScheduleDefinition[];
  readonly migrations: readonly MigrationChain[];
  readonly authenticators: readonly Authenticator[];
  /** The event subscribers of the modules, in the order the modules were composed. */
  readonly subscribers: readonly RegisteredSubscriber[];
  /** The hooks of the modules, in the order the modules were composed. */
  readonly hooks: readonly HookRegistration[];
}

function shapeOf(binding: RouteBinding): string {
  const path = binding.operation.path.replace(/\{[^}]*\}/g, "{}");
  return `${binding.operation.method.toUpperCase()} ${path}`;
}

// The host without its port: the colon separates the issuer from the account in the otpauth label.
function defaultTotpIssuer(origin: string): string {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "").replaceAll(":", "-");
  return `SlugBase (${host})`;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

// The audience of a route is what exempts it from the cross-site rule, so a
// declaration that cannot be enforced is refused when the server is composed.
function invalidRoute(binding: RouteBinding): string | undefined {
  const { operation, marketingOrigin } = binding;
  if (operation.audience === "marketing-form") {
    if (!["post", "put", "patch", "delete"].includes(operation.method)) {
      return "a marketing-form route must be a mutation";
    }
    if (marketingOrigin === undefined || !isOrigin(marketingOrigin)) {
      return "a marketing-form route needs the origin of the marketing site as marketingOrigin (scheme, host and optional port)";
    }
  } else if (marketingOrigin !== undefined) {
    return "marketingOrigin belongs to a route with audience marketing-form";
  }
  return undefined;
}

export function compose(
  modules: readonly ServerModule[],
  context: ModuleContext,
  migrations: readonly MigrationChain[],
): Composition {
  const names = new Set<string>();
  const routes: RouteBinding[] = [];
  const jobs: JobDefinition[] = [];
  const schedules: ScheduleDefinition[] = [];
  const chains: MigrationChain[] = [...migrations];
  const authenticators: Authenticator[] = [];
  const subscribers: RegisteredSubscriber[] = [];
  const hooks: HookRegistration[] = [];

  for (const module of modules) {
    if (typeof module.name !== "string" || module.name === "" || typeof module.register !== "function") {
      throw new CompositionError("invalid_module", "a module needs a name and a register function");
    }
    if (names.has(module.name)) {
      throw new CompositionError("duplicate_module", `module ${module.name} is composed twice`);
    }
    names.add(module.name);

    if (module.hooks !== undefined) {
      const problem = invalidHooks(module.hooks);
      if (problem !== undefined) {
        throw new CompositionError("invalid_hook", `module ${module.name} registers an invalid hook: ${problem}`);
      }
      if (module.hookRefusals !== undefined) {
        const refusalProblem = invalidHookRefusals(module.hookRefusals);
        if (refusalProblem !== undefined) {
          throw new CompositionError("invalid_hook", `module ${module.name} declares an invalid refusal: ${refusalProblem}`);
        }
      }
      hooks.push({ module: module.name, hooks: module.hooks, refusals: module.hookRefusals });
    }

    let contribution: ModuleContribution;
    try {
      contribution = module.register(context);
    } catch (error) {
      throw new CompositionError(
        "module_failed",
        `module ${module.name} failed to register: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    routes.push(...(contribution.routes ?? []));
    jobs.push(...(contribution.jobs ?? []));
    schedules.push(...(contribution.schedules ?? []));
    chains.push(...(contribution.migrations ?? []));
    authenticators.push(...(contribution.authenticators ?? []));

    const declared: unknown = contribution.subscribers ?? [];
    if (!Array.isArray(declared)) {
      throw new CompositionError("invalid_subscriber", `module ${module.name} registers invalid subscribers: subscribers must be a list`);
    }
    for (const subscriber of declared as unknown[]) {
      const problem = invalidSubscriber(subscriber);
      if (problem !== undefined) {
        throw new CompositionError("invalid_subscriber", `module ${module.name} registers an invalid subscriber: ${problem}`);
      }
      subscribers.push(registeredSubscriber(module.name, subscriber as EventSubscriber));
    }
  }

  for (const binding of routes) {
    const problem = invalidRoute(binding);
    if (problem !== undefined) {
      throw new CompositionError("invalid_route", `${binding.operation.operationId}: ${problem}`);
    }
  }

  const shapes = new Set<string>();
  const operationIds = new Set<string>();
  for (const binding of routes) {
    const shape = shapeOf(binding);
    if (shapes.has(shape) || operationIds.has(binding.operation.operationId)) {
      throw new CompositionError("duplicate_route", `${shape} (${binding.operation.operationId}) is registered twice`);
    }
    shapes.add(shape);
    operationIds.add(binding.operation.operationId);
  }

  const jobNames = new Set<string>();
  for (const job of jobs) {
    if (jobNames.has(job.name)) {
      throw new CompositionError("duplicate_job", `job ${job.name} is registered twice`);
    }
    jobNames.add(job.name);
  }
  const scheduleNames = new Set<string>();
  for (const schedule of schedules) {
    if (scheduleNames.has(schedule.name)) {
      throw new CompositionError("duplicate_schedule", `schedule ${schedule.name} is registered twice`);
    }
    scheduleNames.add(schedule.name);
    if (!jobNames.has(schedule.job)) {
      throw new CompositionError("unknown_job", `schedule ${schedule.name} names the job ${schedule.job}, which no module registers`);
    }
    try {
      jobs.find((job) => job.name === schedule.job)?.parse(schedule.payload ?? {});
    } catch {
      throw new CompositionError("invalid_schedule", `schedule ${schedule.name} carries a payload the job ${schedule.job} does not accept`);
    }
  }

  return { routes, jobs, schedules, migrations: chains, authenticators, subscribers, hooks };
}

/** Answers a request no operation matches, or leaves it to the next handler by returning undefined. */
type Unrouted = (context: ChainContext) => Response | Promise<Response | undefined> | undefined;

function canCutConnections(server: ServerType): server is ServerType & { closeAllConnections(): void; closeIdleConnections(): void } {
  return "closeAllConnections" in server && "closeIdleConnections" in server;
}

/**
 * The Community Edition server (doc 01 section 7.1): the adapters and modules
 * of the composition behind the fixed middleware chain of doc 01 section 4.
 * It fails before listening when a port has no adapter or the modules conflict.
 */
export function createServer(options: CreateServerOptions): Server {
  const { config, logger } = options;
  assertAdapters(options.adapters);

  const committedDocument = loadCommittedDocument();
  const openApiDocument = options.openApiDocument ?? committedDocument;

  const adapters = Object.freeze({ ...options.adapters });

  // What the server serves itself, built before the pool is opened because reading its files can fail.
  // The probes read the migration sets of the finished composition, which the probes themselves are part of.
  let migrationSets: readonly MigrationChain[] = options.migrations;
  const progress = { migrating: false };
  const buildInfo = options.buildInfo ?? DEVELOPMENT_BUILD_INFO;
  // With the breached-password check on, a dataset that cannot be read refuses the start (BreachedDatasetError):
  // starting without it would accept every listed password while the check reads as on.
  const passwordPolicy = createPasswordPolicy({ breached: config.BREACHED_PASSWORD_CHECK ? loadBreachedPasswords() : undefined });
  const authStore = options.authStore ?? createAuthStore({ url: config.DATABASE_URL, poolSize: DEFAULT_AUTH_POOL_SIZE });
  const registration = registrationSettings(config, options.registrationDefaults ?? DEFAULT_REGISTRATION);
  const builtInRoutes: RouteBinding[] = [
    ...probeRoutes({ buildInfo, databaseUrl: config.DATABASE_URL, chains: () => migrationSets, logger, migrating: () => progress.migrating }),
    apiConfigRoute({ config, store: authStore, buildInfo, adapters, registration, logger }),
    openApiRoute({ enabled: config.API_DOCS_ENABLED, document: options.openApiDocument }),
  ];
  const metrics = createMetrics();
  // One verifier serves sign-in, re-authentication and the second factor's password check, so its dummy hash is made once.
  const passwords = createPasswordVerifier();
  // Password sign-in is part of the server, not a module: the session cookie is the one browser credential (doc 04 section 4.1).
  const auth = authContribution({
    store: authStore,
    passwords,
    appOrigin: config.APP_ORIGIN,
    sessionSecret: config.SESSION_SECRET,
    passwordPolicy,
    mail: adapters.mail,
    registration,
    secretBox: adapters.secretBox,
    identity: adapters.identity,
    oidcProviders: config.OIDC_PROVIDERS,
    takeRedeemLimit: createTokenRedeemLimit({
      limiter: adapters.rateLimit,
      registry: createRateLimitRegistry(config),
      logger,
      errors: adapters.errors,
      recordRejection: (bucket) => {
        metrics.recordRateLimitRejection(bucket);
      },
    }),
    // The check below answers it, as it does for the invitation routes: accepting an invitation through a provider needs `members.invite`, except the owner invitation an instance admin issues.
    entitlements: (entitlement, subject, request) => entitlementCheck(entitlement, subject, request),
    // The engine below answers it: a registration, a verification or a first federated sign-in asks the source for the account's `workspaces.ownMax`.
    ownedWorkspaceLimit: (accountId) => ownedWorkspaceEntitlements.limit(accountId, {}),
    now: options.now ?? Date.now,
  });
  builtInRoutes.push(...(auth.routes ?? []));
  // So is first-run setup: it signs the first account in, on the same pool.
  builtInRoutes.push(...setupRoutes({ config, store: authStore, passwordPolicy }));
  const builtIn: ServerModule = {
    name: "@slugbase/server",
    register: () => ({ routes: builtInRoutes, authenticators: auth.authenticators ?? [] }),
  };
  // Requests no operation matches: the paths served as files rather than as operations.
  const docs: readonly Unrouted[] = config.API_DOCS_ENABLED ? [apiDocs()] : [];

  const database = options.database ?? createDatabase({ url: config.DATABASE_URL, poolSize: DEFAULT_SERVER_POOL_SIZE });
  if (options.database === undefined) {
    metrics.setPoolSize(DEFAULT_SERVER_POOL_SIZE);
  }
  const context: ModuleContext = Object.freeze({
    config,
    logger,
    adapters,
    withTenant: metrics.instrumentTenant(database.withTenant.bind(database)),
  });
  // The entitlement engine is part of the server: it asks the composition's source for the values of the catalog, keyed by the
  // version each workspace's row carries (doc 01 section 7.5). Stage 9 and `GET /entitlements` both read it.
  const entitlementService = createEntitlementService({
    source: adapters.entitlements,
    versions: {
      read: ({ accountId, workspaceId }) =>
        context.withTenant({ accountId, workspaceId, requestId: ENTITLEMENT_VERSION_REQUEST }, (tx) => entitlementRepository(tx).version()),
    },
  });
  builtInRoutes.push(...entitlementRoutes({ withTenant: context.withTenant, service: entitlementService }));
  // So are the bookmarks of the active workspace: created under the workspace's `bookmarks.max` (the ceiling is read from the engine, the count is taken in the database) and read back by their owner.
  builtInRoutes.push(...bookmarkRoutes({ entitlements: createBookmarkEntitlements(entitlementService), cursorSecret: config.SESSION_SECRET }));
  const ownedWorkspaceEntitlements = createOwnedWorkspaceEntitlements(entitlementService);
  // Stage 9 and the handlers that decide an entitlement themselves (accepting an invitation) ask the same check, so an operation is gated the same way wherever it is decided.
  const entitlementCheck: EntitlementCheck = options.entitlements ?? (adapters.entitlements.available ? createEntitlementCheck(entitlementService) : denyEntitlements);
  const upgradeCheck = options.entitlements === undefined && adapters.entitlements.available ? createEntitlementUpgradeCheck(entitlementService) : noUpgradeAvailable;
  // The CE instance admin's operations are part of the server and mounted in every composition: the policy admits no one on a deployment
  // where no account holds the flag (Q44), so a composition needs no switch of its own.
  builtInRoutes.push(
    ...instanceRoutes({
      withTenant: context.withTenant,
      databaseUrl: config.DATABASE_URL,
      chains: () => migrationSets,
      buildInfo,
      adapters,
      registration,
      appOrigin: config.APP_ORIGIN,
      ...(options.instanceAdminGrant === undefined ? {} : { instanceAdminGrant: options.instanceAdminGrant }),
    }),
  );
  // The signed-in account is part of the server like its sign-in: it reads the account's own rows and memberships.
  builtInRoutes.push(...profileRoutes({ withTenant: context.withTenant }));
  // So is the change of the account's email address: the request records the address and queues its two mails, and the two links redeem anonymously.
  builtInRoutes.push(...emailChangeRoutes({ store: authStore, mail: adapters.mail }));
  // So is the deletion of the account: it deletes the account of the session and the workspaces where it is the only member, after the deletion guard of the composition allows it.
  builtInRoutes.push(...accountDeletionRoutes({ withTenant: context.withTenant, cookie: sessionCookieSpec(config.APP_ORIGIN) }));
  // So are the account's workspaces: listed, with the creation policy (the stored instance setting, else the composition root's default), created and switched to in an account-level transaction; the ownership transfer rotates the caller's session token and mails the new owner.
  builtInRoutes.push(...workspaceRoutes({ withTenant: context.withTenant, creationDefault: options.allowWorkspaceCreation ?? false, cookie: sessionCookieSpec(config.APP_ORIGIN), mail: adapters.mail, ownedWorkspaces: ownedWorkspaceEntitlements }));
  // So are the members of the active workspace: listed with the co-member projection of their accounts, and their roles changed under the last-owner rule the database enforces.
  builtInRoutes.push(...memberRoutes({ cursorSecret: config.SESSION_SECRET, cookie: sessionCookieSpec(config.APP_ORIGIN) }));
  // So are the invitations of the active workspace: an admin invites an address, and the invitation's email is queued with it when the composition can send mail; the pending ones are listed, resent, linked and revoked.
  builtInRoutes.push(
    ...invitationRoutes({
      mail: adapters.mail,
      cursorSecret: config.SESSION_SECRET,
      appOrigin: config.APP_ORIGIN,
      store: authStore,
      withTenant: context.withTenant,
      cookie: sessionCookieSpec(config.APP_ORIGIN),
      passwordPolicy,
      hashPassword,
      entitlements: entitlementCheck,
      upgradeAvailable: upgradeCheck,
    }),
  );
  // So are the account's personal API tokens: created, listed and revoked in an account-level transaction on the account's own rows.
  builtInRoutes.push(...apiTokenRoutes({ withTenant: context.withTenant, cursorSecret: config.SESSION_SECRET }));
  // So are the identities linked to the account: listed in an account-level transaction, unlinked by a system operation that checks the account keeps another way to sign in.
  builtInRoutes.push(...identityRoutes({ withTenant: context.withTenant, store: authStore, cursorSecret: config.SESSION_SECRET }));
  // So is the second factor's management: enrolment reads the account's email for the authenticator entry and writes the sealed secret;
  // regenerating the backup codes and turning the factor off check a code, and the latter the password too.
  builtInRoutes.push(
    ...mfaRoutes({
      store: authStore,
      secretBox: adapters.secretBox,
      withTenant: context.withTenant,
      cookie: sessionCookieSpec(config.APP_ORIGIN),
      mail: adapters.mail,
      hashCode: hashPassword,
      verifyCode: verifyHash,
      passwords,
      now: options.now ?? Date.now,
      issuer: config.TOTP_ISSUER ?? defaultTotpIssuer(config.APP_ORIGIN),
      renderQr: renderQrSvg,
    }),
  );

  let composition: Composition;
  let webFiles: Unrouted | undefined;
  try {
    if (options.webRoot !== undefined) {
      try {
        webFiles = serveWebRoot(options.webRoot);
      } catch (error) {
        throw error instanceof WebRootError ? new CompositionError("invalid_web_root", error.message) : error;
      }
    }
    composition = compose([builtIn, ...options.modules], context, options.migrations);
    migrationSets = composition.migrations;
    // The built-in routes are checked against the document committed with the contracts, whatever
    // document the modules' routes are registered against.
    const builtInSet = new Set(builtInRoutes);
    const unregistrable =
      checkRegistrations(builtInRoutes, committedDocument) ??
      checkRegistrations(
        composition.routes.filter((binding) => !builtInSet.has(binding)),
        openApiDocument,
      );
    if (unregistrable !== undefined) {
      throw new CompositionError(unregistrable.code, unregistrable.message);
    }
  } catch (error) {
    void database.close();
    void authStore.close();
    throw error;
  }

  // The reference first, so the app never answers for it.
  const unrouted: readonly Unrouted[] = webFiles === undefined ? docs : [...docs, webFiles];
  const responseValidation = config.NODE_ENV === "production" ? "strip" : "throw";
  const validateResponse = responseStage(responseValidation);
  const chainStages: StageImplementations = {
    // The first stage that can answer without a dependency: while the server migrates, nothing but a
    // probe goes further, so no authenticator or handler reads a schema that is not there yet.
    "body-limits": (context, next) => {
      if (progress.migrating && !PROBE_OPERATIONS.has(context.get("route")?.operation.operationId ?? "")) {
        throw new ProblemError("unavailable", "The service is starting and will be available shortly.");
      }
      return bodyLimits(context, next);
    },
    // An unmatched request has nothing to validate or authorize, so the stage that
    // precedes the handler is where a file is answered: every earlier stage has run,
    // and the response stages still see the answer.
    validation: async (context, next) => {
      if (context.get("route") === undefined) {
        for (const serve of unrouted) {
          const response = await serve(context);
          if (response !== undefined) {
            return response;
          }
        }
      }
      return validation(context, next);
    },
    // The committed document is sent as stored; checking it must not re-serialise it.
    response: (context) =>
      isOpenApiDocument(context.get("route")?.operation.operationId, context.res.status) ? undefined : validateResponse(context),
  };

  const app = new Hono<ChainEnv>();
  const stages = installChain(app, {
    logger,
    routes: new RouteTable(composition.routes),
    hooks: createHookDispatcher({
      registrations: composition.hooks,
      clientErrorReport: adapters.clientErrorReport,
      // An acceptance's seat limit starts from the engine's `seats.max` and is then replaced by what the seat-check hooks answer (doc 01 section 13.1).
      seats: createSeatEntitlements(entitlementService),
      logger,
      ...(options.hookTimeoutMs === undefined ? {} : { timeoutMs: options.hookTimeoutMs }),
    }),
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
    appOrigin: config.APP_ORIGIN,
    challenge: adapters.challenge,
    errors: adapters.errors,
    rateLimit: adapters.rateLimit,
    rateLimits: createRateLimitRegistry(config),
    authenticators: composition.authenticators,
    // A composition that has not chosen a resolver gets the one that reads the principal's memberships (doc 01 section 5.2).
    tenantResolver: defersToMembershipResolver(adapters.tenantResolver)
      ? createMembershipTenantResolver({ withTenant: context.withTenant })
      : adapters.tenantResolver,
    withTenant: context.withTenant,
    ...(options.now === undefined ? {} : { now: options.now }),
    entitlements: entitlementCheck,
    upgradeAvailable: upgradeCheck,
    // Stage 9 asks the database whether the admin's account has a second factor; the default check reads it in an account-level transaction of its own, not on the request's.
    secondFactor:
      options.secondFactor ??
      (({ accountId, requestId }) => context.withTenant({ accountId, requestId }, (tx) => instanceRepository(tx).secondFactorEnrolled())),
    responseValidation,
    metrics,
  }, chainStages);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  return {
    stages,
    migrations: composition.migrations,
    jobs: composition.jobs,
    schedules: composition.schedules,
    fetch: async (request) => app.fetch(request),

    async start(startOptions = {}) {
      if (config.NODE_ENV === "production" && options.database === undefined) {
        try {
          await assertApplicationRole({
            url: config.DATABASE_URL,
            allowOwnerConnection: config.SLUGBASE_ALLOW_OWNER_CONNECTION,
            logger,
          });
        } catch (error) {
          await Promise.all([database.close(), authStore.close()]);
          throw error;
        }
      }
      const migrateUrl = config.MIGRATE_ON_START ? config.DATABASE_MIGRATE_URL : undefined;
      if (config.MIGRATE_ON_START && migrateUrl === undefined) {
        await Promise.all([database.close(), authStore.close()]);
        throw new Error("DATABASE_MIGRATE_URL is required while MIGRATE_ON_START is true");
      }
      let draining = false;
      const listener = createAdaptorServer({
        overrideGlobalObjects: false,
        fetch: async (request, env) => {
          const response = await app.fetch(request, env);
          if (!draining) {
            return response;
          }
          const closing = new Response(response.body, response);
          closing.headers.set("connection", "close");
          return closing;
        },
      });
      if (!canCutConnections(listener)) {
        throw new Error("the listener cannot close its connections");
      }

      const requested = startOptions.port ?? config.PORT;
      const metricsRequested = startOptions.metricsPort ?? config.METRICS_PORT;
      if (metricsRequested !== undefined && metricsRequested !== 0 && metricsRequested === requested) {
        throw new Error("METRICS_PORT must differ from PORT: /metrics is never served on the public listener");
      }
      const port = await new Promise<number>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(requested, () => {
          listener.off("error", reject);
          const address = listener.address();
          resolve(typeof address === "object" && address !== null ? address.port : requested);
        });
      });
      logger.info("Listening", { port });

      let metricsListener: MetricsListener | undefined;
      let shutdown: Promise<void> | undefined;
      const stop = async (): Promise<void> => {
        draining = true;
        await metricsListener?.close();
        const closed = new Promise<void>((resolve) => {
          listener.close(() => {
            resolve();
          });
        });
        listener.closeIdleConnections();

        const finished = new AbortController();
        const deadline = sleep(shutdownTimeoutMs, "deadline" as const, { signal: finished.signal }).catch(() => "closed" as const);
        const outcome = await Promise.race([closed.then(() => "closed" as const), deadline]);
        finished.abort();
        if (outcome === "deadline") {
          logger.warn("Shutdown deadline reached; cutting the open connections", { timeoutMs: shutdownTimeoutMs });
          listener.closeAllConnections();
          await closed;
        }
        await Promise.all([database.close(), authStore.close()]);
      };

      if (metricsRequested !== undefined) {
        try {
          metricsListener = await startMetricsListener({ metrics, port: metricsRequested, logger });
        } catch (error) {
          await (shutdown ??= stop());
          throw error;
        }
      }

      if (migrateUrl !== undefined) {
        // The listeners are up and the chain answers the probes; everything else waits for this.
        progress.migrating = true;
        try {
          logger.info("Migrating the database");
          const { applied } = await runMigrations({ url: migrateUrl, chains: composition.migrations, jobs: composition.jobs });
          logger.info("The database is migrated", { applied: applied.length });
        } catch (error) {
          await (shutdown ??= stop());
          throw error;
        }
        progress.migrating = false;
      }

      // The database now has the schema this build runs with; a first start while the instance has no
      // account prints the setup token (doc 02 section 2.2).
      if (config.SETUP_ENABLED && config.SETUP_TOKEN_REQUIRED) {
        await ensureSetupToken({ store: authStore, logger });
      }

      return {
        port,
        ...(metricsListener === undefined ? {} : { metricsPort: metricsListener.port }),
        shutdown: () => (shutdown ??= stop()),
      };
    },
  };
}
