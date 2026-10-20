import { isInstanceAuditAction, type InstanceAuditEvent } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { tenantHandle, type TenantTx } from "../tenant.ts";

// What the CE instance admin's operations read from the database (doc 04 section 10.10, doc 05 sections 2.9 and
// 3.3, doc 02 section 11, doc 10 T3 and T15). The counts and the stream of instance audit events are reached only
// through the `sys_instance_*` and `sys_list_instance_audit` system operations, each of which checks inside its own
// body that the account of the transaction is an instance admin with a second factor and raises otherwise; this
// repository adds nothing to that check and bypasses none of it. The background-job health is read from the
// pg-boss tables, which the application role may read and which hold no tenant data.

/** What the instance holds. */
export interface InstanceCounts {
  /** Every account, disabled ones included. */
  readonly accounts: number;
  /** The workspaces that are not being deleted. */
  readonly workspaces: number;
  /** The complete sessions that have not expired. */
  readonly activeSessions: number;
}

/** The state of the background jobs. */
export interface JobHealth {
  /** Jobs that are due (created or waiting for a retry) and not yet taken by a worker. */
  readonly queueDepth: number;
  /** Jobs in the failed state that pg-boss still holds. */
  readonly failed: number;
}

export interface InstanceRepository {
  /**
   * Whether the account of the transaction has a second factor enrolled: the check the `instanceAdmin` policy
   * adds to the session's flag (Q45). False for an account the transaction cannot see. Works in an account-level
   * transaction.
   */
  secondFactorEnrolled(): Promise<boolean>;
  /**
   * The counts of the instance, and the instance audit event `instance.status_viewed` for the account of the
   * transaction, written in the same call under the identifier the caller generated (Q91). Raises, writing
   * nothing, when the account is not an instance admin with a second factor. Works in an account-level
   * transaction.
   */
  status(eventId: string, ipPrefix: string | null): Promise<InstanceCounts>;
  /** The state of the background jobs. Works in an account-level transaction. */
  jobHealth(): Promise<JobHealth>;
  /**
   * The instance audit stream, newest first, at most `limit` (1 to 200) events, after the event `afterId` names when
   * given. Raises when the account of the transaction is not an instance admin with a second factor, and when
   * `afterId` is no event of the stream. Works in an account-level transaction.
   */
  listAudit(limit: number, afterId?: string): Promise<readonly InstanceAuditEvent[]>;
}

interface EnrolledRow extends Record<string, unknown> {
  enrolled: boolean | null;
}

interface CountsRow extends Record<string, unknown> {
  account_count: string;
  workspace_count: string;
  active_session_count: string;
}

interface JobRow extends Record<string, unknown> {
  queue_depth: string;
  failed: string;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  created_at: Date;
  actor_account_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown;
  ip_prefix: string | null;
}

function count(value: string, what: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${what} is not a count`);
  }
  return parsed;
}

function auditEventOf(row: AuditRow): InstanceAuditEvent {
  // A row outside the catalog or with metadata the catalog does not declare is a schema drift or a forged row; it is not shown.
  const metadata = row.metadata;
  if (!isInstanceAuditAction(row.action) || typeof metadata !== "object" || metadata === null || Object.keys(metadata).length > 0) {
    throw new Error("the instance audit stream holds an event the catalog does not describe");
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    actorAccountId: row.actor_account_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    ipPrefix: row.ip_prefix,
  };
}

export function instanceRepository(tx: TenantTx): InstanceRepository {
  return {
    async secondFactorEnrolled() {
      const rows = await tenantHandle(tx).execute<EnrolledRow>(sql`SELECT public.sys_account_mfa_enabled() AS enrolled`);
      return rows[0]?.enrolled === true;
    },

    async status(eventId, ipPrefix) {
      const rows = await tenantHandle(tx).execute<CountsRow>(sql`
        SELECT account_count::text, workspace_count::text, active_session_count::text
        FROM public.sys_instance_status(${eventId}::uuid, ${ipPrefix}::cidr)`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_instance_status did not return exactly one row");
      }
      return {
        accounts: count(row.account_count, "the account count"),
        workspaces: count(row.workspace_count, "the workspace count"),
        activeSessions: count(row.active_session_count, "the active session count"),
      };
    },

    async jobHealth() {
      const rows = await tenantHandle(tx).execute<JobRow>(sql`
        SELECT
          (count(*) FILTER (WHERE j.state IN ('created', 'retry') AND j.start_after <= now()))::text AS queue_depth,
          (count(*) FILTER (WHERE j.state = 'failed'))::text AS failed
        FROM pgboss.job j`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("the job health query did not return exactly one row");
      }
      return { queueDepth: count(row.queue_depth, "the queue depth"), failed: count(row.failed, "the failed job count") };
    },

    async listAudit(limit, afterId) {
      const rows = await tenantHandle(tx).execute<AuditRow>(sql`
        SELECT id, created_at, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix::text AS ip_prefix
        FROM public.sys_list_instance_audit(${limit}::integer, ${afterId ?? null}::uuid)`);
      return rows.map(auditEventOf);
    },
  };
}
