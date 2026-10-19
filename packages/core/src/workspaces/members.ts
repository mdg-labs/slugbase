import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import type { WorkspaceRole } from "../ports/tenant-resolver.ts";

// Changing a member's role (doc 02 section 3.3, doc 04 section 10.5, doc 10 T2). The store behind the port
// reaches the rows in the transaction of the request and holds the workspace's lock from the first read
// to the end of that transaction, so the roles the service judges are the roles it changes and two role
// changes in one workspace queue instead of each judging a state the other is about to replace. The
// service decides who may change which role and what is recorded; that the workspace keeps an owner is
// the database's rule (the deferred constraint trigger on workspace_members), which refuses the commit of
// a transaction that would leave none. A change that did not happen writes no audit event and rotates no
// session; a failure of the audit write rejects, so the caller's transaction must not commit.

/** The roles of the acting account and of the member whose role is asked to change, as the store read them under the lock. */
export interface MemberRoles {
  /** The role of the account that asks; undefined when it is not a member of the workspace. */
  readonly actor: WorkspaceRole | undefined;
  /** The role of the member the change is for; undefined when the workspace has no such member. */
  readonly target: WorkspaceRole | undefined;
}

export interface MemberRoleStore {
  /**
   * Locks the workspace of the transaction and reads the roles of the account of the transaction and of
   * `targetAccountId` in it. Undefined when the workspace cannot be reached (it is being deleted).
   */
  roles(targetAccountId: string): Promise<MemberRoles | undefined>;
  /** Sets the role of the member in the workspace of the transaction; false when it has no such member. */
  setRole(targetAccountId: string, role: WorkspaceRole): Promise<boolean>;
}

export interface MemberRoleDependencies {
  readonly store: MemberRoleStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
}

export interface MemberRoleAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /** The account that asks, the one of the transaction. */
  readonly actorAccountId: string;
  readonly targetAccountId: string;
  readonly role: WorkspaceRole;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type MemberRoleOutcome =
  /** The role was replaced; `self` says the member is the account that asked. */
  | { readonly kind: "changed"; readonly from: WorkspaceRole; readonly to: WorkspaceRole; readonly self: boolean }
  /** The member already has the role; nothing was written. */
  | { readonly kind: "unchanged"; readonly role: WorkspaceRole }
  /** The account that asks may not make this change; nothing was written. */
  | { readonly kind: "forbidden" }
  /** The workspace has no such member, or cannot be reached. */
  | { readonly kind: "not_found" };

/**
 * An admin or an owner switches a member who is not an owner between `admin` and `member`; only an owner
 * promotes to `owner` or changes the role of an owner, an admin included when it asks about itself. Writes
 * `member.role_changed` with the old and the new role in the transaction the stores are bound to.
 */
export async function changeMemberRole({ store, audit }: MemberRoleDependencies, ask: MemberRoleAsk): Promise<MemberRoleOutcome> {
  const roles = await store.roles(ask.targetAccountId);
  if (roles?.actor === undefined) {
    return { kind: "not_found" };
  }
  if (roles.actor === "member") {
    return { kind: "forbidden" };
  }
  if (roles.target === undefined) {
    return { kind: "not_found" };
  }
  if (roles.actor !== "owner" && (roles.target === "owner" || ask.role === "owner")) {
    return { kind: "forbidden" };
  }
  if (roles.target === ask.role) {
    return { kind: "unchanged", role: roles.target };
  }
  if (!(await store.setRole(ask.targetAccountId, ask.role))) {
    return { kind: "not_found" };
  }
  await audit.write({
    action: "member.role_changed",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "member", id: ask.targetAccountId },
    metadata: { from: roles.target, to: ask.role },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "changed", from: roles.target, to: ask.role, self: ask.targetAccountId.toLowerCase() === ask.actorAccountId.toLowerCase() };
}
