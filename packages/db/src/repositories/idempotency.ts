import { sql } from "drizzle-orm";
import { tenantHandle, type TenantTx } from "../tenant.ts";

// The idempotency keys of the account of the transaction (doc 05 section 2.10, doc 04 section 6.3, doc 10 T1).
// The statements name the account of the transaction and run on the policy of `idempotency_keys` on top of
// that, so a key of another account is neither found nor changed whatever UUID is named, and the same UUID
// from two accounts is two keys. Works in an account-level or a workspace transaction alike.
//
// A key is claimed in the transaction that runs the request and completed in it before the commit. The insert
// of a second request with the same key waits on the unique index while the first transaction is open, for at
// most `LOCK_WAIT`: after the commit it finds the stored response, and after a rollback it finds no row and
// claims the key itself, so a request runs once and a failed one leaves nothing behind.

const LOCK_WAIT = "5s";
const LOCK_NOT_AVAILABLE = "55P03";
const MAX_CAUSE_DEPTH = 4;
const EXPIRY = "24 hours";

export interface IdempotencyClaim {
  /** The client's `Idempotency-Key`, a UUID. */
  readonly key: string;
  /** The operation the key is used for. */
  readonly operation: string;
  /** SHA-256 of what the request asked for, 32 bytes. */
  readonly requestHash: Buffer;
}

/** A response as it was stored: the HTTP status and the JSON body, null for a response without one. */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type IdempotencyOutcome =
  /** The key was not in use (or had expired): the request runs and then calls `complete`. */
  | { readonly kind: "claimed" }
  /** An earlier request with this key and this request finished; its response is `response`. */
  | { readonly kind: "replay"; readonly response: StoredResponse }
  /** The key was used for another operation or another request. */
  | { readonly kind: "conflict" };

/**
 * Another request holding the key did not finish within the wait. The statement that waited failed, so the
 * transaction can only be rolled back: `claim` throws this and does not return.
 */
export class IdempotencyBusyError extends Error {
  constructor() {
    super("a request with this idempotency key is still running");
    this.name = "IdempotencyBusyError";
  }
}

export interface IdempotencyRepository {
  /** Claims the key for the account of the transaction, or says what stands in the way; throws `IdempotencyBusyError` when it waited in vain. */
  claim(claim: IdempotencyClaim): Promise<IdempotencyOutcome>;
  /** Stores the response of the request that claimed `key`, in the same transaction. */
  complete(key: string, response: StoredResponse): Promise<void>;
}

interface ExistingRow extends Record<string, unknown> {
  operation: string;
  request_hash: string;
  status: string;
  response_status: number | null;
  response_body: string | null;
}

interface SettingRow extends Record<string, unknown> {
  value: string;
}

function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (code === LOCK_NOT_AVAILABLE) {
      return true;
    }
    current = cause;
  }
  return false;
}

export function idempotencyRepository(tx: TenantTx): IdempotencyRepository {
  return {
    async claim({ key, operation, requestHash }) {
      const handle = tenantHandle(tx);
      const hex = requestHash.toString("hex");
      const previous = (await handle.execute<SettingRow>(sql`SELECT current_setting('lock_timeout') AS value`))[0]?.value;
      if (previous === undefined) {
        throw new Error("reading lock_timeout did not return a row");
      }
      await handle.execute(sql`SELECT set_config('lock_timeout', ${LOCK_WAIT}, true)`);
      let claimed: readonly unknown[];
      try {
        claimed = await handle.execute(sql`
          INSERT INTO public.idempotency_keys (account_id, key, operation, request_hash, expires_at)
          VALUES (${tx.accountId}::uuid, ${key}::uuid, ${operation}, decode(${hex}, 'hex'), now() + ${EXPIRY}::interval)
          ON CONFLICT (account_id, key) DO UPDATE
            SET operation = EXCLUDED.operation, request_hash = EXCLUDED.request_hash, status = 'in_progress',
                response_status = NULL, response_body = NULL, created_at = now(), expires_at = EXCLUDED.expires_at
            WHERE public.idempotency_keys.expires_at <= now()
          RETURNING key`);
      } catch (error) {
        if (isLockTimeout(error)) {
          throw new IdempotencyBusyError();
        }
        throw error;
      }
      await handle.execute(sql`SELECT set_config('lock_timeout', ${previous}, true)`);
      if (claimed.length > 0) {
        return { kind: "claimed" };
      }

      const rows = await handle.execute<ExistingRow>(sql`
        SELECT operation, encode(request_hash, 'hex') AS request_hash, status, response_status, response_body::text AS response_body
        FROM public.idempotency_keys
        WHERE account_id = ${tx.accountId}::uuid AND key = ${key}::uuid`);
      const row = rows[0];
      if (row === undefined) {
        throw new Error("an idempotency key that conflicted is not there");
      }
      if (row.operation !== operation || row.request_hash !== hex) {
        return { kind: "conflict" };
      }
      if (row.status !== "done" || row.response_status === null) {
        throw new Error("an idempotency key is in progress in a transaction that has ended");
      }
      return { kind: "replay", response: { status: row.response_status, body: row.response_body === null ? null : (JSON.parse(row.response_body) as unknown) } };
    },

    async complete(key, response) {
      const body = response.body === null ? null : JSON.stringify(response.body);
      const rows = await tenantHandle(tx).execute(sql`
        UPDATE public.idempotency_keys
        SET status = 'done', response_status = ${response.status}::int, response_body = ${body}::jsonb
        WHERE account_id = ${tx.accountId}::uuid AND key = ${key}::uuid AND status = 'in_progress'
        RETURNING key`);
      if (rows.length !== 1) {
        throw new Error("completing an idempotency key did not change exactly one row");
      }
    },
  };
}
