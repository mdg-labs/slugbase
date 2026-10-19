import type { AuditActor, AuditWriter } from "../audit/writer.ts";

// Requesting the deletion of a workspace (doc 02 section 3.7, doc 04 section 10.4, doc 05 section 7.2,
// doc 01 section 13.2). The request marks the workspace as being deleted, which hides it at once, and records
// the request in the audit log; a background job then removes the rows (the `workspace.delete` job). Before
// anything changes the deletion guard of the composition is consulted, and a refusal changes nothing and
// writes no audit event. The guard is the last check before the change: who may ask (an owner), the fresh
// re-authentication and the typed confirmation are judged before the service runs. A failure of the audit
// write rejects, so the caller's transaction must not commit and the workspace stays visible.

/** The answer of the deletion guard: allow, or refuse with a code from the closed list of the hook. */
export type WorkspaceDeletionGuardResult<Code extends string = string> =
  | { readonly outcome: "allow" }
  | { readonly outcome: "refuse"; readonly code: Code };

export interface WorkspaceDeletionGuardInput {
  readonly workspaceId: string;
  /** The account that asks. */
  readonly accountId: string;
}

export interface WorkspaceDeletionStore {
  /**
   * Marks the workspace of the transaction as being deleted, with the effects of doc 05 section 7.2, and
   * queues the job that removes its rows, in the transaction the store is bound to. False, with nothing
   * written, when the caller is not an owner of the workspace or the workspace is already being deleted.
   */
  markDeleting(): Promise<boolean>;
}

export interface WorkspaceDeletionDependencies<Code extends string> {
  readonly store: WorkspaceDeletionStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
  /**
   * The guard of the composition (doc 01 section 13.2). A guard that cannot answer rejects, which refuses the
   * request before anything is written; it never refuses by throwing.
   */
  readonly guard: (input: WorkspaceDeletionGuardInput) => Promise<WorkspaceDeletionGuardResult<Code>>;
}

export interface WorkspaceDeletionAsk {
  readonly workspaceId: string;
  /** The owner that asks, an account of the workspace. */
  readonly actor: Extract<AuditActor, { type: "account" }>;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type WorkspaceDeletionOutcome<Code extends string> =
  /** The workspace is marked, the job is queued and the request is in the audit log. */
  | { readonly kind: "requested" }
  /** The guard refused with `code`; nothing was written. */
  | { readonly kind: "refused"; readonly code: Code }
  /** The workspace cannot be marked: the caller is no owner of it or it is already being deleted; nothing was written. */
  | { readonly kind: "unavailable" };

/**
 * Asks the guard, then marks the workspace of the transaction as being deleted and records
 * `workspace.deletion_requested` in its audit log. The audit event is written after the mark and in the same
 * transaction, so the request is recorded exactly when the workspace is hidden, and both come before the job
 * removes any row.
 */
export async function requestWorkspaceDeletion<Code extends string>(
  { store, audit, guard }: WorkspaceDeletionDependencies<Code>,
  ask: WorkspaceDeletionAsk,
): Promise<WorkspaceDeletionOutcome<Code>> {
  const verdict = await guard({ workspaceId: ask.workspaceId, accountId: ask.actor.accountId });
  if (verdict.outcome === "refuse") {
    return { kind: "refused", code: verdict.code };
  }
  if (!(await store.markDeleting())) {
    return { kind: "unavailable" };
  }
  await audit.write({
    action: "workspace.deletion_requested",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "workspace", id: ask.workspaceId },
    metadata: {},
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "requested" };
}
