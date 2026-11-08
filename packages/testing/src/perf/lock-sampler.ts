import { spawnPsql } from "../seed/run.ts";
import type { SeedConnection } from "../seed/target.ts";

// The lock sampler of the migration timing (doc 08 section 5.4). `pg_locks` shows a lock only while it is held, so it is polled: a
// `psql` session of its own runs one query again and again (`\watch`) and prints, per poll, the server's clock and the relations on
// which a `slugbase-migrate` backend of the database holds an `AccessExclusiveLock`. The clock is the server's, so the time a lock
// was seen for does not depend on how fast this process reads the output. The longest run of consecutive polls that see a relation
// is the time its lock was held, to the resolution of the interval.

/** The seconds between two polls (`\watch` takes seconds). */
export const SAMPLE_INTERVAL_MS = 50;
const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const SAMPLER_APPLICATION = "slugbase-lock-sampler";
const MIGRATE_APPLICATION = "slugbase-migrate";

/** A relation of a user schema, as `schema.name` (quoted where the name needs it). */
export interface LockHold {
  readonly relation: string;
  /** From the first poll that saw the lock to the last poll that did, in milliseconds: at most the real time, and short of it by less than two intervals. */
  readonly heldMs: number;
}

export interface Sample {
  /** Seconds since the epoch on the server's clock. */
  readonly t: number;
  readonly relations: readonly string[];
}

/** The longest hold of each relation in `samples`, longest first. A relation missing from a poll ends its run. */
export function holdsOf(samples: readonly Sample[]): LockHold[] {
  const longest = new Map<string, number>();
  const since = new Map<string, number>();
  for (const sample of samples) {
    const seen = new Set(sample.relations);
    for (const relation of since.keys()) {
      if (!seen.has(relation)) {
        since.delete(relation);
      }
    }
    for (const relation of seen) {
      const start = since.get(relation) ?? sample.t;
      since.set(relation, start);
      longest.set(relation, Math.max(longest.get(relation) ?? 0, (sample.t - start) * 1000));
    }
  }
  return [...longest]
    .map(([relation, heldMs]) => ({ relation, heldMs: Math.round(heldMs) }))
    .sort((a, b) => b.heldMs - a.heldMs || a.relation.localeCompare(b.relation));
}

// One line per poll: {"t": <epoch seconds>, "r": ["schema.name", ...]}. Relations in the system schemas are left out: a lock on a
// catalog is not a lock on data, and none of them is held by a migration for long.
const POLL = `SELECT json_build_object(
  't', extract(epoch FROM clock_timestamp()),
  'r', coalesce((
    SELECT json_agg(DISTINCT quote_ident(n.nspname) || '.' || quote_ident(c.relname))
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    JOIN pg_class c ON c.oid = l.relation
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE l.locktype = 'relation' AND l.mode = 'AccessExclusiveLock' AND l.granted
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND a.datname = current_database() AND a.application_name = '${MIGRATE_APPLICATION}'
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
  ), '[]'::json)
);`;

/** What `pg_stat_activity` shows of other roles' sessions is for a superuser or a member of `pg_read_all_stats` only. */
export const CAN_OBSERVE_LOCKS = `SELECT rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') FROM pg_roles WHERE rolname = current_user;`;

export class LockSamplerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockSamplerError";
  }
}

function parseSample(line: string): Sample {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new LockSamplerError("the lock sampler printed a line that is not a poll");
  }
  const t = typeof parsed === "object" && parsed !== null && "t" in parsed ? parsed.t : undefined;
  const relations = typeof parsed === "object" && parsed !== null && "r" in parsed ? parsed.r : undefined;
  if (typeof t !== "number" || !Array.isArray(relations) || !relations.every((relation) => typeof relation === "string")) {
    throw new LockSamplerError("the lock sampler printed a line that is not a poll");
  }
  return { t, relations };
}

export interface LockSampler {
  /** Ends the sampler and returns the longest hold of each relation it saw. Rejects when the sampler failed at any point. */
  stop(): Promise<LockHold[]>;
}

export interface LockSamplerOptions {
  /** A superuser (or `pg_read_all_stats`) connection to the database whose locks are watched. */
  readonly connection: SeedConnection;
  /** The PATH to find `psql` on. */
  readonly path: string;
}

/**
 * Starts sampling and resolves once the first poll has answered, so a lock taken afterwards is seen from its start. The sampler is
 * a `psql` child that `stop()` ends; a poll that fails, a child that exits by itself and output that is not a poll all make `stop()`
 * reject, never a list of holds that looks complete.
 */
export function startLockSampler(options: LockSamplerOptions): Promise<LockSampler> {
  const { connection } = options;
  return new Promise((resolve, reject) => {
    const child = spawnPsql(connection, { path: options.path, application: SAMPLER_APPLICATION });
    const samples: Sample[] = [];
    let failure: Error | undefined;
    let stderr = "";
    let pending = "";
    let started = false;
    let stopping = false;
    let exited = false;
    let closed: () => void = () => undefined;
    const done = new Promise<void>((resolveDone) => {
      closed = resolveDone;
    });
    const message = (text: string): string => (connection.password === "" ? text : text.split(connection.password).join("***"));

    const fail = (error: Error): void => {
      failure ??= error;
      if (!started) {
        started = true;
        clearTimeout(startup);
        child.kill("SIGTERM");
        reject(failure);
      }
    };
    const startup = setTimeout(() => {
      fail(new LockSamplerError("the lock sampler did not answer its first poll in time"));
    }, STARTUP_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        try {
          samples.push(parseSample(line));
        } catch (error) {
          fail(error instanceof Error ? error : new LockSamplerError("the lock sampler failed"));
          continue;
        }
        if (!started) {
          started = true;
          clearTimeout(startup);
          resolve({ stop });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 2_000);
    });
    child.on("error", (error) => {
      exited = true;
      fail(new LockSamplerError(`could not run psql (it must be on the PATH): ${error.message}`));
      closed();
    });
    child.on("close", (code) => {
      exited = true;
      if (!stopping) {
        fail(new LockSamplerError(`the lock sampler ended by itself with ${code === null ? "a signal" : `status ${String(code)}`}: ${message(stderr.trim())}`));
      } else if (stderr.trim() !== "") {
        fail(new LockSamplerError(`the lock sampler reported an error: ${message(stderr.trim())}`));
      }
      closed();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${POLL}\n\\watch ${String(SAMPLE_INTERVAL_MS / 1000)}\n`);

    async function stop(): Promise<LockHold[]> {
      stopping = true;
      if (!exited) {
        child.kill("SIGTERM");
      }
      const timer = setTimeout(() => {
        failure ??= new LockSamplerError("the lock sampler did not end in time");
        child.kill("SIGKILL");
      }, STOP_TIMEOUT_MS);
      await done;
      clearTimeout(timer);
      if (failure !== undefined) {
        throw failure;
      }
      return holdsOf(samples);
    }
  });
}
