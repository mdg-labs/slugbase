import type postgres from "postgres";
import { enqueueInTransaction, type QueuedJob } from "./queue.ts";

// The wrappers behind changing the address of an account (doc 05 section 3.3, doc 02 section 2.6, doc 04 sections
// 10.2 and 10.3, doc 10 T4, T8 and T18). They run on the pool of the auth store, as the application role, outside
// any tenant transaction: the redemptions have the emailed token as their only credential, and the two calls of
// the signed-in account take the account from the session's principal. The request records the address and
// queues the mail job in one transaction; it issues no token itself, the job does
// (`emailChangeRepository`).

export interface EmailChangeRequest {
  readonly accountId: string;
  /** Trimmed and NFKC-normalised by the caller; compared case-insensitively. */
  readonly email: string;
  /**
   * Queued in the transaction that records the address, so they exist exactly when the pending change does. The
   * same jobs are queued whatever the address is: whether it is the account's own or another account's is for
   * the jobs to find out.
   */
  readonly jobs: readonly QueuedJob[];
}

export interface EmailChangeStore {
  /**
   * Records the address the account asked to move to, deletes the unused email-change tokens of an earlier
   * request and queues the jobs, in one transaction. False, with nothing changed and no job queued, for an
   * account that does not exist or is disabled. It reads nothing about the address.
   */
  requestEmailChange(request: EmailChangeRequest): Promise<boolean>;
  /**
   * Cancels the account's pending change and deletes its unused email-change tokens. True for an account
   * that exists and is not disabled, whether or not a change was pending; false otherwise.
   */
  cancelPendingEmailChange(accountId: string): Promise<boolean>;
  /**
   * Redeems the confirmation token mailed to the new address once and moves the account to the address. The
   * account id, or undefined, with nothing changed but the token's use, for an unknown, used, expired,
   * replaced or foreign token, an account that is disabled or whose address was never verified, a change
   * that is no longer pending and an address another account holds, which a caller does not tell apart.
   */
  confirmEmailChange(tokenHash: Buffer): Promise<{ readonly accountId: string } | undefined>;
  /**
   * Redeems the "this wasn't me" token mailed to the old address once: cancels the pending change and
   * deletes every session of the account, in one transaction. When the change was confirmed since, the
   * address it replaced becomes the account's email again (unless another account holds it by now, in which
   * case the account keeps its address) and the account's unused reset, email-change and cancel tokens are
   * deleted. The account id, or undefined for an unknown, used, expired, replaced or foreign token and for
   * a disabled account, which a caller does not tell apart.
   */
  cancelEmailChange(tokenHash: Buffer): Promise<{ readonly accountId: string } | undefined>;
}

interface FlagRow {
  done: boolean;
}

interface AccountRow {
  account_id: string | null;
}

const TOKEN_HASH_BYTES = 32;

function assertHash(hash: Buffer, name: string): void {
  if (hash.length !== TOKEN_HASH_BYTES) {
    throw new RangeError(`${name} must be a ${String(TOKEN_HASH_BYTES)}-byte SHA-256 digest`);
  }
}

function single<T>(rows: readonly T[], name: string): T {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`${name} did not return exactly one row`);
  }
  return row;
}

/** Binds the email change store to a connection pool that connects as the application role. */
export function bindEmailChangeStore(client: postgres.Sql): EmailChangeStore {
  return {
    async requestEmailChange({ accountId, email, jobs }) {
      return client.begin(async (tx) => {
        const row = single(
          await tx<FlagRow[]>`SELECT sys_email_change_request(${accountId}::uuid, ${email}::text) AS done`,
          "sys_email_change_request",
        );
        if (!row.done) {
          return false;
        }
        for (const job of jobs) {
          await enqueueInTransaction(tx, job);
        }
        return true;
      });
    },

    async cancelPendingEmailChange(accountId) {
      return single(await client<FlagRow[]>`SELECT sys_email_change_clear(${accountId}::uuid) AS done`, "sys_email_change_clear").done;
    },

    async confirmEmailChange(tokenHash) {
      assertHash(tokenHash, "tokenHash");
      const { account_id } = single(
        await client<AccountRow[]>`SELECT sys_email_change_confirm(${tokenHash}::bytea) AS account_id`,
        "sys_email_change_confirm",
      );
      return account_id === null ? undefined : { accountId: account_id };
    },

    async cancelEmailChange(tokenHash) {
      assertHash(tokenHash, "tokenHash");
      const { account_id } = single(
        await client<AccountRow[]>`SELECT sys_email_change_cancel(${tokenHash}::bytea) AS account_id`,
        "sys_email_change_cancel",
      );
      return account_id === null ? undefined : { accountId: account_id };
    },
  };
}
