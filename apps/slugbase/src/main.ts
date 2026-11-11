import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HttpEgress,
  createLookupBudget,
  SharpImageCodec,
  createFullEntitlementSource,
  createLogOnlyMail,
  createOidcIdentity,
  createRateLimiter,
  createSecretBox,
  createSentryErrorReport,
  createOpenAiCompatibleAi,
  createSmtpMail,
  type CreateEgressOptions,
  type LookupBudget,
  type MailTemplates,
} from "@slugbase/adapters";
import "@slugbase/contracts";
import {
  ACCOUNT_NOTIFICATIONS,
  unconfigured,
  type Adapters,
  type AiSuggestPort,
  type EgressPort,
  type IdentityPort,
  type MailPort,
  type RegistrationSettings,
} from "@slugbase/core";
import { createRateLimitStore, createUsageStore, type MigrationChain } from "@slugbase/db";
import { createMailTemplates } from "@slugbase/email";
import {
  ConfigError,
  PROCESS_TYPES,
  RATE_LIMIT_BUCKETS,
  createAccountOnlyTenantResolver,
  createLogger,
  createRateLimitRegistry,
  createServer,
  createUsageBuffer,
  createWorker,
  isProcessType,
  loadBuildInfo,
  loadConfig,
  runMigrations,
  type Logger,
  type MigrateConfig,
  type ProcessType,
  type RunningWorker,
  type Server,
  type ServerConfig,
  type Worker,
  type WorkerConfig,
} from "@slugbase/server";

// The process type is the command of the one image (doc 01 section 3): the
// configuration of that type is validated before anything else starts, and an
// invalid environment exits non-zero naming the keys, never their values. Until
// the configuration is valid there is no log level, so those lines are written
// by hand; the running server logs through pino at `LOG_LEVEL`.

type Level = "info" | "warn" | "error";

function log(level: Level, message: string, fields: Readonly<Record<string, unknown>> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

interface SignalTrap {
  /** The first shutdown signal received so far. */
  received(): NodeJS.Signals | undefined;
  /** Calls `listener` with the first shutdown signal, once, if it has not been received yet. */
  notify(listener: (signal: NodeJS.Signals) => void): void;
}

// The server and the worker trap the shutdown signals before anything else
// runs, even before the configuration is loaded: until a handler is installed a
// signal takes the default action, which kills the process with pg-boss, the
// pools and a running migration left as they were. `migrate` does not trap
// them; a signal still ends it.
function trapShutdownSignals(): SignalTrap {
  let first: NodeJS.Signals | undefined;
  let listener: ((signal: NodeJS.Signals) => void) | undefined;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      if (first !== undefined) {
        return;
      }
      first = signal;
      listener?.(signal);
    });
  }
  return {
    received: () => first,
    notify: (next) => {
      listener = next;
    },
  };
}

// Starts `startUp` and stops the process on the first trapped signal: `shutdown`
// lets in-flight work finish within its deadline and closes the pools. A signal
// during start-up waits for it to settle and then shuts down what it brought up;
// a start-up that fails still throws to the caller, which exits non-zero.
async function runUntilSignal(
  trap: SignalTrap,
  startUp: () => Promise<{ shutdown(): Promise<void> }>,
  logger: Logger,
): Promise<void> {
  const started: { running?: { shutdown(): Promise<void> } } = {};
  let stopping = false;

  const stop = (): void => {
    if (started.running === undefined || trap.received() === undefined || stopping) {
      return;
    }
    stopping = true;
    started.running.shutdown().then(
      () => {
        logger.info("Shutdown complete");
        process.exit(0);
      },
      (error: unknown) => {
        logger.error("Shutdown failed", { error: error instanceof Error ? error.name : typeof error });
        process.exit(1);
      },
    );
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info("Shutting down", { signal });
    stop();
  };

  trap.notify(onSignal);
  const early = trap.received();
  if (early !== undefined) {
    onSignal(early);
  }
  started.running = await startUp();
  stop();
}

// The build (scripts/build.ts) puts the server bundle, the web app and the
// build-info file side by side in dist/, and the image copies that directory as
// it is. A run from src/ has neither next to it: a missing build-info file is a
// development run, and a missing web build serves the API only; a web directory
// that is there but broken refuses the start.
const BUILD_INFO_FILE = new URL("./build-info.json", import.meta.url);
const WEB_ROOT = fileURLToPath(new URL("./web", import.meta.url));

// CE composes the unconfigured defaults of every port and no extra modules or
// migration sets; a configured adapter replaces its default here. The migration
// sets are the ones `migrate` and the server's migrate-on-start both apply.
const MIGRATIONS: readonly MigrationChain[] = [];

// What PUBLIC_REGISTRATION and EMAIL_VERIFICATION_REQUIRED mean when the operator leaves them unset (doc 02
// section 2.2, doc 01 section 11): CE opens no registration, and verifies an address only when mail can
// carry the link. A key the operator sets wins.
const REGISTRATION_DEFAULTS: RegistrationSettings = { publicRegistration: false, emailVerificationRequired: false };

// Whether ordinary accounts may create workspaces (doc 02 section 3.2): CE leaves it to the instance admin, who
// creates them from the admin area; the managed composition passes true. No edition flag decides it (D4).
const ALLOW_WORKSPACE_CREATION = false;

const RATE_LIMIT_POOL_SIZE = 4;

// Opens of bookmarks are counted in this process's memory and written to the database every ten seconds and once more on a graceful
// shutdown, by one call of the system operation `sys_flush_open_counts` on a pool of its own as the role of `DATABASE_URL` (doc 01
// section 8.1). The buffer belongs to the server process, so the timer is started and stopped by the server it is handed to, and the
// pool connects on the first flush. The worker has none: nothing there counts an open.
function composeUsage(config: ServerConfig, logger: Logger): ReturnType<typeof createUsageBuffer> {
  return createUsageBuffer({ store: createUsageStore({ url: config.DATABASE_URL }), logger });
}

// The templates are the ones of `@slugbase/email`, with every link on the deployment's own origin. A
// notification the core can name that has no template stops the process at start-up, not at the first send.
function mailTemplates(config: ServerConfig | WorkerConfig): MailTemplates {
  const templates = createMailTemplates({ appOrigin: config.APP_ORIGIN });
  for (const name of ACCOUNT_NOTIFICATIONS) {
    if (!Object.hasOwn(templates, name)) {
      throw new Error(`the mail template ${name} is missing`);
    }
  }
  return templates;
}

// Mail is the SMTP adapter when the operator set the SMTP keys, and the log-only adapter, which reports
// itself unavailable, when not. The configuration refuses a partial set: the host, port, security mode and sender
// are all set or all unset, and the credentials are a pair that is set only with them. No credentials means an
// authless relay.
function composeMail(config: ServerConfig | WorkerConfig, logger: Logger): MailPort {
  const { SMTP_HOST: host, SMTP_PORT: port, SMTP_SECURITY: security, SMTP_USER: user, SMTP_PASS: pass, SMTP_FROM: from } = config;
  if (host === undefined || port === undefined || security === undefined || from === undefined) {
    return createLogOnlyMail({ logger });
  }
  const auth = user === undefined || pass === undefined ? undefined : { user, pass };
  return createSmtpMail({ host, port, security, ...(auth === undefined ? {} : { auth }), from, templates: mailTemplates(config) });
}

// What `composeAdapters` is told about the process it composes besides its configuration. The server and the worker of
// one process (`server --with-worker`) hold the lookup budget the egress instances draw on and the shared egress instance
// in common; without them `composeAdapters` makes both for the process it composes. `process` names the side being
// composed: it tags every error report, and only the server registers the trace provider, since only the server opens spans.
export interface ProcessSharing {
  readonly lookups?: LookupBudget;
  readonly egress?: EgressPort;
  readonly process?: Exclude<ProcessType, "migrate">;
}

// What a test may change about the egress instances the composition builds: the resolver, and the allowances that
// the adapter itself refuses when `NODE_ENV` is `production`. `nodeEnv` is always set after the options are spread, so
// no options object can replace the process's own value, whatever it carries.
export type EgressTestOptions = Pick<CreateEgressOptions, "resolve" | "testOnly">;

// The egress instances of one process (the shared one, the AI adapter's and the identity adapter's) draw on one budget of
// host-name lookups, three in all against the four threads libuv starts, because each lookup holds a thread until the name
// server answers (doc 01 section 6). Each instance reserves one slot that the others cannot take, so a stall on one
// instance, whether a member's fetch or a provider's redirect, leaves the other two a lookup. An instance that is not built
// reserves nothing: the worker's shared instance may use all three.
const LOOKUP_RESERVE = 1;

// Identity is the OIDC adapter when the operator configured a provider, and the unconfigured default when not.
// Only the server serves sign-in, so only its configuration has providers. The adapter reaches the providers
// through the egress port and discovers them when they are first listed, so a provider that is down at start-up
// is not marked unavailable for good. The list of providers waits for every provider that is not cached yet, and the
// adapter's requests run one at a time, each up to 5 s, so a slow provider delays the list; a provider that fails
// stays out of the list for the failure TTL.
// The adapter gets an egress instance of its own, so a member who fills the shared instance's lookup slots cannot
// make a sign-in fail with it (doc 01 section 6). Its lookups draw on the process's lookup budget with a slot
// reserved for it (`LOOKUP_RESERVE`), which is all the lookups it is guaranteed, so the adapter runs that many
// requests at once and queues the rest in order: a long provider list or a burst of sign-ins is served in turns
// and its own requests do not refuse one another. The instance keeps a lookup's slot until the lookup finishes,
// even after the request that started it timed out, so while a resolver hangs a later request can still be
// refused. The instance carries the operator's allowance for a provider on a private address (Q120) and nothing else: the
// issuer origin of each provider whose `OIDC_<SLUG>_ALLOWED_PRIVATE_HOST` the configuration accepted, so a provider that
// names no host, the shared instance and the AI instance get no exemption from it.
export function composeIdentity(
  config: ServerConfig | WorkerConfig,
  logger: Logger,
  egressOptions: EgressTestOptions,
  lookups: LookupBudget = createLookupBudget(),
): IdentityPort {
  const providers = "OIDC_PROVIDERS" in config ? config.OIDC_PROVIDERS : [];
  if (providers.length === 0) {
    return unconfigured().identity;
  }
  const privateOrigins = "OIDC_PRIVATE_ORIGINS" in config ? config.OIDC_PRIVATE_ORIGINS : [];
  const egress = new HttpEgress({
    ...egressOptions,
    nodeEnv: config.NODE_ENV,
    lookups: lookups.share(LOOKUP_RESERVE),
    ...(privateOrigins.length === 0 ? {} : { privateOrigin: privateOrigins }),
  });
  logger.info("OIDC sign-in configured", { providers: providers.map((provider) => provider.slug), privateProviders: privateOrigins.length });
  return createOidcIdentity({ providers, egress, logger, maxConcurrentRequests: LOOKUP_RESERVE });
}

// AI suggestions are the OpenAI-compatible adapter when the operator configured an endpoint, and the unconfigured default,
// which reports itself unavailable, when not. Only the server answers suggestions, so only its configuration has the keys.
// The adapter gets an egress instance of its own: the shared one that metadata and favicons use is built
// without any allowance, and this one carries the operator's allowance for a private endpoint (Q90) when
// `AI_ALLOWED_PRIVATE_HOST` is set, which the configuration only accepts when it is the host of `AI_BASE_URL`.
// A provider's redirect can lead to a host whose name server stalls, so the instance's lookups draw on the process's
// lookup budget with a slot reserved for it (`LOOKUP_RESERVE`) and can hold no more than the budget leaves it.
function composeAi(config: ServerConfig | WorkerConfig, logger: Logger, lookups: LookupBudget, egressOptions: EgressTestOptions): AiSuggestPort {
  if (!("AI_BASE_URL" in config)) {
    return unconfigured().ai;
  }
  const { AI_BASE_URL: baseUrl, AI_API_KEY: apiKey, AI_MODEL: model, AI_PROVIDER_NAME: provider, AI_ALLOWED_PRIVATE_HOST: privateHost } = config;
  if (baseUrl === undefined || model === undefined || provider === undefined) {
    return unconfigured().ai;
  }
  const egress = new HttpEgress({
    ...egressOptions,
    nodeEnv: config.NODE_ENV,
    lookups: lookups.share(LOOKUP_RESERVE),
    ...(privateHost === undefined ? {} : { privateOrigin: new URL(baseUrl).origin }),
  });
  logger.info("AI suggestions configured", { provider, privateEndpoint: privateHost !== undefined });
  return createOpenAiCompatibleAi({ baseUrl, ...(apiKey === undefined ? {} : { apiKey }), model, egress });
}

// The secret box is built from the environment by the server and the worker
// alike: `ENCRYPTION_KEY` seals, the previous keys only open. A key the box
// refuses stops the process before it serves or works. Error reporting is the
// Sentry-protocol adapter when the operator set `ERROR_REPORT_DSN`, and the
// no-op default (errors are logged only) when not. The adapter tags its events with the process that sent them; the server
// also samples traces at `ERROR_REPORT_TRACES_SAMPLE_RATE`, and `ERROR_REPORT_CHECK_INS` has the worker report its scheduled
// jobs. Egress is always on (doc 01
// section 6): the adapter that resolves, validates and pins every outbound request.
// The composition leaves the tenant resolver to `createServer`: the account-only resolver below
// stands for "no choice made", and `createServer` replaces it with the membership resolver, which
// puts each request in the principal's active workspace through its memberships (doc 01 section
// 5.2). Sign-in and the session cookie are served by `createServer` itself, on `DATABASE_URL`.
// The rate limiter keeps its tokens in Postgres through the system operation of
// `@slugbase/db`, on a small pool of its own as the role of `DATABASE_URL`; the
// pool connects on the first limited request, not at start-up. Its limits are the
// bucket registry of the server package, with the `RATE_LIMIT_*` keys applied. The entitlement source is the
// full one: every flag is granted and every limit is unlimited (doc 01 section 7.5); the server's engine
// reads it, and no edition flag decides anything (D4).
export function composeAdapters(
  config: ServerConfig | WorkerConfig,
  logger: Logger,
  egressOptions: EgressTestOptions = {},
  sharing: ProcessSharing = {},
): Adapters {
  const secretBox = createSecretBox({
    current: { keyId: config.ENCRYPTION_KEY_ID, key: Buffer.from(config.ENCRYPTION_KEY, "base64") },
    previous: config.ENCRYPTION_KEY_PREVIOUS.map(({ keyId, key }) => ({ keyId, key: Buffer.from(key, "base64") })),
  });
  logger.info("Secret box ready", {
    keyId: config.ENCRYPTION_KEY_ID,
    previousKeys: config.ENCRYPTION_KEY_PREVIOUS.length,
  });
  const defaults = unconfigured();
  const errors =
    config.ERROR_REPORT_DSN === undefined
      ? defaults.errors
      : createSentryErrorReport({
          dsn: config.ERROR_REPORT_DSN,
          environment: config.NODE_ENV,
          ...(sharing.process === undefined ? {} : { tags: { process: sharing.process } }),
          ...(sharing.process === "server" && config.ERROR_REPORT_TRACES_SAMPLE_RATE !== undefined
            ? { tracesSampleRate: config.ERROR_REPORT_TRACES_SAMPLE_RATE }
            : {}),
          checkIns: config.ERROR_REPORT_CHECK_INS,
        });
  logger.info(errors.available ? "Error reporting ready" : "Error reporting is off; errors are only logged");
  const limits = createRateLimitRegistry(config);
  const rateLimit = createRateLimiter({
    store: createRateLimitStore({ url: config.DATABASE_URL, poolSize: RATE_LIMIT_POOL_SIZE }),
    limits: (name) => limits.window(name),
  });
  logger.info("Rate limiter ready", { buckets: RATE_LIMIT_BUCKETS.length });
  const mail = composeMail(config, logger);
  logger.info(mail.available ? "Mail ready" : "Mail is off; messages are only logged");
  const lookups = sharing.lookups ?? createLookupBudget();
  // The shared instance is built first and every other instance joins its budget. One that the process already holds
  // (`server --with-worker`) is used as it is, and takes no further slot of the budget.
  const egress = sharing.egress ?? new HttpEgress({ ...egressOptions, nodeEnv: config.NODE_ENV, lookups: lookups.share(LOOKUP_RESERVE) });
  return {
    ...defaults,
    mail,
    ai: composeAi(config, logger, lookups, egressOptions),
    secretBox,
    errors,
    egress,
    imageCodec: new SharpImageCodec(),
    identity: composeIdentity(config, logger, egressOptions, lookups),
    rateLimit,
    entitlements: createFullEntitlementSource(),
    tenantResolver: createAccountOnlyTenantResolver(),
  };
}

// The server of the CE composition: the same one whether it runs in a process of its own or beside the worker.
function composeServer(
  config: ServerConfig,
  logger: Logger,
  adapters: Adapters = composeAdapters(config, logger, {}, { process: "server" }),
): Server {
  const serveWeb = existsSync(WEB_ROOT);
  if (!serveWeb) {
    logger.warn("There is no web build; only the API is served", { webRoot: WEB_ROOT });
  }
  return createServer({
    config,
    adapters,
    modules: [],
    migrations: MIGRATIONS,
    usage: composeUsage(config, logger),
    registrationDefaults: REGISTRATION_DEFAULTS,
    allowWorkspaceCreation: ALLOW_WORKSPACE_CREATION,
    logger,
    buildInfo: loadBuildInfo(BUILD_INFO_FILE),
    ...(serveWeb ? { webRoot: WEB_ROOT } : {}),
  });
}

// The worker of the CE composition, likewise the same in either mode.
function composeWorker(
  config: WorkerConfig,
  logger: Logger,
  adapters: Adapters = composeAdapters(config, logger, {}, { process: "worker" }),
): Worker {
  return createWorker({
    config,
    adapters,
    modules: [],
    logger,
  });
}

// The adapters of the two sides of `server --with-worker`. Each side keeps the adapters of its process type, but one process
// has one budget of three host-name lookups against the four threads libuv starts, shared with password hashing (doc 01
// section 6), so the sides cannot each make a budget of their own: two would let six lookups run at once, and a name
// server that never answers could then hold every thread and stall every sign-in. The server's instances (shared, AI,
// OIDC) reserve their slots as in a server of its own, which leaves none to reserve for a worker instance, so the worker
// uses the server's shared egress instance: the metadata and favicon jobs and the requests of members draw on the same
// slots, and the AI and the identity adapters keep theirs.
export function composeWithWorkerAdapters(
  serverConfig: ServerConfig,
  workerConfig: WorkerConfig,
  logger: Logger,
  egressOptions: EgressTestOptions = {},
): { readonly server: Adapters; readonly worker: Adapters } {
  const lookups = createLookupBudget();
  const server = composeAdapters(serverConfig, logger, egressOptions, { lookups, process: "server" });
  const worker = composeAdapters(workerConfig, logger, egressOptions, { lookups, egress: server.egress, process: "worker" });
  return { server, worker };
}

async function runServer(config: ServerConfig, trap: SignalTrap): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const server = composeServer(config, logger);
  await runUntilSignal(trap, () => server.start(), logger);
}

// `server --with-worker` (Q11, doc 01 section 2.1) runs the two compositions above in one process, and nothing else
// differs from the two-container setup: each keeps the adapters, the pools and the configuration of its own process
// type, and the worker is built from the worker's schema, so it reads no key that the worker process would not. The one
// thing the sides share is the process's budget of host-name lookups (see `composeWithWorkerAdapters`).
// The server starts first: with MIGRATE_ON_START it migrates and installs the pg-boss schema before `start` resolves,
// and the worker never migrates, so it has to start after that. The worker opens no metrics listener here, because
// the one `METRICS_PORT` belongs to the server's; that listener serves the worker's samples too, labelled
// `process="worker"`, from the worker object built before the server starts. A worker that fails to start stops the
// server again, so a failed start leaves nothing listening.
async function runServerWithWorker(serverConfig: ServerConfig, workerConfig: WorkerConfig, trap: SignalTrap): Promise<void> {
  const logger = createLogger({ level: serverConfig.LOG_LEVEL });
  const adapters = composeWithWorkerAdapters(serverConfig, workerConfig, logger);
  const server = composeServer(serverConfig, logger, adapters.server);
  const workerWithoutMetrics: WorkerConfig = { ...workerConfig, METRICS_PORT: undefined };
  const worker = composeWorker(workerWithoutMetrics, logger, adapters.worker);
  await runUntilSignal(
    trap,
    async () => {
      const runningServer = await server.start({ workerMetrics: worker.metrics });
      let runningWorker: RunningWorker;
      try {
        runningWorker = await worker.start();
      } catch (error) {
        await runningServer.shutdown().catch((cleanup: unknown) => {
          logger.error("Cleanup after a failed start failed", { error: cleanup instanceof Error ? cleanup.name : typeof cleanup });
        });
        throw error;
      }
      // Both stops run at once: each waits up to its own deadline for in-flight work, and the image's stop timeout
      // has to cover the longer of them, not their sum. The server stops accepting connections at once; the worker
      // stops fetching and lets its active jobs finish. A stop that fails does not keep the other from finishing.
      return {
        shutdown: async () => {
          const outcomes = await Promise.allSettled([
            runningServer.shutdown().then(() => {
              logger.info("Server stopped");
            }),
            runningWorker.shutdown().then(() => {
              logger.info("Worker stopped");
            }),
          ]);
          const failed = outcomes.find((outcome) => outcome.status === "rejected");
          if (failed !== undefined) {
            throw failed.reason;
          }
        },
      };
    },
    logger,
  );
}

// `migrate` applies the CE chain, installs the pg-boss schema with the queues of
// the worker's built-in jobs and applies the migration sets, as the migrator role
// (doc 05 section 5.3). CE composes no module, so no module job is passed. Nothing
// to do is a success. A failure names neither the connection string nor the
// password.
async function runMigrate(config: MigrateConfig): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const { applied } = await runMigrations({ url: config.DATABASE_MIGRATE_URL, chains: MIGRATIONS });
  logger.info(applied.length === 0 ? "The database is up to date" : "The database is migrated", {
    applied: applied.length,
  });
}

// The worker registers the jobs and schedules of the same modules (doc 01
// section 3); CE has none yet. It never migrates: `migrate` installs the
// pg-boss schema before it starts.
async function runWorker(config: WorkerConfig, trap: SignalTrap): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const worker = composeWorker(config, logger);
  await runUntilSignal(trap, () => worker.start(), logger);
}

const WITH_WORKER_FLAG = "--with-worker";

// `slugbase <command> [--with-worker]`: the one flag belongs to `server`. Anything else after the command is refused
// rather than ignored, so a mistyped flag does not start a server without the worker the operator asked for.
function parseArguments(argv: readonly string[]): { command: ProcessType; withWorker: boolean } | undefined {
  const [command = "server", ...flags] = argv;
  if (!isProcessType(command)) {
    log("error", `Unknown command; use one of ${PROCESS_TYPES.join(", ")}`);
    return undefined;
  }
  const withWorker = command === "server" && flags.length === 1 && flags[0] === WITH_WORKER_FLAG;
  if (flags.length > 0 && !withWorker) {
    log("error", `Unexpected arguments; only \`server\` takes ${WITH_WORKER_FLAG}, and nothing else follows a command`);
    return undefined;
  }
  return { command, withWorker };
}

async function start(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    process.exitCode = 2;
    return;
  }
  const { command, withWorker } = parsed;

  const trap = command === "migrate" ? undefined : trapShutdownSignals();
  let serverConfig: ServerConfig | undefined;
  let workerConfig: WorkerConfig | undefined;
  let migrateConfig: MigrateConfig | undefined;
  let warnings: readonly string[];
  try {
    if (command === "server") {
      const loaded = loadConfig("server", process.env);
      serverConfig = loaded.config;
      warnings = loaded.warnings;
      if (withWorker) {
        // The worker's schema is a subset of the server's, so an environment that satisfies the server satisfies it too;
        // it is loaded all the same, so the worker reads its configuration the way the worker process does.
        const loadedWorker = loadConfig("worker", process.env);
        workerConfig = loadedWorker.config;
        warnings = [...new Set([...warnings, ...loadedWorker.warnings])];
      }
    } else if (command === "worker") {
      const loaded = loadConfig("worker", process.env);
      workerConfig = loaded.config;
      warnings = loaded.warnings;
    } else {
      const loaded = loadConfig("migrate", process.env);
      migrateConfig = loaded.config;
      warnings = loaded.warnings;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", error.message, { keys: error.issues.map((issue) => issue.key) });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  for (const warning of warnings) {
    log("warn", warning);
  }
  log("info", "Configuration loaded", { process: command, ...(withWorker ? { withWorker } : {}) });

  try {
    if (serverConfig !== undefined && workerConfig !== undefined && trap !== undefined) {
      await runServerWithWorker(serverConfig, workerConfig, trap);
    } else if (serverConfig !== undefined && trap !== undefined) {
      await runServer(serverConfig, trap);
    } else if (workerConfig !== undefined && trap !== undefined) {
      await runWorker(workerConfig, trap);
    } else if (migrateConfig !== undefined) {
      await runMigrate(migrateConfig);
    }
  } catch (error) {
    log("error", error instanceof Error ? error.message : `The ${command} failed to start`, {
      code: (error as { code?: unknown }).code,
    });
    process.exitCode = 1;
  }
}

// Importing the module, as the tests of the composition do, composes nothing and starts nothing.
if (import.meta.main) {
  await start();
}
