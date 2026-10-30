import type { AuditEventFilter, AuditEventPosition, AuditEventReader, AuditEventRecord, AuditRecord } from "@slugbase/core";
import { eq, sql, type SQL } from "drizzle-orm";
import { auditEvents } from "../schema/audit.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { registerRepositoryMethods, type RepositoryInput } from "./registry.ts";

// Writing the audit log of a workspace (doc 05 section 2.9, doc 01 section 4 step 12): the store the audit
// writer of `@slugbase/core` inserts through, bound to the transaction of the change it records, so the
// event exists exactly when the change does. `slugbase_app` may insert and read `audit_events` and never
// change or delete a row, and the policy admits an insert into the workspace the transaction acts in or,
// in an account-level transaction, into a workspace the account is a member of (the workspace it has just
// created), so a row naming a workspace of somebody else is refused by the database whatever this layer does.
//
// Reading it (doc 04 section 10.5): `list` names the workspace of the transaction in every statement and the
// SELECT policy keeps the statement to that workspace besides, so an event of another workspace and a
// deployment-level event, which has no workspace, are in no answer whatever filter is passed. The order is
// newest first with the identifier as the tiebreak, which is the order of the index on the workspace, the
// time and the identifier (the ORDER BY spells NULLS LAST, which the index is declared with: a plain DESC sorts nulls first, and the index would not serve it). The network of an event is never selected.

export interface AuditEventRepository extends AuditEventReader {
  /**
   * Inserts the record in the transaction. In a transaction opened with a workspace the record must name that
   * workspace (`foreign_workspace` otherwise); in an account-level one it may name a workspace the account is
   * a member of.
   */
  insert(record: AuditRecord): Promise<void>;
}

interface ListedRow extends Record<string, unknown> {
  id: string;
  /** RFC 3339 UTC, with the microseconds of the column; not named like the column, so that the ORDER BY sorts the column and keeps its index. */
  occurred_at: string;
  actor_type: string;
  actor_account_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown;
}

const UTC_MICROSECONDS = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);

function actorTypeOf(value: string): AuditEventRecord["actorType"] {
  if (value === "account" || value === "api_token" || value === "system") {
    return value;
  }
  throw new Error("an audit event has an actor type the table does not allow");
}

/** The metadata object of a row: its text fields, which are all the catalog allows. */
function metadataOf(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** The statement that lists a page of the events of `workspaceId`; exported so a test can ask the planner about the very statement the repository runs. */
export function listAuditEventsStatement(
  workspaceId: string,
  query: AuditEventFilter & { readonly after: AuditEventPosition | undefined; readonly limit: number },
): SQL {
  // A time goes in as text and is cast from it: a parameter the server types as a timestamp is sent through a JavaScript date, which keeps the milliseconds and drops the
  // microseconds the position of a page needs.
  const conditions: SQL[] = [sql`workspace_id = ${workspaceId}::uuid`];
  if (query.actorAccountId !== undefined) {
    conditions.push(sql`actor_account_id = ${query.actorAccountId}::uuid`);
  }
  if (query.actions !== undefined) {
    conditions.push(sql`action IN (${sql.join(query.actions.map((action) => sql`${action}`), sql`, `)})`);
  }
  if (query.entityType !== undefined) {
    conditions.push(sql`entity_type = ${query.entityType}`);
  }
  if (query.entityId !== undefined) {
    conditions.push(sql`entity_id = ${query.entityId}::uuid`);
  }
  if (query.from !== undefined) {
    conditions.push(sql`created_at >= ${query.from}::text::timestamptz`);
  }
  if (query.to !== undefined) {
    conditions.push(sql`created_at < ${query.to}::text::timestamptz`);
  }
  if (query.after !== undefined) {
    conditions.push(sql`(created_at, id) < (${query.after.createdAt}::text::timestamptz, ${query.after.id}::uuid)`);
  }
  return sql`
    SELECT id, to_char(created_at AT TIME ZONE 'UTC', ${UTC_MICROSECONDS}) AS occurred_at, actor_type, actor_account_id, actor_label, action,
           entity_type, entity_id, metadata
    FROM public.audit_events
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST
    LIMIT ${query.limit}::int`;
}

// The registry entries of `audit_events` for the cross-tenant matrix (doc 08 section 3.3): the application role may read and insert events and
// nothing else. The table's `workspace_id` is nullable (a deployment-level event has none), so the generic scoped repository, which needs a
// NOT NULL one, cannot define it; the entries below run the same statements by hand, with the workspace predicate in one mode and without it
// in the other, where only the policies stand between the transaction and another workspace's events.
function matrixEntry(method: "select" | "insert", applicationLayer: boolean) {
  return async (tx: TenantTx, input: RepositoryInput = {}): Promise<readonly unknown[]> => {
    const handle = tenantHandle(tx);
    if (method === "select") {
      const workspaceId = applicationLayer ? workspaceOf(tx, "listing audit events") : undefined;
      return handle.select().from(auditEvents).where(workspaceId === undefined ? undefined : eq(auditEvents.workspaceId, workspaceId));
    }
    const values = { ...input.values } as typeof auditEvents.$inferInsert;
    if (applicationLayer) {
      const workspaceId = workspaceOf(tx, "inserting an audit event");
      if (values.workspaceId !== undefined && values.workspaceId !== null && values.workspaceId.toLowerCase() !== workspaceId) {
        throw new TenantContextError("foreign_workspace", "an audit event cannot name a workspace other than the one of the transaction");
      }
      values.workspaceId = workspaceId;
    }
    return handle.insert(auditEvents).values(values).returning();
  };
}

registerRepositoryMethods(
  "audit_events",
  (["select", "insert"] as const).map((method) => ({
    repository: "audit_events",
    table: "audit_events",
    method,
    access: method === "select" ? ("read" as const) : ("write" as const),
    invoke: matrixEntry(method, true),
    invokeRlsOnly: matrixEntry(method, false),
  })),
);

function workspaceOf(tx: TenantTx, what: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${what} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

export function auditEventRepository(tx: TenantTx): AuditEventRepository {
  return {
    async list(query) {
      const rows = await tenantHandle(tx).execute<ListedRow>(listAuditEventsStatement(workspaceOf(tx, "listing audit events"), query));
      return rows.map(
        (row): AuditEventRecord => ({
          id: row.id,
          createdAt: row.occurred_at,
          actorType: actorTypeOf(row.actor_type),
          actorAccountId: row.actor_account_id,
          actorLabel: row.actor_label,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          metadata: metadataOf(row.metadata),
        }),
      );
    },

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
