import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HttpEgress,
  createFullEntitlementSource,
  createLogOnlyMail,
  createOidcIdentity,
  createRateLimiter,
  createSecretBox,
  createSentryErrorReport,
  createSmtpMail,
  type MailTemplates,
} from "@slugbase/adapters";
import "@slugbase/contracts";
import {
  ACCOUNT_NOTIFICATIONS,
  unconfigured,
  type Adapters,
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
  type ServerConfig,
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

// Identity is the OIDC adapter when the operator configured a provider, and the unconfigured default when not.
// Only the server serves sign-in, so only its configuration has providers. The adapter reaches the providers
// through the egress port and discovers them when they are first listed, so a provider that is down at start-up
// is logged then and never stops the process.
function composeIdentity(config: ServerConfig | WorkerConfig, egress: EgressPort, logger: Logger): IdentityPort {
  const providers = "OIDC_PROVIDERS" in config ? config.OIDC_PROVIDERS : [];
  if (providers.length === 0) {
    return unconfigured().identity;
  }
  logger.info("OIDC sign-in configured", { providers: providers.map((provider) => provider.slug) });
  return createOidcIdentity({ providers, egress, logger });
}

// The secret box is built from the environment by the server and the worker
// alike: `ENCRYPTION_KEY` seals, the previous keys only open. A key the box
// refuses stops the process before it serves or works. Error reporting is the
// Sentry-protocol adapter when the operator set `ERROR_REPORT_DSN`, and the
// no-op default (errors are logged only) when not. Egress is always on (doc 01
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
export function composeAdapters(config: ServerConfig | WorkerConfig, logger: Logger): Adapters {
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
      : createSentryErrorReport({ dsn: config.ERROR_REPORT_DSN, environment: config.NODE_ENV });
  logger.info(errors.available ? "Error reporting ready" : "Error reporting is off; errors are only logged");
  const limits = createRateLimitRegistry(config);
  const rateLimit = createRateLimiter({
    store: createRateLimitStore({ url: config.DATABASE_URL, poolSize: RATE_LIMIT_POOL_SIZE }),
    limits: (name) => limits.window(name),
  });
  logger.info("Rate limiter ready", { buckets: RATE_LIMIT_BUCKETS.length });
  const mail = composeMail(config, logger);
  logger.info(mail.available ? "Mail ready" : "Mail is off; messages are only logged");
  const egress = new HttpEgress({ nodeEnv: config.NODE_ENV });
  return {
    ...defaults,
    mail,
    secretBox,
    errors,
    egress,
    identity: composeIdentity(config, egress, logger),
    rateLimit,
    entitlements: createFullEntitlementSource(),
    tenantResolver: createAccountOnlyTenantResolver(),
  };
}

async function runServer(config: ServerConfig, trap: SignalTrap): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL });
  const serveWeb = existsSync(WEB_ROOT);
  if (!serveWeb) {
    logger.warn("There is no web build; only the API is served", { webRoot: WEB_ROOT });
  }
  const server = createServer({
    config,
    adapters: composeAdapters(config, logger),
    modules: [],
    migrations: MIGRATIONS,
    usage: composeUsage(config, logger),
    registrationDefaults: REGISTRATION_DEFAULTS,
    allowWorkspaceCreation: ALLOW_WORKSPACE_CREATION,
    logger,
    buildInfo: loadBuildInfo(BUILD_INFO_FILE),
    ...(serveWeb ? { webRoot: WEB_ROOT } : {}),
  });
  await runUntilSignal(trap, () => server.start(), logger);
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
  const worker = createWorker({
    config,
    adapters: composeAdapters(config, logger),
    modules: [],
    logger,
  });
  await runUntilSignal(trap, () => worker.start(), logger);
}

async function start(): Promise<void> {
  const command = process.argv[2] ?? "server";
  if (!isProcessType(command)) {
    log("error", `Unknown command; use one of ${PROCESS_TYPES.join(", ")}`);
    process.exitCode = 2;
    return;
  }

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
  log("info", "Configuration loaded", { process: command });

  try {
    if (serverConfig !== undefined && trap !== undefined) {
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
