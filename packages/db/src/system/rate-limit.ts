import postgres from "postgres";

// The wrapper of the system operation sys_rate_limit_take (doc 05 section
// 3.3): the one way product code reaches the rate_limit_buckets table, which
// slugbase_app has no privilege on. It runs on a pool of its own as the
// application role, outside any tenant transaction, because a bucket belongs to
// the deployment and not to a workspace.

/** One take from a bucket: `cost` tokens of the bucket `key`, which holds `capacity` at most and refills `refillPerSecond` tokens a second. */
export interface RateLimitTake {
  readonly key: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly cost: number;
}

export interface RateLimitTaken {
  readonly allowed: boolean;
  /** The tokens the bucket holds after the take; a refused take leaves them as they are. */
  readonly remaining: number;
  /** Seconds until the bucket can hold `cost` tokens at its refill rate; 0 when the take was allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Takes tokens in one statement on the database clock. Rejects when the database cannot answer: a failure is never an allowed take. */
  take(request: RateLimitTake): Promise<RateLimitTaken>;
  /** Ends the pool. */
  close(): Promise<void>;
}

export interface RateLimitStoreOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
}

interface TakeRow {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

// The function takes the same bounds; a request outside them is refused here
// before a round trip.
const MAX_VALUE = 1e9;

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_VALUE) {
    throw new RangeError(`${name} must be a number above 0 and at most ${String(MAX_VALUE)}`);
  }
}

/** Binds `take` to a connection pool that connects as the application role. */
export function bindRateLimitStore(client: postgres.Sql): Pick<RateLimitStore, "take"> {
  return {
    async take(request) {
      if (request.key === "") {
        throw new RangeError("key must not be empty");
      }
      positive(request.capacity, "capacity");
      positive(request.refillPerSecond, "refillPerSecond");
      positive(request.cost, "cost");
      const rows = await client<TakeRow[]>`
        SELECT allowed, remaining, retry_after_seconds
        FROM sys_rate_limit_take(
          ${request.key}::text,
          ${request.capacity}::double precision,
          ${request.refillPerSecond}::double precision,
          ${request.cost}::double precision)`;
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_rate_limit_take did not return exactly one row");
      }
      return { allowed: row.allowed, remaining: row.remaining, retryAfterSeconds: row.retry_after_seconds };
    },
  };
}

/** Opens a pool as the application role and returns the rate-limit store on it. The pool connects on first use. */
export function createRateLimitStore(options: RateLimitStoreOptions): RateLimitStore {
  const client = postgres(options.url, {
    max: options.poolSize ?? 5,
    onnotice: () => undefined,
  });
  const { take } = bindRateLimitStore(client);
  return {
    take,
    close: () => client.end({ timeout: 5 }),
  };
}
