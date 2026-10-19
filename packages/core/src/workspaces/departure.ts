import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import type { DomainEvent, MemberContentChoice } from "../events/catalog.ts";
import type { MemberRoleStore } from "./members.ts";

// Ending a membership (doc 02 sections 3.3 and 3.6, doc 04 sections 10.4 and 10.5, Q23, doc 10 T2): an
// admin removes a member, or a member leaves on their own. Both are the same change to the workspace: the
// membership is deleted and `member.left`, which carries the member's content choice and its recipient, is
// queued in the same transaction, so the modules that own content are told exactly when the membership is
// gone (the event job is delivered at least once, after the commit). The roles are read
// under the lock of the workspace's row (`MemberRoleStore.roles`), the same lock the role change takes, so the
// roles the service judges are the roles it acts on. That a workspace keeps an owner is the database's rule,
// the deferred constraint trigger on workspace_members, which refuses the commit of a transaction that leaves
// none; the service only has nobody to name as the default recipient when the member is the one owner left,
// and says so. A refusal writes nothing; a failure of a write rejects, so the caller's transaction must not commit.

export interface MembershipEndRequest {
  /** The member whose membership ends. */
  readonly accountId: string;
  /** Queued in the transaction that deletes the membership, and only when it does. */
  readonly events: readonly DomainEvent<"member.left">[];
}

export interface MembershipEndStore extends MemberRoleStore {
  /**
   * The account that has been an owner of the workspace of the transaction the longest, other than
   * `excludingAccountId`: the earliest `joinedAt`, then the lowest account identifier. Undefined when the
   * workspace has no other owner.
   */
  longestStandingOwner(excludingAccountId: string): Promise<string | undefined>;
  /** Deletes the membership and queues the events, in the transaction the store is bound to; false when the workspace has no such member. */
  end(request: MembershipEndRequest): Promise<boolean>;
}

export interface MembershipEndDependencies {
  readonly store: MembershipEndStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface MembershipEndAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /** The account that asks, the one of the transaction. */
  readonly actorAccountId: string;
  /** The member whose membership ends; the account that asks when a member leaves. */
  readonly targetAccountId: string;
  readonly content: MemberContentChoice;
  /** The recipient the caller named, if any. */
  readonly transferTo?: string;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type MembershipEndOutcome =
  /** The membership was deleted; `transferTo` is the recipient the ask resolved to, `self` says the member is the account that asked. */
  | { readonly kind: "ended"; readonly content: MemberContentChoice; readonly transferTo: string; readonly self: boolean }
  /** The account that asks may not remove this member; nothing was written. */
  | { readonly kind: "forbidden" }
  /** The workspace has no such member, or cannot be reached. */
  | { readonly kind: "not_found" }
  /** The member is the owner the workspace has left; nothing was written. */
  | { readonly kind: "last_owner" }
  /** The named recipient is no member of the workspace, which is answered like any account outside it; nothing was written. */
  | { readonly kind: "recipient_not_found" }
  /** The named recipient is the member whose membership ends; nothing was written. */
  | { readonly kind: "invalid_recipient" };

/**
 * An admin or an owner removes a member who is not an owner, an owner removes any member, and a member
 * who names themselves leaves, whatever their role. The recipient of a transfer is the one named, who must be
 * another current member, and otherwise the account that removes the member, or the longest-standing owner
 * when the member leaves. Deletes the membership and queues `member.left`, then writes `member.removed` or
 * `member.left` (for a member who leaves) to the audit log, in the transaction the stores are bound to.
 */
export async function endMembership({ store, audit, newId }: MembershipEndDependencies, ask: MembershipEndAsk): Promise<MembershipEndOutcome> {
  const target = ask.targetAccountId.toLowerCase();
  const self = ask.actorAccountId.toLowerCase() === target;
  const roles = await store.roles(target);
  if (roles?.actor === undefined || roles.target === undefined) {
    return { kind: "not_found" };
  }
  if (!self && (roles.actor === "member" || (roles.target === "owner" && roles.actor !== "owner"))) {
    return { kind: "forbidden" };
  }

  let recipient: string | undefined;
  if (ask.transferTo !== undefined) {
    recipient = ask.transferTo.toLowerCase();
    if (recipient === target) {
      return { kind: "invalid_recipient" };
    }
    if ((await store.roles(recipient))?.target === undefined) {
      return { kind: "recipient_not_found" };
    }
  } else {
    recipient = self ? await store.longestStandingOwner(target) : ask.actorAccountId.toLowerCase();
    if (recipient === undefined) {
      return { kind: "last_owner" };
    }
  }

  const ended = await store.end({
    accountId: target,
    events: [{ eventId: newId(), name: "member.left", payload: { workspaceId: ask.workspaceId, accountId: target, content: ask.content, transferTo: recipient } }],
  });
  if (!ended) {
    return { kind: "not_found" };
  }
  await audit.write({
    action: self ? "member.left" : "member.removed",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "member", id: target },
    metadata: { content: ask.content, transferTo: recipient },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "ended", content: ask.content, transferTo: recipient, self };
}
