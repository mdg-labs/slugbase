import type { AuditRecord } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { auditEvents } from "../schema/audit.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// Writing the audit log of a workspace (doc 05 section 2.9, doc 01 section 4 step 12): the store the audit
// writer of `@slugbase/core` inserts through, bound to the transaction of the change it records, so the
// event exists exactly when the change does. `slugbase_app` may insert and read `audit_events` and never
// change or delete a row, and the policy admits an insert into the workspace the transaction acts in or,
// in an account-level transaction, into a workspace the account is a member of (the workspace it has just
// created), so a row naming a workspace of somebody else is refused by the database whatever this layer does.

export interface AuditEventRepository {
  /**
   * Inserts the record in the transaction. In a transaction opened with a workspace the record must name that
   * workspace (`foreign_workspace` otherwise); in an account-level one it may name a workspace the account is
   * a member of.
   */
  insert(record: AuditRecord): Promise<void>;
}

export function auditEventRepository(tx: TenantTx): AuditEventRepository {
  return {
    async insert(record) {
      if (tx.workspaceId !== undefined && record.workspaceId.toLowerCase() !== tx.workspaceId) {
        throw new TenantContextError("foreign_workspace", "an audit event cannot name a workspace other than the one of the transaction");
      }
      await tenantHandle(tx)
        .insert(auditEvents)
        .values({
          id: record.id,
          workspaceId: record.workspaceId,
          actorType: record.actorType,
          actorAccountId: record.actorAccountId,
          actorLabel: record.actorLabel,
          actorTokenId: record.actorTokenId,
          action: record.action,
          entityType: record.entityType,
          entityId: record.entityId,
          metadata: sql`${JSON.stringify(record.metadata)}::text::jsonb`,
          ipPrefix: record.ipPrefix,
        });
    },
  };
}
