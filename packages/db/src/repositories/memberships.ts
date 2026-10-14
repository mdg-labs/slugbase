import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { workspaceMembers, workspaces, type MemberRole } from "../schema/workspaces.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The account's memberships (doc 05 section 2.2), read for the tenant resolver
// and for the profile. Both statements run on the row-level security of
// `workspace_members` and `workspaces` (T1): the account sees its own rows and
// the workspaces it is a member of, so a workspace it does not belong to is
// neither listed nor writable whatever id is named. The account predicate is
// the application layer on top of that.

/** One workspace an account is a member of, with its role. */
export interface Membership {
  readonly workspaceId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly joinedAt: Date;
  /** When the member last acted in the workspace; null when it never has. */
  readonly lastActiveAt: Date | null;
}

export interface MembershipRepository {
  /**
   * The account's memberships in workspaces that are not being deleted, the most
   * recently active first: by `last_active_at` (never active last), then `joined_at`
   * (newest first), then the workspace id. Works in an account-level transaction.
   */
  list(): Promise<readonly Membership[]>;
  /**
   * Moves `last_active_at` of the membership in the transaction's workspace to now,
   * unless it was moved within the last minute; says whether it wrote. Needs a
   * transaction opened with a workspace.
   */
  touch(): Promise<boolean>;
}

export function membershipRepository(tx: TenantTx): MembershipRepository {
  return {
    async list() {
      const handle = tenantHandle(tx);
      return handle
        .select({
          workspaceId: workspaces.id,
          name: workspaces.name,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
          lastActiveAt: workspaceMembers.lastActiveAt,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(and(eq(workspaceMembers.accountId, tx.accountId), isNull(workspaces.deletingAt)))
        .orderBy(sql`${workspaceMembers.lastActiveAt} DESC NULLS LAST`, desc(workspaceMembers.joinedAt), workspaces.id);
    },

    async touch() {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "touching a membership needs a tenant transaction opened with a workspace");
      }
      const handle = tenantHandle(tx);
      const written = await handle
        .update(workspaceMembers)
        .set({ lastActiveAt: sql`now()` })
        .where(
          and(
            eq(workspaceMembers.workspaceId, tx.workspaceId),
            eq(workspaceMembers.accountId, tx.accountId),
            or(isNull(workspaceMembers.lastActiveAt), lte(workspaceMembers.lastActiveAt, sql`now() - interval '1 minute'`)),
          ),
        )
        .returning({ accountId: workspaceMembers.accountId });
      return written.length === 1;
    },
  };
}
