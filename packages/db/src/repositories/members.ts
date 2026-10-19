import type { MemberRoleStore, MemberRoles, WorkspaceRole } from "@slugbase/core";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { workspaceMembers, type MemberRole } from "../schema/workspaces.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The members of the active workspace (doc 05 sections 2.1 and 2.2, doc 04 section 10.5, doc 10 T1 and T2).
// The list joins `workspace_members` to the co-member projection of `accounts`: the three columns `id`,
// `display_name` and `email`, which the row-level security of `accounts` shows for the members of the active
// workspace and for no other account. Every statement names the workspace of the transaction and runs on the
// policies of both tables on top of that, so a workspace the transaction does not act in is neither listed nor
// changed whatever account is named.
//
// A role change reads the roles it judges under the lock of the workspace's row, which the deferred constraint
// trigger of `workspace_members` takes as well (src/sql/270-member-roles.sql): two role changes in one
// workspace queue on it, so each judges the roles the other left. The trigger is the database's own guard
// that a workspace keeps an owner; it refuses the commit of a transaction that would leave none, and
// `isLastOwnerViolation` tells that refusal from any other error.

/** One member of the workspace, with the co-member projection of the member's account. */
export interface WorkspaceMember {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly joinedAt: Date;
  /** Null when the member never acted in the workspace. */
  readonly lastActiveAt: Date | null;
}

export interface MemberRepository extends MemberRoleStore {
  /**
   * The members of the workspace of the transaction in the order of their account identifiers, the ones after
   * `afterAccountId` when it is given, at most `limit`. Needs a transaction opened with a workspace.
   */
  list(afterAccountId: string | null, limit: number): Promise<readonly WorkspaceMember[]>;
  /** One member of the workspace of the transaction; undefined when the account is not one. Needs a transaction opened with a workspace. */
  member(accountId: string): Promise<WorkspaceMember | undefined>;
  /**
   * Gives the full session `sessionId` of the account of the transaction a new token (`tokenHash`, the SHA-256
   * of 32 random bytes) through `sys_session_rotate`, in the open transaction, so the new token exists exactly
   * when the change that asked for it does. False, with the session unchanged, for a session that is not a full
   * session of that account.
   */
  rotateSession(sessionId: string, tokenHash: Uint8Array): Promise<boolean>;
}

/** The name of the constraint trigger that keeps an owner in every workspace; the commit it refuses names it. */
export const OWNER_REQUIRED_CONSTRAINT = "workspace_members_owner_required";

const CHECK_VIOLATION = "23514";
const MAX_CAUSE_DEPTH = 4;

/**
 * Whether the error is the database refusing a transaction that would leave a workspace without an owner: a
 * check violation that names the constraint of the trigger, on the error itself or on one of its causes (a
 * query error wraps the driver's).
 */
export function isLastOwnerViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, constraint_name: constraintName, cause } = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (code === CHECK_VIOLATION && constraintName === OWNER_REQUIRED_CONSTRAINT) {
      return true;
    }
    current = cause;
  }
  return false;
}

function roleOf(value: string): WorkspaceRole {
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }
  throw new Error("workspace_members.role holds a value outside owner, admin and member");
}

interface RoleRow extends Record<string, unknown> {
  account_id: string;
  role: string;
}

interface FlagRow extends Record<string, unknown> {
  done: boolean;
}

function workspaceOf(tx: TenantTx, what: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${what} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

const shown = {
  accountId: accounts.id,
  displayName: accounts.displayName,
  email: accounts.email,
  role: workspaceMembers.role,
  joinedAt: workspaceMembers.joinedAt,
  lastActiveAt: workspaceMembers.lastActiveAt,
};

export function memberRepository(tx: TenantTx): MemberRepository {
  return {
    async list(afterAccountId, limit) {
      const workspaceId = workspaceOf(tx, "listing the members");
      return tenantHandle(tx)
        .select(shown)
        .from(workspaceMembers)
        .innerJoin(accounts, eq(accounts.id, workspaceMembers.accountId))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), afterAccountId === null ? undefined : gt(workspaceMembers.accountId, afterAccountId)))
        .orderBy(asc(workspaceMembers.accountId))
        .limit(limit);
    },

    async member(accountId) {
      const workspaceId = workspaceOf(tx, "reading a member");
      const [row] = await tenantHandle(tx)
        .select(shown)
        .from(workspaceMembers)
        .innerJoin(accounts, eq(accounts.id, workspaceMembers.accountId))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.accountId, accountId)));
      return row;
    },

    async roles(targetAccountId): Promise<MemberRoles | undefined> {
      const workspaceId = workspaceOf(tx, "reading the roles of members");
      const handle = tenantHandle(tx);
      const locked = await handle.execute(sql`
        SELECT 1 FROM public.workspaces WHERE id = ${workspaceId}::uuid AND deleting_at IS NULL FOR NO KEY UPDATE`);
      if (locked.length === 0) {
        return undefined;
      }
      const rows = await handle.execute<RoleRow>(sql`
        SELECT account_id, role::text AS role FROM public.workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND account_id IN (${tx.accountId}::uuid, ${targetAccountId}::uuid)`);
      const roleOfAccount = (accountId: string): WorkspaceRole | undefined => {
        const row = rows.find((candidate) => candidate.account_id === accountId.toLowerCase());
        return row === undefined ? undefined : roleOf(row.role);
      };
      return { actor: roleOfAccount(tx.accountId), target: roleOfAccount(targetAccountId) };
    },

    async setRole(targetAccountId, role) {
      const workspaceId = workspaceOf(tx, "changing a role");
      const written = await tenantHandle(tx)
        .update(workspaceMembers)
        .set({ role })
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.accountId, targetAccountId)))
        .returning({ accountId: workspaceMembers.accountId });
      return written.length === 1;
    },

    async rotateSession(sessionId, tokenHash) {
      const rows = await tenantHandle(tx).execute<FlagRow>(sql`
        SELECT public.sys_session_rotate(${sessionId}::uuid, ${tx.accountId}::uuid, decode(${Buffer.from(tokenHash).toString("hex")}, 'hex')) AS done`);
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error("sys_session_rotate did not return exactly one row");
      }
      return row.done;
    },
  };
}
