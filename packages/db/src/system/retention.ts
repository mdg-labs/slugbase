import postgres from "postgres";

// The wrapper of the system operation sys_retention_purge (doc 05 sections 3.3
// and 6): the scheduled deletion of what has outlived its retention, across
// workspaces. It runs on a pool of its own as the application role, outside any
// tenant transaction.

/** What one purge deleted from one table. */
export interface RetentionPurgeCount {
  /** The table, by name; never a row's content. */
  readonly table: string;
  /** At most one batch of 5 000 rows; a table with more due rows is finished by the next calls. */
  readonly deleted: number;
}

export interface RetentionStore {
  /**
   * Deletes, per table, one batch of the rows past their retention and returns how many it
   * deleted. Repeating it deletes only rows that have become due or were left over. Rejects when
   * the database cannot answer.
   */
  purge(): Promise<readonly RetentionPurgeCount[]>;
  /** Ends the pool. */
  close(): Promise<void>;
}

export interface RetentionStoreOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
  /**
   * How many days a workspace's audit events are kept (`AUDIT_RETENTION_DAYS`, Q53); 0 keeps them forever.
   * An integer from 0 to 36 500; the default is 365.
   */
  auditRetentionDays?: number;
}

interface PurgeRow {
  table_name: string;
  deleted: string;
}

/** The days a workspace's audit events are kept unless the operator says otherwise (Q53). */
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

const MAX_AUDIT_RETENTION_DAYS = 36_500;

function auditRetentionOf(days: number | undefined): number {
  const chosen = days ?? DEFAULT_AUDIT_RETENTION_DAYS;
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > MAX_AUDIT_RETENTION_DAYS) {
    throw new RangeError(`the audit retention is a whole number of days from 0 to ${String(MAX_AUDIT_RETENTION_DAYS)}`);
  }
  return chosen;
}

/** Binds `purge` to a connection pool that connects as the application role. */
export function bindRetentionStore(client: postgres.Sql, options: Pick<RetentionStoreOptions, "auditRetentionDays"> = {}): Pick<RetentionStore, "purge"> {
  const auditRetentionDays = auditRetentionOf(options.auditRetentionDays);
  return {
    async purge() {
      const rows = await client<PurgeRow[]>`SELECT table_name, deleted::text AS deleted FROM sys_retention_purge(${auditRetentionDays}::integer)`;
      return rows.map((row) => ({ table: row.table_name, deleted: Number(row.deleted) }));
    },
  };
}

/** Opens a pool as the application role and returns the retention store on it. The pool connects on first use. */
export function createRetentionStore(options: RetentionStoreOptions): RetentionStore {
  const client = postgres(options.url, {
    max: options.poolSize ?? 1,
    onnotice: () => undefined,
  });
  const { purge } = bindRetentionStore(client, options);
  return {
    purge,
    close: () => client.end({ timeout: 5 }),
  };
}
