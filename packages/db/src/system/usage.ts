import postgres from "postgres";

// The wrapper of the system operation sys_flush_open_counts (doc 05 section 3.3): the one way product code writes the usage of
// bookmarks, which slugbase_app has no privilege on. Each server process flushes the opens it buffered across workspaces, so it runs
// on a pool of its own as the application role, outside any tenant transaction.

/** The opens of one bookmark since the last flush: how many, and the latest of them. Nothing else of an open is kept (Q28). */
export interface OpenCount {
  readonly bookmarkId: string;
  /** At least one. */
  readonly count: number;
  readonly lastOpenedAt: Date;
}

export interface UsageStore {
  /**
   * Adds the counts to the bookmarks and moves each bookmark's last-opened time forward, in one call of the system operation, which
   * takes at most `USAGE_FLUSH_BATCH_SIZE` bookmarks. A bookmark that has been deleted since is skipped. Rejects, with nothing
   * written, when the database cannot answer or a value is out of range; the caller keeps what it has not flushed.
   */
  flush(opens: readonly OpenCount[]): Promise<void>;
  /** Ends the pool. */
  close(): Promise<void>;
}

export interface UsageStoreOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
}

/** The most bookmarks one call of the system operation takes. */
export const USAGE_FLUSH_BATCH_SIZE = 10_000;

const UUID_ARRAY_OID = 2951;
const INT8_ARRAY_OID = 1016;
const TIMESTAMPTZ_ARRAY_OID = 1185;

/** Binds `flush` to a connection pool that connects as the application role. */
export function bindUsageStore(client: postgres.Sql): Pick<UsageStore, "flush"> {
  return {
    async flush(opens) {
      if (opens.length > USAGE_FLUSH_BATCH_SIZE) {
        throw new RangeError(`at most ${String(USAGE_FLUSH_BATCH_SIZE)} bookmarks are flushed in one call`);
      }
      for (const open of opens) {
        if (!Number.isSafeInteger(open.count) || open.count < 1 || Number.isNaN(open.lastOpenedAt.getTime())) {
          throw new RangeError("an open count is a whole number of at least one with a valid time");
        }
      }
      await client`
        SELECT sys_flush_open_counts(
          ${client.array(
            opens.map((open) => open.bookmarkId),
            UUID_ARRAY_OID,
          )}::uuid[],
          ${client.array(
            opens.map((open) => String(open.count)),
            INT8_ARRAY_OID,
          )}::bigint[],
          ${client.array(
            opens.map((open) => open.lastOpenedAt.toISOString()),
            TIMESTAMPTZ_ARRAY_OID,
          )}::timestamptz[])`;
    },
  };
}

/** Opens a pool as the application role and returns the usage store on it. The pool connects on first use. */
export function createUsageStore(options: UsageStoreOptions): UsageStore {
  const client = postgres(options.url, {
    max: options.poolSize ?? 1,
    onnotice: () => undefined,
  });
  const { flush } = bindUsageStore(client);
  return {
    flush,
    close: () => client.end({ timeout: 5 }),
  };
}
