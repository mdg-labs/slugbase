import postgres from "postgres";
import type { SealedMfaSecret } from "./mfa.ts";

// The wrapper of the system operations sys_mfa_secret_key_ids, sys_mfa_secrets_under_key and sys_mfa_reseal_swept (doc 01 section 10, doc
// 05 section 3.3): the reads and the compare-and-set write of the hourly `secrets.reseal` job, which re-seals the second-factor secrets
// that are still under a secret-box key other than the current one. It runs on a pool of its own as the application role, outside any
// tenant transaction, because the sweep crosses every account, disabled ones included. A secret passes through it sealed; it never sees
// a plaintext, and nothing here logs a value.

/** A secret-box key id that holds sealed secrets, with how many. */
export interface MfaKeyUse {
  readonly keyId: string;
  readonly secrets: number;
}

/** The sealed secret of one account. */
export interface MfaSweptSecret {
  readonly accountId: string;
  readonly secret: Uint8Array;
}

export interface MfaResealStore {
  /** Every key id that holds at least one sealed second-factor secret, with the number of secrets under it. Rejects when the database cannot answer. */
  keyIds(): Promise<readonly MfaKeyUse[]>;
  /**
   * At most `limit` (1 to 1000) accounts whose sealed secret is under `keyId`, in account id order, after `afterAccountId` (from the first when null).
   * Disabled accounts and pending enrolments are included. Rejects when the database cannot answer.
   */
  secretsUnderKey(keyId: string, afterAccountId: string | null, limit: number): Promise<readonly MfaSweptSecret[]>;
  /**
   * Stores `secret` for the account only while the stored ciphertext still is `expected`, a disabled account included, and says whether it wrote. False,
   * with nothing changed, when the secret was replaced since it was read or the account turned MFA off. Leaves the time MFA was enabled and the latest
   * accepted step as they are.
   */
  reseal(accountId: string, expected: Uint8Array, secret: SealedMfaSecret): Promise<boolean>;
  /** Ends the pool. */
  close(): Promise<void>;
}

export interface MfaResealStoreOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
}

interface KeyRow {
  key_id: string;
  secrets: string;
}

interface SecretRow {
  swept_account_id: string;
  swept_secret: Buffer;
}

interface FlagRow {
  done: boolean | null;
}

/** Binds the store's operations to a connection pool that connects as the application role. */
export function bindMfaResealStore(client: postgres.Sql): Pick<MfaResealStore, "keyIds" | "secretsUnderKey" | "reseal"> {
  return {
    async keyIds() {
      const rows = await client<KeyRow[]>`SELECT key_id, secrets::text AS secrets FROM sys_mfa_secret_key_ids()`;
      return rows.map((row) => {
        const secrets = Number(row.secrets);
        if (!Number.isSafeInteger(secrets)) {
          throw new Error("sys_mfa_secret_key_ids returned a count outside the safe integers");
        }
        return { keyId: row.key_id, secrets };
      });
    },

    async secretsUnderKey(keyId, afterAccountId, limit) {
      const rows = await client<SecretRow[]>`
        SELECT swept_account_id, swept_secret
        FROM sys_mfa_secrets_under_key(${keyId}::text, ${afterAccountId}::uuid, ${limit}::integer)`;
      return rows.map((row) => ({ accountId: row.swept_account_id, secret: new Uint8Array(row.swept_secret) }));
    },

    async reseal(accountId, expected, secret) {
      const rows = await client<FlagRow[]>`
        SELECT sys_mfa_reseal_swept(
          ${accountId}::uuid, ${Buffer.from(secret.ciphertext)}::bytea, ${secret.keyId}::text, ${Buffer.from(expected)}::bytea) AS done`;
      const [row] = rows;
      if (rows.length !== 1 || row === undefined || typeof row.done !== "boolean") {
        throw new Error("sys_mfa_reseal_swept did not answer with one flag");
      }
      return row.done;
    },
  };
}

/** Opens a pool as the application role and returns the store on it. The pool connects on first use. */
export function createMfaResealStore(options: MfaResealStoreOptions): MfaResealStore {
  const client = postgres(options.url, {
    max: options.poolSize ?? 1,
    onnotice: () => undefined,
  });
  return {
    ...bindMfaResealStore(client),
    close: () => client.end({ timeout: 5 }),
  };
}
