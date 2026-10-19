import type { AccountDeletionScope, AccountDeletionWorkspace } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { tenantHandle, type TenantTx } from "../tenant.ts";

// Deleting the account of the transaction (doc 05 sections 3.3 and 7.1, doc 02 section 2.10, doc 10 T1), through the
// system operations sys_account_deletion_scope, sys_account_last_instance_admin and sys_delete_account. All act for the account `withTenant` was
// opened for and for no other: the operations refuse any other account, and the repository never names one. The
// scope read locks the account's workspaces and then the account, and for an instance admin takes the lock that
// serialises the admins' deletions, so what it answers holds until the transaction ends.

export interface AccountDeletionRepository {
  /**
   * What deleting the account would do to the workspaces it belongs to that are not being deleted, whether it is the
   * last instance admin, and the locks that keep it true for the rest of the transaction. Works in an account-level
   * transaction.
   */
  scope(): Promise<AccountDeletionScope>;
  /**
   * Deletes the account of the transaction through `sys_delete_account`, which puts `soleWorkspaceIds` through the
   * request half of the workspace deletion, clears the network prefix of the events that name the account as their
   * actor and deletes the account row, and queues `jobs`, all in the open transaction. False, with nothing written and
   * nothing queued, when the scope is no longer what `soleWorkspaceIds` says, the account is the only owner of a
   * workspace that has other members, it is the last instance admin, or the account does not exist. Works in an account-level transaction.
   */
  delete(soleWorkspaceIds: readonly string[], jobs: readonly QueuedJob[]): Promise<boolean>;
}

interface ScopeRow extends Record<string, unknown> {
  workspace_id: string;
  workspace_name: string;
  kind: string;
}

interface LastAdminRow extends Record<string, unknown> {
  last: boolean;
}

interface DeletedRow extends Record<string, unknown> {
  deleted: boolean;
}

export function accountDeletionRepository(tx: TenantTx): AccountDeletionRepository {
  return {
    async scope() {
      const rows = await tenantHandle(tx).execute<ScopeRow>(sql`
        SELECT workspace_id, workspace_name, kind FROM public.sys_account_deletion_scope(${tx.accountId}::uuid)`);
      const blocking: AccountDeletionWorkspace[] = [];
      const soleMember: AccountDeletionWorkspace[] = [];
      for (const row of rows) {
        if (row.kind === "blocking") {
          blocking.push({ id: row.workspace_id, name: row.workspace_name });
        } else if (row.kind === "sole") {
          soleMember.push({ id: row.workspace_id, name: row.workspace_name });
        } else {
          throw new Error("sys_account_deletion_scope returned a kind other than blocking and sole");
        }
      }
      const admin = await tenantHandle(tx).execute<LastAdminRow>(sql`
        SELECT public.sys_account_last_instance_admin(${tx.accountId}::uuid) AS last`);
      const answer = admin[0];
      if (admin.length !== 1 || answer === undefined) {
        throw new Error("sys_account_last_instance_admin did not return exactly one row");
      }
      return { blocking, soleMember, lastInstanceAdmin: answer.last };
    },

    async delete(soleWorkspaceIds, jobs) {
      const ids = `{${soleWorkspaceIds.join(",")}}`;
      const rows = await tenantHandle(tx).execute<DeletedRow>(sql`
        SELECT public.sys_delete_account(${tx.accountId}::uuid, ${ids}::uuid[]) AS deleted`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_delete_account did not return exactly one row");
      }
      if (!row.deleted) {
        return false;
      }
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      return true;
    },
  };
}
