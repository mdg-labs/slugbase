import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import { hashCredentialToken } from "../auth/credential-tokens.ts";
import type { DomainEvent } from "../events/catalog.ts";
import type { WorkspaceRole } from "../ports/tenant-resolver.ts";

// Inspecting and accepting an invitation by its token (doc 02 section 3.4, doc 04 sections 3.2 and 10.5, doc 05
// section 3.3, doc 10 T4 and T19). The token is the only credential of the inspection, which answers what the page
// behind the link shows and nothing for a token that is not a pending invitation's: an unknown, used, revoked,
// replaced or expired token, and a text that is not a token at all, are one outcome.
//
// Accepting is the signed-in account's own. The database operation behind it locks the workspace, the account and
// the invitation, checks the status, the expiry and that the account's verified address is the invited one, counts
// the seats against the limit it is given (undefined is unlimited; the entitlement engine supplies it), inserts the
// membership with exactly the invited role and marks the invitation accepted, so a token is accepted at most once
// however many requests carry it. The checks run in a fixed order and a refusal writes nothing: a token that is no
// longer a pending invitation's, then another address, then a member already, then no seat left. The membership, the
// `member.joined` event, its audit event and the session's move to the workspace are one transaction, so each exists
// exactly when the others do; a failure of a write rejects, so the caller's transaction must not commit.

/** What the page behind an invitation link shows. */
export interface InvitationPreview {
  readonly workspaceName: string;
  /** The display name of the account that invited; null once that account is deleted. */
  readonly inviterName: string | null;
  readonly email: string;
  readonly role: WorkspaceRole;
  /** Whether an account holds the invited address. */
  readonly accountExists: boolean;
}

export interface InvitationInspectStore {
  /** The preview of the pending, unexpired invitation the token hash belongs to; undefined for anything else. */
  inspectInvitation(tokenHash: Buffer): Promise<InvitationPreview | undefined>;
}

export type InvitationInspectOutcome =
  | { readonly kind: "inspected"; readonly preview: InvitationPreview }
  /** The text is not the token of a pending, unexpired invitation. */
  | { readonly kind: "gone" };

/** The preview of the invitation behind `token`, or `gone`; reads nothing for a text that cannot be a token. */
export async function inspectInvitation({ store }: { readonly store: InvitationInspectStore }, ask: { readonly token: string }): Promise<InvitationInspectOutcome> {
  const tokenHash = hashCredentialToken(ask.token);
  if (tokenHash === undefined) {
    return { kind: "gone" };
  }
  const preview = await store.inspectInvitation(tokenHash);
  return preview === undefined ? { kind: "gone" } : { kind: "inspected", preview };
}

/** What the database operation answered. */
export type InvitationAcceptResult =
  | { readonly kind: "accepted"; readonly workspaceId: string; readonly invitationId: string; readonly role: WorkspaceRole }
  /** An unknown, used, revoked, replaced or expired token, a workspace being deleted or an account that is gone or disabled. */
  | { readonly kind: "gone" }
  /** The account's verified address is not the invited one, or the account's address is not verified. */
  | { readonly kind: "email_mismatch" }
  | { readonly kind: "already_member" }
  | { readonly kind: "seat_limit_reached" };

/** The store of accepting an invitation, bound to the account-level transaction of the request. */
export interface InvitationAcceptStore {
  /**
   * Accepts the invitation the token hash belongs to for the account of the transaction. `seatLimit` is how many
   * members the workspace may hold, null for no limit; the members are counted under a lock on the workspace.
   */
  accept(tokenHash: Buffer, seatLimit: number | null): Promise<InvitationAcceptResult>;
  /** Queues the events in the transaction, so each exists exactly when the membership does. */
  queueEvents(events: readonly DomainEvent<"member.joined">[]): Promise<void>;
  /** Makes the workspace the active one of the session; false when the session cannot be moved there. */
  activate(sessionId: string, workspaceId: string): Promise<boolean>;
}

export interface InvitationAcceptDependencies {
  readonly store: InvitationAcceptStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface InvitationAcceptAsk {
  /** The token the link carries. */
  readonly token: string;
  /** The account of the session that accepts. */
  readonly actor: Extract<AuditActor, { type: "account" }>;
  /** The session that accepts; it acts in the workspace joined from then on. */
  readonly sessionId: string;
  /** The seats the workspace may hold; null for no limit. */
  readonly seatLimit: number | null;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type InvitationAcceptOutcome = InvitationAcceptResult;

/**
 * Accepts the invitation behind the token for the account, makes the workspace the session's active one and
 * records `member.joined` as an audit event and a domain event, in the transaction the store is bound to.
 */
export async function acceptInvitation({ store, audit, newId }: InvitationAcceptDependencies, ask: InvitationAcceptAsk): Promise<InvitationAcceptOutcome> {
  const tokenHash = hashCredentialToken(ask.token);
  if (tokenHash === undefined) {
    return { kind: "gone" };
  }
  const result = await store.accept(tokenHash, ask.seatLimit);
  if (result.kind !== "accepted") {
    return result;
  }
  await audit.write({
    action: "member.joined",
    workspaceId: result.workspaceId,
    actor: ask.actor,
    entity: { type: "member", id: ask.actor.accountId },
    metadata: { role: result.role },
    ipPrefix: ask.ipPrefix,
  });
  await store.queueEvents([
    { eventId: newId(), name: "member.joined", payload: { workspaceId: result.workspaceId, accountId: ask.actor.accountId, role: result.role } },
  ]);
  if (!(await store.activate(ask.sessionId, result.workspaceId))) {
    throw new Error("the session of the account that joined could not be pointed at the workspace it joined");
  }
  return result;
}
