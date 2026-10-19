import { normalizeEmail } from "../auth/email.ts";
import type { DomainEvent } from "../events/catalog.ts";
import type { WorkspaceDeletionGuardResult } from "../workspaces/delete.ts";

// Deleting an account (doc 02 section 2.10, doc 04 section 10.3, doc 05 section 7.1, doc 01 section 13.2, Q24, Q54).
// The caller has judged the fresh re-authentication; the service judges the typed confirmation first, reads what the
// deletion would do to each workspace of the account, refuses while the account is the last instance admin or the only
// owner of a workspace that has other members, and then asks the deletion guard of the composition, once for the account and once for each
// workspace that goes with it, before anything changes. Only then does the store delete the account, in the
// transaction it is bound to. A refusal writes nothing, and a guard that cannot answer rejects, so the caller's
// transaction must not commit and the account stays. The account's content in shared workspaces is not handled
// here: the modules that own it keep it ownerless when they are told `account.deleted`.

/** A workspace named for the caller, who is a member of it. */
export interface AccountDeletionWorkspace {
  readonly id: string;
  readonly name: string;
}

/** What deleting the account would do to the workspaces it belongs to that are not being deleted. */
export interface AccountDeletionScope {
  /** Workspaces where the account is the only owner and that have other members; the account cannot be deleted while any exists. */
  readonly blocking: readonly AccountDeletionWorkspace[];
  /** Workspaces where the account is the only member; they are deleted with it. */
  readonly soleMember: readonly AccountDeletionWorkspace[];
  /** The account holds the instance-admin flag and no other account does; the account cannot be deleted. */
  readonly lastInstanceAdmin: boolean;
}

export interface AccountDeletionRequest {
  /** The workspaces of `soleMember` that the guard was asked about, which go with the account. */
  readonly soleWorkspaceIds: readonly string[];
  /** Queued in the transaction that deletes the account, and only when it does. */
  readonly events: readonly DomainEvent<"account.deleted">[];
}

export interface AccountDeletionStore {
  /** The scope of the deletion of the account of the transaction the store is bound to; it holds for the rest of that transaction. */
  scope(): Promise<AccountDeletionScope>;
  /**
   * Deletes the account of the transaction, puts `soleWorkspaceIds` through the workspace deletion path and queues
   * the jobs of both and the events, in the open transaction. False, with nothing written, when the scope no longer
   * is what `soleWorkspaceIds` says, the account is the last instance admin or the account is gone.
   */
  delete(request: AccountDeletionRequest): Promise<boolean>;
}

/** What the deletion guard is asked: the account once, then each workspace that would be deleted with it. */
export type AccountDeletionGuardInput =
  | { readonly kind: "account"; readonly accountId: string }
  | { readonly kind: "workspace"; readonly accountId: string; readonly workspaceId: string };

export interface AccountDeletionDependencies<Code extends string> {
  readonly store: AccountDeletionStore;
  /**
   * The guard of the composition (doc 01 section 13.2). A guard that cannot answer rejects, which refuses the request
   * before anything is written; it never refuses by throwing.
   */
  readonly guard: (input: AccountDeletionGuardInput) => Promise<WorkspaceDeletionGuardResult<Code>>;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface AccountDeletionAsk {
  /** The account that asks, the one of the transaction. */
  readonly accountId: string;
  /** The address the account holds. */
  readonly accountEmail: string;
  /** The address the caller typed to confirm. */
  readonly typedEmail: string;
}

export type AccountDeletionOutcome<Code extends string> =
  /** The account is deleted; `workspaces` are the workspaces that were deleted with it. */
  | { readonly kind: "deleted"; readonly workspaces: readonly AccountDeletionWorkspace[] }
  /** The typed address is not the account's; nothing was read or written. */
  | { readonly kind: "email_mismatch" }
  /** The account is the only instance admin; nothing was written. */
  | { readonly kind: "last_instance_admin" }
  /** The account is the only owner of these workspaces, which have other members; nothing was written. */
  | { readonly kind: "last_owner"; readonly workspaces: readonly AccountDeletionWorkspace[] }
  /** The guard refused with `code`, for the account or for one of the workspaces; nothing was written. */
  | { readonly kind: "refused"; readonly code: Code }
  /** The account is gone, or the workspaces changed under the request; nothing was written. */
  | { readonly kind: "unavailable" };

function sameAddress(a: string, b: string): boolean {
  return normalizeEmail(a).toLowerCase() === normalizeEmail(b).toLowerCase();
}

/**
 * Deletes the account of the transaction the store is bound to when the typed address is its own, it is not the last
 * instance admin, no workspace would be left without an owner and the guard allows the account and each workspace
 * that goes with it.
 */
export async function deleteAccount<Code extends string>(
  { store, guard, newId }: AccountDeletionDependencies<Code>,
  ask: AccountDeletionAsk,
): Promise<AccountDeletionOutcome<Code>> {
  if (!sameAddress(ask.typedEmail, ask.accountEmail)) {
    return { kind: "email_mismatch" };
  }
  const { blocking, soleMember, lastInstanceAdmin } = await store.scope();
  if (lastInstanceAdmin) {
    return { kind: "last_instance_admin" };
  }
  if (blocking.length > 0) {
    return { kind: "last_owner", workspaces: blocking };
  }
  const account = await guard({ kind: "account", accountId: ask.accountId });
  if (account.outcome === "refuse") {
    return { kind: "refused", code: account.code };
  }
  for (const workspace of soleMember) {
    const verdict = await guard({ kind: "workspace", accountId: ask.accountId, workspaceId: workspace.id });
    if (verdict.outcome === "refuse") {
      return { kind: "refused", code: verdict.code };
    }
  }
  const deleted = await store.delete({
    soleWorkspaceIds: soleMember.map((workspace) => workspace.id),
    events: [{ eventId: newId(), name: "account.deleted", payload: { accountId: ask.accountId } }],
  });
  return deleted ? { kind: "deleted", workspaces: soleMember } : { kind: "unavailable" };
}
