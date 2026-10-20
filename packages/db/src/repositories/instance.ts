import {
  INSTANCE_AUDIT_ACTIONS,
  isInstanceAuditAction,
  UNSET_INSTANCE_SETTINGS,
  type InstanceAccount,
  type InstanceAccountChange,
  type InstanceAccountUpdateOutcome,
  type InstanceAuditEvent,
  type InstanceSettings,
  type InstanceSettingsChange,
  type InstanceMembershipRequest,
  type InstanceMembershipResult,
  type InstanceWorkspace,
  type InstanceWorkspaceCreation,
  type InstanceWorkspaceCreationResult,
  type InstanceWorkspaceOwner,
} from "@slugbase/core";
import { sql } from "drizzle-orm";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
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
  /**
   * The instance settings; every one is null while none was ever saved. Reads the table directly and writes no event,
   * for the workspace routes, which apply a setting on every request. Works in an account-level transaction.
   */
  settings(): Promise<InstanceSettings>;
  /**
   * The instance settings as the instance admin reads them, and the instance audit event `instance.settings_viewed`
   * for the account of the transaction, written in the same call under the identifier the caller generated (Q91).
   * Raises, writing nothing, when the account is not an instance admin with a second factor. Works in an
   * account-level transaction.
   */
  viewSettings(eventId: string, ipPrefix: string | null): Promise<InstanceSettings>;
  /**
   * Changes the settings `change` names (`null` clears one, a setting it leaves out keeps its value), and writes the
   * instance audit event `instance.settings_changed` for the account of the transaction, in the same call, under the
   * identifier the caller generated (Q91). Answers the settings as they are after the change. Raises, writing nothing,
   * when the account is not an instance admin with a second factor and when `change` names no setting. Works in an
   * account-level transaction.
   */
  updateSettings(change: InstanceSettingsChange, eventId: string, ipPrefix: string | null): Promise<InstanceSettings>;
  /**
   * The instance audit event `instance.test_mail_queued` for the account of the transaction, under the identifier the
   * caller generated (Q91), and the job that sends the message, queued in the same transaction, so each exists exactly
   * when the other does. Raises, writing and queuing nothing, when the account is not an instance admin with a second
   * factor. Works in an account-level transaction.
   */
  recordTestMail(eventId: string, ipPrefix: string | null, job: QueuedJob): Promise<void>;
  /**
   * Every workspace that is not being deleted, newest first, with its name, its member count and its owners, and
   * no content of any workspace, through `sys_instance_list_workspaces`, which also writes the instance audit event
   * `instance.workspaces_viewed` for the account of the transaction under the identifier the caller generated (Q91).
   * Raises, writing nothing, when the account is not an instance admin with a second factor. Works in an
   * account-level transaction.
   */
  listWorkspaces(eventId: string, ipPrefix: string | null): Promise<readonly InstanceWorkspace[]>;
  /**
   * Creates the workspace and its settings, with the chosen account as owner or with a pending owner invitation
   * for the chosen address, and writes `instance.workspace_created`, in one call of `sys_instance_create_workspace`;
   * `jobs` are queued in the same transaction, only when the workspace is created. `unknown_account`, with nothing
   * written or queued, when the account does not exist or is disabled. Raises, writing nothing, when the account of
   * the transaction is not an instance admin with a second factor. Works in an account-level transaction.
   */
  createWorkspace(request: InstanceWorkspaceCreation, eventId: string, ipPrefix: string | null, jobs: readonly QueuedJob[]): Promise<InstanceWorkspaceCreationResult>;
  /**
   * Marks the workspace as being deleted, with the effects of `WorkspaceRepository.markDeleting` (hidden from every
   * policy and lookup, its sessions pointed at none, its API tokens revoked), writes
   * `instance.workspace_deletion_requested` and queues `jobs`, in one transaction, through
   * `sys_instance_delete_workspace`. False, with nothing written or queued, when the workspace does not exist or is
   * already being deleted. Raises, writing nothing, when the account of the transaction is not an instance admin
   * with a second factor. Works in an account-level transaction.
   */
  markWorkspaceDeleting(workspaceId: string, eventId: string, ipPrefix: string | null, jobs: readonly QueuedJob[]): Promise<boolean>;
  /**
   * Makes the account of the transaction a member of the workspace with the member role through
   * `sys_instance_add_membership`, which writes `member.instance_admin_joined` into the workspace's own audit log and
   * `instance.workspace_joined` into the instance stream under the identifiers the caller generated (Q91), all in one
   * call; `jobs` are queued in the same transaction, only when the membership is made. `unknown_workspace` for a
   * workspace that does not exist or is being deleted and `already_member` for an account that holds a role in it, with
   * nothing written or queued. Raises, writing nothing, when the account of the transaction is not an instance admin
   * with a second factor. Works in an account-level transaction.
   */
  addMembership(request: Pick<InstanceMembershipRequest, "workspaceId" | "eventIds">, ipPrefix: string | null, jobs: readonly QueuedJob[]): Promise<InstanceMembershipResult>;
  /**
   * Every account, oldest first, with its name, address, whether the address was confirmed and a second factor is on,
   * the instance-admin flag, whether it is disabled, its last sign-in and its workspace count, and no hash, secret or
   * content, through `sys_instance_list_accounts`, which also writes the instance audit event
   * `instance.accounts_viewed` for the account of the transaction under the identifier the caller generated (Q91).
   * Raises, writing nothing, when the account of the transaction is not an instance admin with a second factor. Works
   * in an account-level transaction.
   */
  listAccounts(eventId: string, ipPrefix: string | null): Promise<readonly InstanceAccount[]>;
  /**
   * Applies the change to the account in one call of `sys_instance_update_account`, which checks the calling admin once
   * for both fields: grants or clears the instance-admin flag (`instance.account_admin_granted` or
   * `instance.account_admin_revoked`, under `eventIds.admin`) and disables or enables the account
   * (`instance.account_disabled` or `instance.account_enabled`, under `eventIds.disabled`). A change of the flag, and
   * disabling, delete every session of the account. A change that takes the only enabled admin away is
   * `last_instance_admin`, decided under the advisory lock of the set of admins (doc 05 section 7.1), with nothing
   * written or queued; the field says which of the two it refused. A field that already has the value writes nothing.
   * `jobs` are queued in the same transaction, only when this call disabled the account. Raises, writing nothing, when
   * the account of the transaction is not an instance admin with a second factor. Works in an account-level
   * transaction.
   */
  updateAccount(
    accountId: string,
    change: InstanceAccountChange,
    eventIds: { readonly admin: string; readonly disabled: string },
    ipPrefix: string | null,
    jobs: readonly QueuedJob[],
  ): Promise<InstanceAccountUpdateOutcome>;
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

interface SettingsRow extends Record<string, unknown> {
  allow_workspace_creation: boolean | null;
  display_name: string | null;
  sign_in_notice: string | null;
}

interface WorkspaceRow extends Record<string, unknown> {
  workspace_id: string;
  workspace_name: string;
  workspace_created_at: string;
  member_count: string;
  owners: unknown;
}

interface CreatedWorkspaceRow extends Record<string, unknown> {
  outcome: string;
  invitation_expires_at: string | null;
}

interface MembershipRow extends Record<string, unknown> {
  outcome: string;
}

interface AccountColumns extends Record<string, unknown> {
  acct_id: string | null;
  acct_name: string | null;
  acct_email: string | null;
  acct_verified: boolean | null;
  acct_mfa_on: boolean | null;
  acct_admin: boolean | null;
  acct_disabled: boolean | null;
  acct_last_sign_in: string | null;
  acct_workspaces: string | null;
}

interface AccountChangeRow extends AccountColumns {
  outcome: string;
  refused_field: string | null;
  admin_changed: boolean | null;
  disabled_changed: boolean | null;
}

interface DeletedWorkspaceRow extends Record<string, unknown> {
  marked: boolean;
}

function ownerOf(value: unknown): InstanceWorkspaceOwner {
  if (typeof value !== "object" || value === null) {
    throw new Error("sys_instance_list_workspaces returned an owner that is not an object");
  }
  const { accountId, displayName, email } = value as Record<string, unknown>;
  if (typeof accountId !== "string" || typeof displayName !== "string" || typeof email !== "string") {
    throw new Error("sys_instance_list_workspaces returned an owner without an account, a name and an address");
  }
  return { accountId, displayName, email };
}

function workspaceOf(row: WorkspaceRow): InstanceWorkspace {
  if (!Array.isArray(row.owners)) {
    throw new Error("sys_instance_list_workspaces returned owners that are not a list");
  }
  return {
    id: row.workspace_id,
    name: row.workspace_name,
    createdAt: new Date(row.workspace_created_at),
    memberCount: count(row.member_count, "the member count"),
    owners: (row.owners as unknown[]).map(ownerOf),
  };
}

function accountOf(row: AccountColumns): InstanceAccount {
  if (
    row.acct_id === null ||
    row.acct_name === null ||
    row.acct_email === null ||
    row.acct_verified === null ||
    row.acct_mfa_on === null ||
    row.acct_admin === null ||
    row.acct_disabled === null ||
    row.acct_workspaces === null
  ) {
    throw new Error("an instance account function returned an account with a missing column");
  }
  return {
    id: row.acct_id,
    displayName: row.acct_name,
    email: row.acct_email,
    emailVerified: row.acct_verified,
    mfaEnabled: row.acct_mfa_on,
    isInstanceAdmin: row.acct_admin,
    disabled: row.acct_disabled,
    lastSignInAt: row.acct_last_sign_in === null ? null : new Date(row.acct_last_sign_in),
    workspaceCount: count(row.acct_workspaces, "the workspace count"),
  };
}

function accountChangeOf(rows: readonly AccountChangeRow[]): InstanceAccountUpdateOutcome {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error("sys_instance_update_account did not return exactly one row");
  }
  switch (row.outcome) {
    case "unknown_account":
      return { kind: "unknown_account" };
    case "last_instance_admin":
      if (row.refused_field !== "isInstanceAdmin" && row.refused_field !== "disabled") {
        throw new Error("sys_instance_update_account refused a field it does not define");
      }
      return { kind: "last_instance_admin", field: row.refused_field };
    case "updated":
      if (row.admin_changed === null || row.disabled_changed === null) {
        throw new Error("sys_instance_update_account did not say which fields changed");
      }
      return { kind: "updated", account: accountOf(row), adminChanged: row.admin_changed, disabledChanged: row.disabled_changed };
    default:
      throw new Error("sys_instance_update_account answered an outcome it does not define");
  }
}

const ACCOUNT_COLUMNS = sql`outcome, refused_field, admin_changed, disabled_changed, acct_id, acct_name, acct_email, acct_verified, acct_mfa_on, acct_admin, acct_disabled,
          to_char(acct_last_sign_in AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acct_last_sign_in, acct_workspaces::text AS acct_workspaces`;

function settingsOf(row: SettingsRow): InstanceSettings {
  return { allowWorkspaceCreation: row.allow_workspace_creation, displayName: row.display_name, signInNotice: row.sign_in_notice };
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
  if (!isInstanceAuditAction(row.action) || typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("the instance audit stream holds an event the catalog does not describe");
  }
  const declared = Object.keys(INSTANCE_AUDIT_ACTIONS[row.action].metadata);
  const entries = Object.entries(metadata);
  if (entries.length !== declared.length || entries.some(([key, value]) => !declared.includes(key) || typeof value !== "string")) {
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
    metadata: Object.fromEntries(entries.map(([key, value]) => [key, String(value)])),
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

    async settings() {
      const rows = await tenantHandle(tx).execute<SettingsRow>(sql`
        SELECT allow_workspace_creation, display_name, sign_in_notice FROM public.instance_settings WHERE id = 1`);
      const row = rows[0];
      return row === undefined ? UNSET_INSTANCE_SETTINGS : settingsOf(row);
    },

    async viewSettings(eventId, ipPrefix) {
      const rows = await tenantHandle(tx).execute<SettingsRow>(sql`
        SELECT allow_workspace_creation, display_name, sign_in_notice
        FROM public.sys_instance_settings(${eventId}::uuid, ${ipPrefix}::cidr)`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_instance_settings did not return exactly one row");
      }
      return settingsOf(row);
    },

    async updateSettings(change, eventId, ipPrefix) {
      const has = (name: keyof InstanceSettingsChange): boolean => Object.hasOwn(change, name) && change[name] !== undefined;
      const rows = await tenantHandle(tx).execute<SettingsRow>(sql`
        SELECT allow_workspace_creation, display_name, sign_in_notice
        FROM public.sys_instance_update_settings(
          ${eventId}::uuid, ${ipPrefix}::cidr,
          ${has("allowWorkspaceCreation")}::boolean, ${change.allowWorkspaceCreation ?? null}::boolean,
          ${has("displayName")}::boolean, ${change.displayName ?? null}::text,
          ${has("signInNotice")}::boolean, ${change.signInNotice ?? null}::text)`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_instance_update_settings did not return exactly one row");
      }
      return settingsOf(row);
    },

    async recordTestMail(eventId, ipPrefix, job) {
      await tenantHandle(tx).execute(sql`SELECT public.sys_instance_test_mail(${eventId}::uuid, ${ipPrefix}::cidr)`);
      await enqueueInTenantTransaction(tx, job);
    },

    async listWorkspaces(eventId, ipPrefix) {
      const rows = await tenantHandle(tx).execute<WorkspaceRow>(sql`
        SELECT workspace_id, workspace_name, to_char(workspace_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS workspace_created_at, member_count::text, owners
        FROM public.sys_instance_list_workspaces(${eventId}::uuid, ${ipPrefix}::cidr)`);
      return rows.map(workspaceOf);
    },

    async createWorkspace(request, eventId, ipPrefix, jobs) {
      const { owner } = request;
      const rows = await tenantHandle(tx).execute<CreatedWorkspaceRow>(sql`
        SELECT outcome, to_char(invitation_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS invitation_expires_at
        FROM public.sys_instance_create_workspace(
          ${eventId}::uuid, ${ipPrefix}::cidr, ${request.workspaceId}::uuid, ${request.name}::text,
          ${owner.kind === "account" ? owner.accountId : null}::uuid,
          ${owner.kind === "invitation" ? owner.email : null}::citext,
          ${owner.kind === "invitation" ? owner.invitationId : null}::uuid,
          ${owner.kind === "invitation" ? owner.tokenHash : null}::bytea,
          ${owner.kind === "invitation" ? owner.ttlSeconds : null}::integer)`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_instance_create_workspace did not return exactly one row");
      }
      if (row.outcome === "unknown_account") {
        return { kind: "unknown_account" };
      }
      if (row.outcome !== "created") {
        throw new Error("sys_instance_create_workspace answered an outcome it does not define");
      }
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      return { kind: "created", invitationExpiresAt: row.invitation_expires_at === null ? null : new Date(row.invitation_expires_at) };
    },

    async markWorkspaceDeleting(workspaceId, eventId, ipPrefix, jobs) {
      const rows = await tenantHandle(tx).execute<DeletedWorkspaceRow>(sql`
        SELECT public.sys_instance_delete_workspace(${eventId}::uuid, ${ipPrefix}::cidr, ${workspaceId}::uuid) AS marked`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_instance_delete_workspace did not return exactly one row");
      }
      if (!row.marked) {
        return false;
      }
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      return true;
    },

    async addMembership(request, ipPrefix, jobs) {
      const rows = await tenantHandle(tx).execute<MembershipRow>(sql`
        SELECT public.sys_instance_add_membership(${request.eventIds.workspace}::uuid, ${request.eventIds.instance}::uuid, ${ipPrefix}::cidr, ${request.workspaceId}::uuid) AS outcome`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_instance_add_membership did not return exactly one row");
      }
      switch (row.outcome) {
        case "unknown_workspace":
        case "already_member":
          return { kind: row.outcome };
        case "added":
          for (const job of jobs) {
            await enqueueInTenantTransaction(tx, job);
          }
          return { kind: "added" };
        default:
          throw new Error("sys_instance_add_membership answered an outcome it does not define");
      }
    },

    async listAccounts(eventId, ipPrefix) {
      const rows = await tenantHandle(tx).execute<AccountColumns>(sql`
        SELECT acct_id, acct_name, acct_email, acct_verified, acct_mfa_on, acct_admin, acct_disabled,
          to_char(acct_last_sign_in AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acct_last_sign_in, acct_workspaces::text AS acct_workspaces
        FROM public.sys_instance_list_accounts(${eventId}::uuid, ${ipPrefix}::cidr)`);
      return rows.map(accountOf);
    },

    async updateAccount(accountId, change, eventIds, ipPrefix, jobs) {
      const rows = await tenantHandle(tx).execute<AccountChangeRow>(sql`
        SELECT ${ACCOUNT_COLUMNS}
        FROM public.sys_instance_update_account(
          ${eventIds.admin}::uuid, ${eventIds.disabled}::uuid, ${ipPrefix}::cidr, ${accountId}::uuid,
          ${change.isInstanceAdmin ?? null}::boolean, ${change.disabled ?? null}::boolean)`);
      const result = accountChangeOf(rows);
      if (result.kind === "updated" && result.disabledChanged) {
        for (const job of jobs) {
          await enqueueInTenantTransaction(tx, job);
        }
      }
      return result;
    },
  };
}
