import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// The tenant transaction of doc 01 section 5.3 and doc 05 section 3.2: a
// transaction on the application role whose settings are transaction-local, so
// a pooled connection never carries them to another request (doc 01 section
// 9.2). Row-level security reads these settings; the scoped repositories add
// the workspace predicate on top.
//
// The Drizzle transaction handle of a tenant transaction is kept in a WeakMap
// inside this module, never on the `TenantTx` itself, and nothing here exports
// it from the package entry point: product code reaches the database only
// through repositories (doc 09 section 2.1).

/** The identity a tenant transaction runs for. */
export interface TenantContext {
  /** The authenticated account, a UUID. */
  accountId: string;
  /** The active workspace, a UUID; left out for account-level routes, which set only the account. */
  workspaceId?: string;
  /** The request id of the request context stage, written to `app.request_id` for the audit trail. */
  requestId: string;
}

/**
 * A tenant transaction as services see it. It carries the context it was
 * opened with and nothing that queries the database: repositories bound to it
 * do that.
 */
export interface TenantTx {
  readonly accountId: string;
  /** `undefined` in an account-level transaction, in which no scoped repository can be used. */
  readonly workspaceId: string | undefined;
  readonly requestId: string;
}

/** What a tenant database offers: `withTenant` and nothing else. */
export interface Database {
  /**
   * Runs `fn` in a transaction on the application role with `app.account_id`,
   * `app.workspace_id` and `app.request_id` set transaction-locally. It commits
   * when `fn` resolves and rolls back when it throws. Ids that are not UUIDs
   * are rejected before any SQL. A call nested in `fn` joins the open
   * transaction when its account and workspace match and throws otherwise.
   */
  withTenant<T>(context: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Ends the connection pool. */
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
}

export type TenantContextErrorCode =
  | "invalid_account_id"
  | "invalid_workspace_id"
  | "invalid_request_id"
  | "nested_context_mismatch"
  | "workspace_required"
  | "foreign_workspace"
  | "not_a_tenant_transaction"
  | "transaction_closed";

/** A tenant transaction or a scoped repository was used against its contract. */
export class TenantContextError extends Error {
  readonly code: TenantContextErrorCode;

  constructor(code: TenantContextErrorCode, message: string) {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
  }
}

type DrizzleTransaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

interface OpenTransaction {
  handle: DrizzleTransaction;
  open: boolean;
}

const transactions = new WeakMap<TenantTx, OpenTransaction>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

interface NormalizedContext {
  accountId: string;
  workspaceId: string | undefined;
  requestId: string;
}

function normalize(context: TenantContext): NormalizedContext {
  if (typeof context.accountId !== "string" || !UUID.test(context.accountId)) {
    throw new TenantContextError("invalid_account_id", "the account id of a tenant transaction must be a UUID");
  }
  if (context.workspaceId !== undefined && (typeof context.workspaceId !== "string" || !UUID.test(context.workspaceId))) {
    throw new TenantContextError("invalid_workspace_id", "the workspace id of a tenant transaction must be a UUID");
  }
  if (typeof context.requestId !== "string" || !REQUEST_ID.test(context.requestId)) {
    throw new TenantContextError(
      "invalid_request_id",
      "the request id of a tenant transaction must be 1 to 128 printable ASCII characters",
    );
  }
  return {
    accountId: context.accountId.toLowerCase(),
    workspaceId: context.workspaceId?.toLowerCase(),
    requestId: context.requestId,
  };
}

/**
 * The Drizzle handle of an open tenant transaction, for the repositories of
 * this package. A transaction that was not opened by `withTenant` or that has
 * finished is refused.
 */
export function tenantHandle(tx: TenantTx): DrizzleTransaction {
  const entry = transactions.get(tx);
  if (entry === undefined) {
    throw new TenantContextError("not_a_tenant_transaction", "the value is not a tenant transaction opened by withTenant");
  }
  if (!entry.open) {
    throw new TenantContextError("transaction_closed", "the tenant transaction has finished");
  }
  return entry.handle;
}

/**
 * Binds `withTenant` to a connection pool. The pool must connect as the
 * application role: that role neither owns the tables nor bypasses row-level
 * security (doc 05 section 3.1).
 */
export function bindTenantDatabase(client: postgres.Sql): Pick<Database, "withTenant"> {
  // The schema names its columns in camel case and drizzle-kit writes them in snake case (drizzle.config.ts); the runtime has to read them the same way.
  const db = drizzle(client, { casing: "snake_case" });
  const active = new AsyncLocalStorage<{ tx: TenantTx }>();

  return {
    async withTenant<T>(context: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      const ctx = normalize(context);

      const outer = active.getStore();
      if (outer !== undefined) {
        if (outer.tx.accountId !== ctx.accountId || outer.tx.workspaceId !== ctx.workspaceId) {
          throw new TenantContextError(
            "nested_context_mismatch",
            "withTenant was called inside another tenant transaction for a different account or workspace",
          );
        }
        return fn(outer.tx);
      }

      return db.transaction(async (handle) => {
        await handle.execute(sql`SELECT
          set_config('app.account_id', ${ctx.accountId}, true),
          set_config('app.workspace_id', ${ctx.workspaceId ?? ""}, true),
          set_config('app.request_id', ${ctx.requestId}, true)`);
        const tx: TenantTx = Object.freeze({
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          requestId: ctx.requestId,
        });
        const entry: OpenTransaction = { handle, open: true };
        transactions.set(tx, entry);
        try {
          return await active.run({ tx }, () => fn(tx));
        } finally {
          entry.open = false;
        }
      });
    },
  };
}

/** Opens a pool as the application role and returns the tenant database on it. */
export function createDatabase(options: DatabaseOptions): Database {
  const client = postgres(options.url, {
    max: options.poolSize ?? 10,
    onnotice: () => undefined,
  });
  const { withTenant } = bindTenantDatabase(client);
  return {
    withTenant,
    close: () => client.end({ timeout: 5 }),
  };
}
