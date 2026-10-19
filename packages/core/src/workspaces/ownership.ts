import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import type { MemberRoleStore } from "./members.ts";

// Transferring the ownership of a workspace (doc 02 section 3.3, doc 04 section 10.4, doc 10 T18). An owner
// makes another member an owner and, when asked, steps down to admin in the same transaction. The store is the
// one of a role change: it locks the workspace's row before it reads the roles, so the roles judged here are
// the roles written and two changes in one workspace queue instead of each judging a state the other is about
// to replace. That the workspace keeps an owner is the database's rule (the deferred constraint trigger on
// workspace_members), which refuses the commit of a transaction that would leave none. Only an owner may
// transfer; the authorization stage has judged that before the service runs, and it is judged again here under
// the lock. A transfer that changed nothing writes no audit event; a failure of a write rejects, so the
// caller's transaction does not commit and neither role is changed alone.

export interface OwnershipTransferDependencies {
  readonly store: MemberRoleStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
}

export interface OwnershipTransferAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /** The owner that asks, the account of the transaction. */
  readonly actorAccountId: string;
  /** The member who becomes an owner. */
  readonly targetAccountId: string;
  /** Whether the owner that asks becomes an admin. */
  readonly demoteSelf: boolean;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type OwnershipTransferOutcome =
  /** The roles were changed and the event written; `promoted` says the recipient was not an owner before, `demoted` that the caller stepped down. */
  | { readonly kind: "transferred"; readonly promoted: boolean; readonly demoted: boolean }
  /** The recipient is an owner already and the caller stays one; nothing was written. */
  | { readonly kind: "unchanged" }
  /** The account that asks is not an owner; nothing was written. */
  | { readonly kind: "forbidden" }
  /** The recipient is the account that asks; nothing was written. */
  | { readonly kind: "invalid_recipient" }
  /** The workspace has no such member, the caller is none, or the workspace cannot be reached. */
  | { readonly kind: "not_found" };

/**
 * Makes `targetAccountId` an owner, then, when `demoteSelf` is set, the caller an admin, and writes
 * `workspace.ownership_transferred` in the transaction the stores are bound to. The recipient is promoted
 * first, so the workspace never has fewer owners than it had at any statement of the transaction.
 */
export async function transferOwnership({ store, audit }: OwnershipTransferDependencies, ask: OwnershipTransferAsk): Promise<OwnershipTransferOutcome> {
  const roles = await store.roles(ask.targetAccountId);
  if (roles?.actor === undefined) {
    return { kind: "not_found" };
  }
  if (roles.actor !== "owner") {
    return { kind: "forbidden" };
  }
  if (ask.targetAccountId.toLowerCase() === ask.actorAccountId.toLowerCase()) {
    return { kind: "invalid_recipient" };
  }
  if (roles.target === undefined) {
    return { kind: "not_found" };
  }
  const promoted = roles.target !== "owner";
  if (!promoted && !ask.demoteSelf) {
    return { kind: "unchanged" };
  }
  if (promoted && !(await store.setRole(ask.targetAccountId, "owner"))) {
    throw new Error("the recipient of the ownership transfer has no membership row to change");
  }
  if (ask.demoteSelf && !(await store.setRole(ask.actorAccountId, "admin"))) {
    throw new Error("the caller of the ownership transfer has no membership row to change");
  }
  await audit.write({
    action: "workspace.ownership_transferred",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "member", id: ask.targetAccountId },
    metadata: { demoteSelf: ask.demoteSelf ? "true" : "false" },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "transferred", promoted, demoted: ask.demoteSelf };
}
