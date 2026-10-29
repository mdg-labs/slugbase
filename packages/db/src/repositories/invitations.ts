import type {
  InvitationAcceptResult,
  InvitationListing,
  InvitationManagementStore,
  InvitationRecord,
  InvitationRenewal,
  InvitationRevocation,
  InvitationStatus,
  InvitationStore,
  NewInvitation,
  WorkspaceRole,
} from "@slugbase/core";
import { sql } from "drizzle-orm";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The invitations of the active workspace (doc 05 section 2.2, doc 02 section 3.4, doc 10 T1, T4 and T19). Every
// statement names the workspace of the transaction and runs on the policies of `workspace_invitations` on top
// of that, so an invitation of a workspace the transaction does not act in is neither read nor changed
// whatever identifier is named. `slugbase_app` may insert an invitation without `instance_issued`, `status`
// and `accepted_by`, so a row it writes is pending, is never an owner's and is never accepted (the CHECK of the
// table refuses the owner role besides), and may change what a resend replaces and turn a pending invitation
// into a revoked one, which the update policy allows for a pending row only. The token is stored as its
// SHA-256 and read back by nobody: no method here returns it or its hash.

interface RecordRow extends Record<string, unknown> {
  id: string;
  email: string;
  role: string;
  /** A JSON array of identifiers. */
  team_ids: string;
  status: string;
  invited_by: string | null;
  expires_at: string;
  created_at: string;
}

interface WrittenRow extends RecordRow {
  inserted: boolean;
}

interface ListedRow extends RecordRow {
  expired: boolean;
}

interface StatusRow extends Record<string, unknown> {
  status: string;
}

interface RoleRow extends Record<string, unknown> {
  role: string;
}

interface PresentRow extends Record<string, unknown> {
  present: boolean;
}

interface CountRow extends Record<string, unknown> {
  present: number;
}

interface LocaleRow extends Record<string, unknown> {
  locale: string | null;
}

interface AcceptedRow extends Record<string, unknown> {
  outcome: string;
  accepted_workspace_id: string | null;
  accepted_invitation_id: string | null;
  accepted_role: string | null;
}

interface IssuedRow extends Record<string, unknown> {
  email: string;
  role: string;
  instance_issued: boolean;
  expires_at: string;
  workspace_name: string;
}

/** What the email of an invitation says of it, read when the token it carries is issued. */
export interface InvitationMailContext {
  readonly email: string;
  readonly role: WorkspaceRole;
  /** Whether an instance admin issued the invitation, the only way an invitation carries the owner role. */
  readonly instanceIssued: boolean;
  readonly expiresAt: Date;
  readonly workspaceName: string;
}

export interface InvitationRepository extends InvitationStore, InvitationManagementStore {
  /**
   * Gives the pending, unexpired invitation `invitationId` of the workspace of the transaction the token whose
   * SHA-256 is `tokenHash`, which ends the link it had, and answers what its email says; undefined, with
   * nothing changed, when the invitation is not pending, has expired, no longer holds `mailTicket` because
   * a later write or link renewed it, or belongs to a workspace the transaction cannot see (one being deleted,
   * doc 05 section 7.2, or gone). The ticket stays, so the same job issues a token again when it is retried.
   * Needs a transaction opened with a workspace.
   */
  issueToken(invitationId: string, mailTicket: string, tokenHash: Buffer): Promise<InvitationMailContext | undefined>;
  /**
   * Queues `jobs` in the open transaction, so each exists exactly when the change that asked for it does and
   * none when the transaction ends without it.
   */
  enqueue(jobs: readonly QueuedJob[]): Promise<void>;
}

// The columns of an invitation as an `InvitationRecord` has them, for a statement that names the table `i` or none.
const RECORD_COLUMNS = sql.raw(`id, email::text AS email, role::text AS role, to_json(team_ids)::text AS team_ids, status, invited_by,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function workspaceOf(tx: TenantTx, what: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${what} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

function roleOf(value: string): WorkspaceRole {
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }
  throw new Error("workspace_invitations.role holds a value outside owner, admin and member");
}

function statusOf(value: string): InvitationStatus {
  if (value === "pending" || value === "accepted" || value === "revoked") {
    return value;
  }
  throw new Error("workspace_invitations.status holds a value outside pending, accepted and revoked");
}

function teamIdsOf(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
    throw new Error("workspace_invitations.team_ids holds a value that is not a list of identifiers");
  }
  return parsed;
}

function recordOf(row: RecordRow): InvitationRecord {
  return {
    id: row.id,
    email: row.email,
    role: roleOf(row.role),
    teamIds: teamIdsOf(row.team_ids),
    status: statusOf(row.status),
    invitedBy: row.invited_by,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
  };
}

/** A uuid[] literal of identifiers; one that is not a UUID is refused, so the literal can hold nothing else. */
function uuidArray(identifiers: readonly string[]): string {
  for (const identifier of identifiers) {
    if (!UUID.test(identifier)) {
      throw new RangeError("a team identifier of an invitation must be a UUID");
    }
  }
  return `{${identifiers.join(",")}}`;
}

export function invitationRepository(tx: TenantTx): InvitationRepository {
  return {
    async actorRole() {
      const workspaceId = workspaceOf(tx, "reading the role of the inviting account");
      const rows = await tenantHandle(tx).execute<RoleRow>(sql`
        SELECT role::text AS role FROM public.workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND account_id = ${tx.accountId}::uuid`);
      const row = rows[0];
      return row === undefined ? undefined : roleOf(row.role);
    },

    async memberHoldsEmail(email) {
      const workspaceId = workspaceOf(tx, "looking for a member by email address");
      const rows = await tenantHandle(tx).execute<PresentRow>(sql`
        SELECT EXISTS (
          SELECT 1 FROM public.workspace_members m
          JOIN public.accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ${workspaceId}::uuid AND a.email = ${email}::citext) AS present`);
      return rows[0]?.present === true;
    },

    async teamsExist(teamIds) {
      const workspaceId = workspaceOf(tx, "looking for the teams of an invitation");
      const wanted = [...new Set(teamIds.map((teamId) => teamId.toLowerCase()))];
      if (wanted.length === 0) {
        return true;
      }
      const rows = await tenantHandle(tx).execute<CountRow>(sql`
        SELECT count(*)::int AS present FROM public.teams
        WHERE workspace_id = ${workspaceId}::uuid AND id = ANY (${uuidArray(wanted)}::uuid[])`);
      return rows[0]?.present === wanted.length;
    },

    async writePending(invitation: NewInvitation) {
      const workspaceId = workspaceOf(tx, "writing an invitation");
      const rows = await tenantHandle(tx).execute<WrittenRow>(sql`
        INSERT INTO public.workspace_invitations (id, workspace_id, email, role, team_ids, token_hash, mail_ticket, invited_by, expires_at)
        VALUES (
          ${invitation.id}::uuid, ${workspaceId}::uuid, ${invitation.email}::citext, ${invitation.role}::member_role,
          ${uuidArray(invitation.teamIds)}::uuid[], decode(${invitation.tokenHash.toString("hex")}, 'hex'), ${invitation.mailTicket}::uuid, ${tx.accountId}::uuid,
          now() + ${invitation.ttlSeconds}::int * interval '1 second')
        ON CONFLICT (workspace_id, email) WHERE status = 'pending'
        DO UPDATE SET role = EXCLUDED.role, team_ids = EXCLUDED.team_ids,
                      token_hash = CASE WHEN ${invitation.keepTokenHash}::boolean THEN workspace_invitations.token_hash ELSE EXCLUDED.token_hash END,
                      mail_ticket = EXCLUDED.mail_ticket, invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at
        RETURNING id, email::text AS email, role::text AS role, to_json(team_ids)::text AS team_ids, status, invited_by,
                  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, (xmax = 0) AS inserted`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("writing an invitation did not return exactly one row");
      }
      return { invitation: recordOf(row), resent: !row.inserted };
    },

    async inviteeLocale(invitationId) {
      const rows = await tenantHandle(tx).execute<LocaleRow>(sql`
        SELECT public.sys_invitation_invitee_locale(${invitationId}::uuid) AS locale`);
      return rows[0]?.locale ?? undefined;
    },

    async issueToken(invitationId, mailTicket, tokenHash) {
      const workspaceId = workspaceOf(tx, "issuing the token of an invitation");
      const rows = await tenantHandle(tx).execute<IssuedRow>(sql`
        UPDATE public.workspace_invitations i
        SET token_hash = decode(${tokenHash.toString("hex")}, 'hex')
        WHERE i.id = ${invitationId}::uuid AND i.workspace_id = ${workspaceId}::uuid AND i.status = 'pending' AND i.expires_at > now()
          AND i.mail_ticket = ${mailTicket}::uuid
          AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = i.workspace_id)
        RETURNING i.email::text AS email, i.role::text AS role, i.instance_issued,
                  to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                  (SELECT w.name FROM public.workspaces w WHERE w.id = i.workspace_id) AS workspace_name`);
      const row = rows[0];
      return row === undefined ? undefined : { email: row.email, role: roleOf(row.role), instanceIssued: row.instance_issued, expiresAt: new Date(row.expires_at), workspaceName: row.workspace_name };
    },

    async pending(invitationId) {
      const workspaceId = workspaceOf(tx, "reading an invitation");
      const rows = await tenantHandle(tx).execute<RecordRow>(sql`
        SELECT ${RECORD_COLUMNS} FROM public.workspace_invitations
        WHERE id = ${invitationId}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'pending'`);
      const row = rows[0];
      return row === undefined ? undefined : recordOf(row);
    },

    async listPending(afterId, limit) {
      const workspaceId = workspaceOf(tx, "listing invitations");
      const rows = await tenantHandle(tx).execute<ListedRow>(sql`
        SELECT ${RECORD_COLUMNS}, (expires_at <= now()) AS expired FROM public.workspace_invitations
        WHERE workspace_id = ${workspaceId}::uuid AND status = 'pending' AND (${afterId}::uuid IS NULL OR id < ${afterId}::uuid)
        ORDER BY id DESC
        LIMIT ${limit}::int`);
      return rows.map((row): InvitationListing => ({ ...recordOf(row), expired: row.expired }));
    },

    async renew(invitationId, { tokenHash, mailTicket, ttlSeconds }: InvitationRenewal) {
      const workspaceId = workspaceOf(tx, "renewing an invitation");
      const rows = await tenantHandle(tx).execute<RecordRow>(sql`
        UPDATE public.workspace_invitations
        SET token_hash = decode(${tokenHash.toString("hex")}, 'hex'), mail_ticket = ${mailTicket}::uuid, invited_by = ${tx.accountId}::uuid,
            expires_at = now() + ${ttlSeconds}::int * interval '1 second'
        WHERE id = ${invitationId}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'pending'
        RETURNING ${RECORD_COLUMNS}`);
      const row = rows[0];
      return row === undefined ? undefined : recordOf(row);
    },

    async revoke(invitationId): Promise<InvitationRevocation> {
      const workspaceId = workspaceOf(tx, "revoking an invitation");
      const handle = tenantHandle(tx);
      const revoked = await handle.execute<RecordRow>(sql`
        UPDATE public.workspace_invitations SET status = 'revoked', closed_at = now()
        WHERE id = ${invitationId}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'pending'
        RETURNING ${RECORD_COLUMNS}`);
      const row = revoked[0];
      if (row !== undefined) {
        return { kind: "revoked", invitation: recordOf(row) };
      }
      const current = await handle.execute<StatusRow>(sql`
        SELECT status FROM public.workspace_invitations WHERE id = ${invitationId}::uuid AND workspace_id = ${workspaceId}::uuid`);
      return current[0] !== undefined && statusOf(current[0].status) === "revoked" ? { kind: "already_revoked" } : { kind: "not_found" };
    },

    async enqueue(jobs) {
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
    },
  };
}

/** What accepting an invitation needs of an account-level transaction: the operation and the queue of its events. */
export interface InvitationAcceptanceRepository {
  /**
   * Accepts the invitation the token hash belongs to for the account of the transaction through
   * `sys_invitation_accept`, which locks the workspace, the account and the invitation and does everything in one
   * call. `seatLimit` is the seats the workspace may hold, null for no limit. Needs no workspace in the transaction.
   */
  accept(tokenHash: Buffer, seatLimit: number | null): Promise<InvitationAcceptResult>;
  /** Queues `jobs` in the open transaction, so each exists exactly when the acceptance does. */
  enqueue(jobs: readonly QueuedJob[]): Promise<void>;
}

export function invitationAcceptanceRepository(tx: TenantTx): InvitationAcceptanceRepository {
  return {
    async accept(tokenHash, seatLimit) {
      if (tokenHash.length !== 32) {
        throw new RangeError("tokenHash must be a 32-byte SHA-256 digest");
      }
      const rows = await tenantHandle(tx).execute<AcceptedRow>(sql`
        SELECT outcome, accepted_workspace_id, accepted_invitation_id, accepted_role
        FROM public.sys_invitation_accept(decode(${tokenHash.toString("hex")}, 'hex'), ${tx.accountId}::uuid, ${seatLimit}::int)`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_invitation_accept did not return exactly one row");
      }
      switch (row.outcome) {
        case "accepted":
          if (row.accepted_workspace_id === null || row.accepted_invitation_id === null || row.accepted_role === null) {
            throw new Error("sys_invitation_accept accepted without naming the workspace, the invitation and the role");
          }
          return { kind: "accepted", workspaceId: row.accepted_workspace_id, invitationId: row.accepted_invitation_id, role: roleOf(row.accepted_role) };
        case "gone":
        case "email_mismatch":
        case "already_member":
        case "seat_limit_reached":
          return { kind: row.outcome };
        default:
          throw new Error("sys_invitation_accept returned an outcome outside accepted, gone, email_mismatch, already_member and seat_limit_reached");
      }
    },

    async enqueue(jobs) {
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
    },
  };
}
