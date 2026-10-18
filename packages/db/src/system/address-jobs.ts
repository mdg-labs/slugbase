import type postgres from "postgres";
import { enqueueInTransaction, type QueuedJob } from "./queue.ts";

// The lookup behind the anonymous requests that answer alike for every address (doc 02 section 1, doc 10 T8): an
// address is looked up through sys_login_lookup and the jobs for it are queued in the same transaction, so a
// known and an unknown address cost the same.

export interface AddressJobs {
  /** Trimmed and NFKC-normalised by the caller; compared case-insensitively. */
  readonly email: string;
  /** The jobs queued when an account holds the address, built for that account's identifier. */
  readonly onKnown: (accountId: string) => readonly QueuedJob[];
  /** The jobs queued instead when no account holds it, so both outcomes write the same kinds of rows. */
  readonly onUnknown: readonly QueuedJob[];
}

interface LookupRow {
  account_id: string;
}

/**
 * Looks the address up and queues the jobs of `onKnown` for the account that holds it, or those of `onUnknown`
 * when none does, in one transaction. It reads and writes nothing else. A job that cannot be queued undoes the
 * others and rejects.
 */
export async function queueJobsForAddress(client: postgres.Sql, { email, onKnown, onUnknown }: AddressJobs): Promise<void> {
  await client.begin(async (tx) => {
    const rows = await tx<LookupRow[]>`SELECT account_id FROM sys_login_lookup(${email}::text)`;
    if (rows.length > 1) {
      throw new Error("sys_login_lookup returned more than one account");
    }
    const row = rows[0];
    for (const job of row === undefined ? onUnknown : onKnown(row.account_id)) {
      await enqueueInTransaction(tx, job);
    }
  });
}
