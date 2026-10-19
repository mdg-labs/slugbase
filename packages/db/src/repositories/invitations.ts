import type { InvitationRecord, InvitationStatus, InvitationStore, NewInvitation, WorkspaceRole } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The invitations of the active workspace (doc 05 section 2.2, doc 02 section 3.4, doc 10 T1, T4 and T19). Every
// statement names the workspace of the transaction and runs on the policies of `workspace_invitations` on top
// of that, so an invitation of a workspace the transaction does not act in is neither read nor changed
// whatever identifier is named. `slugbase_app` may insert an invitation without `instance_issued`, `status`
// and `accepted_by`, so a row it writes is pending, is never an owner's and is never accepted (the CHECK of the
// table refuses the owner role besides), and may change only what a resend replaces. The token is stored as
// its SHA-256 and read back by nobody: no method here returns it or its hash.

interface WrittenRow extends Record<string, unknown> {
  id: string;
  email: string;
  role: string;
  /** A JSON array of identifiers. */
  team_ids: string;
  status: string;
  invited_by: string | null;
  expires_at: string;
  created_at: string;
  inserted: boolean;
}

interface RoleRow extends Record<string, unknown> {
  role: string;
}

interface PresentRow extends Record<string, unknown> {
  present: boolean;
}

interface LocaleRow extends Record<string, unknown> {
  locale: string | null;
}

interface IssuedRow extends Record<string, unknown> {
  email: string;
  role: string;
  expires_at: string;
  workspace_name: string;
}

/** What the email of an invitation says of it, read when the token it carries is issued. */
export interface InvitationMailContext {
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly expiresAt: Date;
  readonly workspaceName: string;
}

export interface InvitationRepository extends InvitationStore {
  /**
   * Gives the pending, unexpired invitation `invitationId` of the workspace of the transaction the token whose
   * SHA-256 is `tokenHash`, which ends the link it had, and answers what its email says; undefined, with
   * nothing changed, when the invitation is not pending or has expired. Needs a transaction opened with a workspace.
   */
  issueToken(invitationId: string, tokenHash: Buffer): Promise<InvitationMailContext | undefined>;
  /**
   * Queues `jobs` in the open transaction, so each exists exactly when the change that asked for it does and
   * none when the transaction ends without it.
   */
  enqueue(jobs: readonly QueuedJob[]): Promise<void>;
}

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

function recordOf(row: WrittenRow): InvitationRecord {
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

    async writePending(invitation: NewInvitation) {
      const workspaceId = workspaceOf(tx, "writing an invitation");
      const rows = await tenantHandle(tx).execute<WrittenRow>(sql`
        INSERT INTO public.workspace_invitations (id, workspace_id, email, role, team_ids, token_hash, invited_by, expires_at)
        VALUES (
          ${invitation.id}::uuid, ${workspaceId}::uuid, ${invitation.email}::citext, ${invitation.role}::member_role,
          ${uuidArray(invitation.teamIds)}::uuid[], decode(${invitation.tokenHash.toString("hex")}, 'hex'), ${tx.accountId}::uuid,
          now() + ${invitation.ttlSeconds}::int * interval '1 second')
        ON CONFLICT (workspace_id, email) WHERE status = 'pending'
        DO UPDATE SET role = EXCLUDED.role, team_ids = EXCLUDED.team_ids, token_hash = EXCLUDED.token_hash,
                      invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at
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

    async issueToken(invitationId, tokenHash) {
      const workspaceId = workspaceOf(tx, "issuing the token of an invitation");
      const rows = await tenantHandle(tx).execute<IssuedRow>(sql`
        UPDATE public.workspace_invitations i
        SET token_hash = decode(${tokenHash.toString("hex")}, 'hex')
        WHERE i.id = ${invitationId}::uuid AND i.workspace_id = ${workspaceId}::uuid AND i.status = 'pending' AND i.expires_at > now()
        RETURNING i.email::text AS email, i.role::text AS role,
                  to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                  (SELECT w.name FROM public.workspaces w WHERE w.id = i.workspace_id) AS workspace_name`);
      const row = rows[0];
      return row === undefined ? undefined : { email: row.email, role: roleOf(row.role), expiresAt: new Date(row.expires_at), workspaceName: row.workspace_name };
    },

    async enqueue(jobs) {
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
    },
  };
}
