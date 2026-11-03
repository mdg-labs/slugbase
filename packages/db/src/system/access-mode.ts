import postgres from "postgres";

// The wrapper of the system operation sys_account_access_mode_due (doc 02 section 2.11, doc 05 section 3.3): the accounts whose
// export-only period has ended, for the daily maintenance job. It runs on a pool of its own as the application role, outside any
// tenant transaction, and changes nothing; each account is then ended in a tenant transaction of its own.

/** The largest batch one call can ask for. */
export const ACCESS_MODE_DUE_MAX = 1000;

/** An account whose export-only period has ended, with the action the period ends with. */
export interface DueAccessMode {
  readonly accountId: string;
  readonly endAction: "disable" | "delete";
}

export interface AccessModeStore {
  /** At most `limit` (1 to 1000) accounts whose period ended, the oldest end date first. Rejects when the database cannot answer. */
  due(limit: number): Promise<readonly DueAccessMode[]>;
  /** Ends the pool. */
  close(): Promise<void>;
}

export interface AccessModeStoreOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
}

interface DueRow {
  due_account_id: string;
  due_end_action: string;
}

/** Binds `due` to a connection pool that connects as the application role. */
export function bindAccessModeStore(client: postgres.Sql): Pick<AccessModeStore, "due"> {
  return {
    async due(limit) {
      const rows = await client<DueRow[]>`SELECT due_account_id, due_end_action FROM sys_account_access_mode_due(${limit}::integer)`;
      return rows.map((row) => {
        if (row.due_end_action !== "disable" && row.due_end_action !== "delete") {
          throw new Error("sys_account_access_mode_due returned an end action outside disable and delete");
        }
        return { accountId: row.due_account_id, endAction: row.due_end_action };
      });
    },
  };
}

/** Opens a pool as the application role and returns the store on it. The pool connects on first use. */
export function createAccessModeStore(options: AccessModeStoreOptions): AccessModeStore {
  const client = postgres(options.url, {
    max: options.poolSize ?? 1,
    onnotice: () => undefined,
  });
  const { due } = bindAccessModeStore(client);
  return {
    due,
    close: () => client.end({ timeout: 5 }),
  };
}
