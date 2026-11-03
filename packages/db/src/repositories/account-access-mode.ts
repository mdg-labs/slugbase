import type { AccessModeEndStore, AccessModeEndStoreOutcome, AccessModeOutcome, AccessModeRequest, AccountAccessModeTransaction } from "@slugbase/core";
import { sql, type SQL } from "drizzle-orm";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { tenantHandle, type TenantTx } from "../tenant.ts";
import { accountDeletionRepository } from "./account-deletion.ts";

// The export-only access mode of the account of the transaction (doc 02 section 2.11, doc 05 sections 2.1 and 3.3, doc 01 section
// 13.6, doc 10 T4 and T18), through the system operations sys_account_set_access_mode and sys_account_access_mode_end. Both act for
// the account `withTenant` was opened for and for no other: the operations refuse any other account, and the repository never names
// one. The audit event of each is written by the operation, in the same call as the change.

const OUTCOMES: readonly AccessModeOutcome[] = ["set", "cleared", "unchanged", "unknown_account", "account_disabled", "instance_admin", "until_too_soon"];
const END_OUTCOMES: readonly AccessModeEndStoreOutcome[] = ["disabled", "deleted", "not_due", "blocked", "unavailable"];

interface OutcomeRow extends Record<string, unknown> {
  outcome: string;
}

export interface AccountAccessModeRepository {
  /**
   * Sets (`exportOnly`) or clears (`full`) the mode through `sys_account_set_access_mode`, which writes the audit event
   * `instance.account_export_only_set` or `instance.account_export_only_cleared`, actor the system, in the same call. Anything but `set`
   * and `cleared` writes nothing. Works in an account-level transaction.
   */
  set(request: AccessModeRequest): Promise<AccessModeOutcome>;
  /**
   * Ends the export-only period with `action` through `sys_account_access_mode_end`, and for `deleted` queues `jobs` in the same
   * transaction. Anything but `disabled` and `deleted` changes and queues nothing. Works in an account-level transaction.
   */
  end(request: { readonly eventId: string; readonly action: "disable" | "delete"; readonly soleWorkspaceIds: readonly string[] }, jobs: readonly QueuedJob[]): Promise<AccessModeEndStoreOutcome>;
}

async function outcomeOf(tx: TenantTx, name: string, statement: SQL): Promise<string> {
  const rows = await tenantHandle(tx).execute<OutcomeRow>(statement);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`${name} did not return exactly one row`);
  }
  return row.outcome;
}

export function accountAccessModeRepository(tx: TenantTx): AccountAccessModeRepository {
  return {
    async set({ eventId, change }) {
      const exportOnly = change.mode === "exportOnly";
      const outcome = await outcomeOf(
        tx,
        "sys_account_set_access_mode",
        sql`SELECT public.sys_account_set_access_mode(
          ${eventId}::uuid, ${tx.accountId}::uuid, ${exportOnly ? "export_only" : "full"}::text,
          ${exportOnly ? change.until.toISOString() : null}::timestamptz, ${exportOnly ? change.endAction : null}::text) AS outcome`,
      );
      const known = OUTCOMES.find((candidate) => candidate === outcome);
      if (known === undefined) {
        throw new Error("sys_account_set_access_mode answered an outcome it does not define");
      }
      return known;
    },

    async end({ eventId, action, soleWorkspaceIds }, jobs) {
      const ids = `{${soleWorkspaceIds.join(",")}}`;
      const outcome = await outcomeOf(
        tx,
        "sys_account_access_mode_end",
        sql`SELECT public.sys_account_access_mode_end(${eventId}::uuid, ${tx.accountId}::uuid, ${action}::text, ${ids}::uuid[]) AS outcome`,
      );
      const known = END_OUTCOMES.find((candidate) => candidate === outcome);
      if (known === undefined) {
        throw new Error("sys_account_access_mode_end answered an outcome it does not define");
      }
      if (known === "deleted") {
        for (const job of jobs) {
          await enqueueInTenantTransaction(tx, job);
        }
      }
      return known;
    },
  };
}

/**
 * The transaction as `setAccountAccessMode` of `@slugbase/core` uses it: an account-level tenant transaction of the account whose mode
 * changes, with the system operation that moves it bound to it, so the mode and its audit event commit or roll back together. `newId`
 * is a fresh UUIDv7.
 */
export function accountAccessModeTransaction(tx: TenantTx, newId: () => string): AccountAccessModeTransaction {
  const repository = accountAccessModeRepository(tx);
  return {
    accountId: tx.accountId,
    workspaceId: tx.workspaceId,
    setAccessMode: (request) => repository.set(request),
    newId,
  };
}

/**
 * The stores of the end of a period for `endAccessMode` of `@slugbase/core`, bound to the account-level transaction of the account
 * whose period ends. `jobsFor` makes the jobs the deletion queues, from the workspaces that go with the account and the events.
 */
export function accessModeEndStore(
  tx: TenantTx,
  jobsFor: (request: Parameters<AccessModeEndStore["end"]>[0]) => readonly QueuedJob[],
): AccessModeEndStore {
  const repository = accountAccessModeRepository(tx);
  return {
    scope: () => accountDeletionRepository(tx).scope(),
    end: (request) => repository.end(request, request.action === "delete" ? jobsFor(request) : []),
  };
}
