import { setTimeout as sleep } from "node:timers/promises";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import type { Adapters } from "@slugbase/core";
import { createDatabase, type Database, type MigrationChain } from "@slugbase/db";
import { Hono } from "hono";
import type { ServerConfig, WorkerConfig } from "./config/index.ts";
import {
  RouteTable,
  installChain,
  type ChainEnv,
  type RouteBinding,
  type StageName,
} from "./http/chain.ts";
import { createHookDispatcher, invalidHookRefusals, invalidHooks, type HookRefusals, type HookRegistration, type ServerHooks } from "./hooks/index.ts";
import { createMetrics, startMetricsListener, type MetricsListener } from "./metrics/index.ts";
import type { JobDefinition, ScheduleDefinition } from "./worker/job.ts";

export type { ChainContext, ChainEnv, MatchedRoute, RouteBinding, RouteHandler, StageName } from "./http/chain.ts";
export { CHAIN_STAGES } from "./http/chain.ts";

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
  /** The tenant database; by default a pool on `DATABASE_URL`, opened on first use. The server closes it on shutdown. */
  readonly database?: Database;
  /** How long a shutdown lets in-flight requests finish before cutting them (doc 01 section 3 rule 2). */
  readonly shutdownTimeoutMs?: number;
}

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
  /** Listens on `PORT`, and on `METRICS_PORT` for the internal `/metrics` listener when it is set. */
  start(options?: StartOptions): Promise<RunningServer>;
}

export type CompositionErrorCode =
  | "missing_adapter"
  | "invalid_module"
  | "duplicate_module"
  | "invalid_hook"
  | "module_failed"
  | "duplicate_route"
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
  errors: true,
  clientErrorReport: true,
  challenge: true,
  egress: true,
  rateLimit: true,
  secretBox: true,
  tenantResolver: true,
};

const REQUIRED_ADAPTERS = Object.keys(ADAPTER_PORTS) as (keyof Adapters)[];

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

const DEFAULT_SERVER_POOL_SIZE = 10;

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
  /** The hooks of the modules, in the order the modules were composed. */
  readonly hooks: readonly HookRegistration[];
}

function shapeOf(binding: RouteBinding): string {
  const path = binding.operation.path.replace(/\{[^}]*\}/g, "{}");
  return `${binding.operation.method.toUpperCase()} ${path}`;
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

  return { routes, jobs, schedules, migrations: chains, hooks };
}

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

  const metrics = createMetrics();
  const database = options.database ?? createDatabase({ url: config.DATABASE_URL, poolSize: DEFAULT_SERVER_POOL_SIZE });
  if (options.database === undefined) {
    metrics.setPoolSize(DEFAULT_SERVER_POOL_SIZE);
  }
  const adapters = Object.freeze({ ...options.adapters });
  const context: ModuleContext = Object.freeze({
    config,
    logger,
    adapters,
    withTenant: metrics.instrumentTenant(database.withTenant.bind(database)),
  });

  let composition: Composition;
  try {
    composition = compose(options.modules, context, options.migrations);
  } catch (error) {
    void database.close();
    throw error;
  }

  const app = new Hono<ChainEnv>();
  const stages = installChain(app, {
    logger,
    routes: new RouteTable(composition.routes),
    hooks: createHookDispatcher({
      registrations: composition.hooks,
      clientErrorReport: adapters.clientErrorReport,
      logger,
      ...(options.hookTimeoutMs === undefined ? {} : { timeoutMs: options.hookTimeoutMs }),
    }),
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
    appOrigin: config.APP_ORIGIN,
    errors: adapters.errors,
    responseValidation: config.NODE_ENV === "production" ? "strip" : "throw",
    metrics,
  });
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  return {
    stages,
    migrations: composition.migrations,
    jobs: composition.jobs,
    schedules: composition.schedules,
    fetch: async (request) => app.fetch(request),

    async start(startOptions = {}) {
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
        await database.close();
      };

      if (metricsRequested !== undefined) {
        try {
          metricsListener = await startMetricsListener({ metrics, port: metricsRequested, logger });
        } catch (error) {
          await (shutdown ??= stop());
          throw error;
        }
      }

      return {
        port,
        ...(metricsListener === undefined ? {} : { metricsPort: metricsListener.port }),
        shutdown: () => (shutdown ??= stop()),
      };
    },
  };
}
