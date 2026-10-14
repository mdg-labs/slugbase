import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getHealth, getReady, getVersion } from "@slugbase/contracts";
import { CE_CHAIN, migrationLevel, type MigrationChain } from "@slugbase/db";
import type { BuildInfo } from "../build-info.ts";
import type { RouteBinding } from "../http/chain.ts";
import { describeError } from "../http/problem.ts";
import type { Logger } from "../create-server.ts";
import { route } from "./register.ts";

// The process probes of doc 04 section 9.2. They are unauthenticated, not
// rate-limited and `no-store` (the `probe` header rule), and `/health` answers
// from the process alone: liveness never waits for the database (doc 01 section
// 3 rule 3).

/** How long `/ready` waits for the database before it answers that it is unreachable. */
export const READY_TIMEOUT_MS = 5000;

/**
 * How long a finished readiness answer, ready or not, is reused. It bounds the
 * migration-level reads per second however fast probes arrive, and it is the
 * longest a change in the database goes unseen.
 */
export const READY_CACHE_TTL_MS = 1500;

export interface ProbeOptions {
  readonly buildInfo: BuildInfo;
  /** `DATABASE_URL`: the level is read as `slugbase_app`, which `migrate` lets read the bookkeeping tables. */
  readonly databaseUrl: string;
  /** The migration sets this build ships after the CE chain; read when a probe is served, once the composition is complete. */
  readonly chains: () => readonly MigrationChain[];
  readonly logger: Logger;
  /** Whether the server is still running its own migration; `/ready` is `503` until it finishes. */
  readonly migrating: () => boolean;
}

// The journals of a build do not change while its process runs.
const journalLengths = new WeakMap<MigrationChain, { folder: string; length: number }>();

function journalLength(chain: MigrationChain): number {
  const known = journalLengths.get(chain);
  if (known?.folder === chain.folder) {
    return known.length;
  }
  const journal = JSON.parse(readFileSync(join(chain.folder, "meta", "_journal.json"), "utf8")) as { entries: readonly unknown[] };
  journalLengths.set(chain, { folder: chain.folder, length: journal.entries.length });
  return journal.entries.length;
}

/** Migrations the build ships, counted from the journals, for an answer that cannot read the database. */
function shippedMigrations(chains: readonly MigrationChain[]): number {
  return [CE_CHAIN, ...chains].reduce((total, chain) => total + journalLength(chain), 0);
}

async function withinTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("the readiness check timed out"));
    }, ms);
  });
  // The abandoned work may still reject after the timer won.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function probeRoutes(options: ProbeOptions): readonly RouteBinding[] {
  const { buildInfo, databaseUrl, chains, logger, migrating } = options;

  const health = route(getHealth).handle(() => ({ status: 200, body: { status: "ok" } }));

  // At most one readiness read is in flight per process, and concurrent probes share
  // it. /ready is public and not rate-limited, and each read opens its own
  // connection that outlives a timed-out answer, so unshared reads would let one
  // client exhaust the database's connections.
  let inFlight: ReturnType<typeof migrationLevel> | undefined;
  const readLevel = (): ReturnType<typeof migrationLevel> => {
    inFlight ??= migrationLevel({ url: databaseUrl, chains: chains() }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  // What a finished read found, reused for READY_CACHE_TTL_MS. A failed read is
  // reused too, so an outage does not turn every probe into a connection attempt;
  // it reads as not ready for the window and is retried after it.
  type Outcome = { readonly level: Awaited<ReturnType<typeof migrationLevel>> } | { readonly failure: unknown };
  let settled: { readonly outcome: Outcome; readonly at: number } | undefined;
  let pending: Promise<Outcome> | undefined;
  const fresh = (): Outcome | undefined => {
    if (settled === undefined) {
      return undefined;
    }
    const age = Date.now() - settled.at;
    return age >= 0 && age < READY_CACHE_TTL_MS ? settled.outcome : undefined;
  };
  const outcome = (): Promise<Outcome> => {
    const reused = fresh();
    if (reused !== undefined) {
      return Promise.resolve(reused);
    }
    pending ??= withinTimeout(readLevel(), READY_TIMEOUT_MS)
      .then((level): Outcome => ({ level }))
      .catch((failure: unknown): Outcome => ({ failure }))
      .then((found) => {
        settled = { outcome: found, at: Date.now() };
        pending = undefined;
        return found;
      });
    return pending;
  };

  const ready = route(getReady).handle(async (_request, context) => {
    const requestLogger = context.get("logger") ?? logger;
    const found = await outcome();
    if ("failure" in found) {
      requestLogger.warn("The readiness check could not read the database", describeError(found.failure));
      return {
        status: 503,
        body: { database: "unreachable", migrations: { expected: shippedMigrations(chains()), applied: null } },
      };
    }
    const { level } = found;
    if (level.unknownApplied > 0) {
      requestLogger.warn("The database has migrations this build does not ship", { unknownApplied: level.unknownApplied });
    }
    return {
      status: !migrating() && level.applied >= level.expected ? 200 : 503,
      body: { database: "ok", migrations: { expected: level.expected, applied: level.applied } },
    };
  });

  const version = route(getVersion).handle(() => ({
    status: 200,
    body: { name: buildInfo.name, version: buildInfo.version, commit: buildInfo.commit, builtAt: buildInfo.builtAt },
  }));

  return [health, ready, version];
}
