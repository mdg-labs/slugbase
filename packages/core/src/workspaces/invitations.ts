import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import { generateCredentialToken } from "../auth/credential-tokens.ts";
import { normalizeEmail } from "../auth/email.ts";
import type { MailMessage } from "../ports/mail.ts";
import type { WorkspaceRole } from "../ports/tenant-resolver.ts";

// Inviting a person into a workspace by email (doc 02 section 3.4, doc 04 section 10.5, doc 10 T4 and T19). An
// admin or owner invites an address as an admin or a member: an invitation never grants the owner role, which
// the service refuses before anything is written and the `workspace_invitations` table refuses again with a
// CHECK. The invitation holds the hash of its token and nothing else of it. The service stores a hash whose
// token nobody holds, so a fresh invitation, or one a request resends, has no working link until the job
// that mails it issues the token and puts it into the message (which is why no token is in a queued payload,
// a log line or a response), and a resend ends the earlier link at once. Inviting an address that already has
// a pending invitation is a resend of that invitation: the same row gets the new role and teams, the new
// inviter, a new expiry and a new token. An address that already belongs to a member is refused. Teams cannot
// be invited into until team membership exists. The invitation, its audit event and the mail job are one
// transaction, so each exists exactly when the others do; a failure of a write rejects, so the caller's
// transaction must not commit.

/** How long an invitation can be accepted for, in seconds (doc 02 section 3.4): 7 days. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The roles an invitation can grant: an invitation never makes an owner. */
export const INVITATION_ROLES = ["admin", "member"] as const;

export type InvitationRole = (typeof INVITATION_ROLES)[number];

export type InvitationStatus = "pending" | "accepted" | "revoked";

/** An invitation as the workspace sees it; never the token or its hash. */
export interface InvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly teamIds: readonly string[];
  readonly status: InvitationStatus;
  /** The account that made the request that wrote the invitation last; null once that account is deleted. */
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface NewInvitation {
  /** A fresh UUIDv7, used only when no pending invitation of the address exists. */
  readonly id: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly teamIds: readonly string[];
  /** SHA-256 of a token nobody holds yet; the mail job replaces it with the hash of the token it mails. */
  readonly tokenHash: Buffer;
  /** How long the invitation can be accepted for, counted by the database's clock when it writes the row. */
  readonly ttlSeconds: number;
}

export interface InvitationStore {
  /**
   * The role of the account of the transaction in the workspace of the transaction; undefined when it is no
   * member or the workspace cannot be reached.
   */
  actorRole(): Promise<WorkspaceRole | undefined>;
  /** Whether an account that is a member of the workspace of the transaction holds the address. */
  memberHoldsEmail(email: string): Promise<boolean>;
  /**
   * Writes the invitation for the workspace of the transaction, or, when the address already has a pending
   * one, replaces that invitation's role, teams, inviter, token hash and expiry; `resent` says which. One
   * statement, so two requests for one address leave one pending invitation.
   */
  writePending(invitation: NewInvitation): Promise<{ readonly invitation: InvitationRecord; readonly resent: boolean }>;
  /** The language of the account that holds the address of the pending invitation; undefined when none does. */
  inviteeLocale(invitationId: string): Promise<string | undefined>;
}

export interface InvitationDependencies {
  readonly store: InvitationStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
  /** How long the invitation can be accepted for; `INVITATION_TTL_SECONDS` unless the composition says otherwise. */
  readonly ttlSeconds: number;
}

export interface InvitationAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /** The language of the account that asks: the invitation is written in it when the invitee's is not known. */
  readonly actorLocale: string;
  /** What the caller sent. */
  readonly email: string;
  readonly role: string;
  readonly teamIds: readonly string[];
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type InvitationOutcome =
  /** The invitation was written; `locale` is the language its email is written in. */
  | { readonly kind: "invited" | "resent"; readonly invitation: InvitationRecord; readonly locale: string }
  /** The account that asks is not an admin or owner of the workspace; nothing was written. */
  | { readonly kind: "forbidden" }
  /** The role is not one an invitation can grant; nothing was written. */
  | { readonly kind: "invalid_role" }
  /** The request names teams, which cannot be invited into yet; nothing was written. */
  | { readonly kind: "teams_unavailable" }
  /** The address belongs to a member of the workspace; nothing was written. */
  | { readonly kind: "already_member" };

function isInvitationRole(role: string): role is InvitationRole {
  return INVITATION_ROLES.some((candidate) => candidate === role);
}

/**
 * Invites `ask.email` as `ask.role` and records `invitation.created`, or `invitation.resent` when the address
 * already had a pending invitation, in the transaction the stores are bound to.
 */
export async function inviteMember({ store, audit, newId, ttlSeconds }: InvitationDependencies, ask: InvitationAsk): Promise<InvitationOutcome> {
  if (!isInvitationRole(ask.role)) {
    return { kind: "invalid_role" };
  }
  if (ask.teamIds.length > 0) {
    return { kind: "teams_unavailable" };
  }
  const actorRole = await store.actorRole();
  if (actorRole !== "owner" && actorRole !== "admin") {
    return { kind: "forbidden" };
  }
  const email = normalizeEmail(ask.email);
  if (await store.memberHoldsEmail(email)) {
    return { kind: "already_member" };
  }
  const { invitation, resent } = await store.writePending({
    id: newId(),
    email,
    role: ask.role,
    teamIds: ask.teamIds,
    tokenHash: generateCredentialToken().hash,
    ttlSeconds,
  });
  await audit.write({
    action: resent ? "invitation.resent" : "invitation.created",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "invitation", id: invitation.id },
    metadata: { role: ask.role },
    ipPrefix: ask.ipPrefix,
  });
  const locale = (await store.inviteeLocale(invitation.id)) ?? ask.actorLocale;
  return { kind: resent ? "resent" : "invited", invitation, locale };
}

/** What the invitation email says; the token exists only here, for the length of the send. */
export interface InvitationMessageContent {
  /** The invited address. */
  readonly to: string;
  /** The language the message is written in; the template falls back to English for one it has no catalog for. */
  readonly locale: string;
  readonly workspaceName: string;
  /** The display name of the account that invited; empty when it is no longer known. */
  readonly inviterName: string;
  readonly role: InvitationRole;
  /** The text the link carries, from `generateCredentialToken`. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** The email that carries an invitation's link to its address (doc 02 section 3.4), the `invitation` template of `@slugbase/email`. */
export function invitationMessage(content: InvitationMessageContent): MailMessage {
  return {
    template: "invitation",
    to: content.to,
    locale: content.locale,
    data: {
      workspaceName: content.workspaceName,
      inviterName: content.inviterName,
      role: content.role,
      token: content.token,
      expiresOn: content.expiresAt.toISOString().slice(0, 10),
    },
  };
}
