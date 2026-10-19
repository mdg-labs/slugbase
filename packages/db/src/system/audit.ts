import type { AuditRecord } from "@slugbase/core";
import type postgres from "postgres";

// Writing the audit events of a system operation that runs in a transaction of its own, outside any tenant
// transaction (first-run setup): the same row `auditEventRepository` inserts, through the same policy of
// `audit_events`. The transaction acts, for the length of the insert, as the account and the workspace the
// operation just made, as `withTenant` would open one, so the policy that admits an event into the workspace
// the transaction acts in is what admits it here; a record naming any other workspace is refused before the
// statement and, were it not, by the policy.

export interface AuditActingAs {
  readonly accountId: string;
  readonly workspaceId: string;
}

/**
 * Runs `work` in the open transaction `tx` acting as `actingAs`, and puts the transaction back to acting as nobody
 * afterwards: the settings the system operations around it run without (an unset account) are restored, whether
 * `work` resolves or throws.
 */
export async function actingAsInTransaction<T>(tx: postgres.TransactionSql, actingAs: AuditActingAs, work: () => Promise<T>): Promise<T> {
  await tx`SELECT set_config('app.account_id', ${actingAs.accountId}, true), set_config('app.workspace_id', ${actingAs.workspaceId}, true)`;
  try {
    return await work();
  } finally {
    await tx`SELECT set_config('app.account_id', '', true), set_config('app.workspace_id', '', true)`;
  }
}

/** Inserts the records in the open transaction `tx`, which acts as `actingAs` for the length of the inserts. */
export async function insertAuditRecords(tx: postgres.TransactionSql, actingAs: AuditActingAs, records: readonly AuditRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }
  for (const record of records) {
    if (record.workspaceId.toLowerCase() !== actingAs.workspaceId.toLowerCase()) {
      throw new RangeError("an audit event of this operation names a workspace other than the one it made");
    }
  }
  await actingAsInTransaction(tx, actingAs, async () => {
    for (const record of records) {
      await tx`
        INSERT INTO audit_events (
          id, workspace_id, actor_type, actor_account_id, actor_label, actor_token_id,
          action, entity_type, entity_id, metadata, ip_prefix)
        VALUES (
          ${record.id}::uuid, ${record.workspaceId}::uuid, ${record.actorType}::text, ${record.actorAccountId}::uuid,
          ${record.actorLabel}::text, ${record.actorTokenId}::uuid, ${record.action}::text, ${record.entityType}::text,
          ${record.entityId}::uuid, ${JSON.stringify(record.metadata)}::text::jsonb, ${record.ipPrefix}::cidr)`;
    }
  });
}
