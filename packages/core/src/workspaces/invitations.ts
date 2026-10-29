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
// inviter, a new expiry and a new token. Where the composition cannot mail the link, a copied link is the
// only one there is, so such a resend keeps the stored token hash and the link keeps working. An address that
// already belongs to a member is refused. The teams an invitation names must all be teams of the workspace: an
// identifier that is none, whether no team has it or another workspace's team does, is refused alike and names
// nothing (the database joins the teams when the invitation is accepted and skips one that is gone by then). The
// invitation, its audit event and the mail job are one transaction, so each exists exactly when the others
// do; a failure of a write rejects, so the caller's transaction must not commit.
//
// A pending invitation is then listed, resent, given a link and revoked by an admin or an owner (doc 04 section
// 10.5). Resending and giving a link each replace the token hash and the expiry, which ends the earlier link
// at once; a resend leaves the new link to the job that mails it, as an invitation does, and a link is the one
// place a token leaves the server other than the mail: the service makes the token, stores its hash and hands
// the value to the caller to return once, and records no field of it. Revoking ends a pending invitation for
// good; revoking one that is already revoked is the same answer and writes nothing.
//
// The mail job issues its token only while the invitation is still the one the job was queued for. Writing or
// resending an invitation gives it a mail ticket (a random identifier, no secret) that the queued job carries;
// a link replaces the ticket with none. The job's token replaces the stored hash only where the invitation
// still holds the job's ticket, so a link copied after the job was queued, or a later resend, is not ended by
// an earlier job, and a retry of the same job, which finds its ticket still there, issues a token again.

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
  /**
   * Whether a pending invitation of the address keeps the token hash it holds instead of taking `tokenHash`,
   * which leaves a link made for it working. It has no effect on an address without a pending invitation.
   */
  readonly keepTokenHash: boolean;
  /** The ticket of the mail job queued for this write; only that job may issue the invitation's token. */
  readonly mailTicket: string;
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
  /** Whether every identifier is a team of the workspace of the transaction; true for none. A team of another workspace is none. */
  teamsExist(teamIds: readonly string[]): Promise<boolean>;
  /**
   * Writes the invitation for the workspace of the transaction, or, when the address already has a pending
   * one, replaces that invitation's role, teams, inviter, token hash (unless `keepTokenHash`), mail ticket and expiry;
   * `resent` says which. One statement, so two requests for one address leave one pending invitation.
   */
  writePending(invitation: NewInvitation): Promise<{ readonly invitation: InvitationRecord; readonly resent: boolean }>;
  /** The language of the account that holds the address of the pending invitation; undefined when none does. */
  inviteeLocale(invitationId: string): Promise<string | undefined>;
}

/** A pending invitation of the list: the invitation and whether its expiry has passed, by the database's clock when it was read. */
export interface InvitationListing extends InvitationRecord {
  readonly expired: boolean;
}

/** What a resend or a link replaces on a pending invitation. */
export interface InvitationRenewal {
  /** SHA-256 of the new token: of one nobody holds yet for a resend, of the one a link returns. */
  readonly tokenHash: Buffer;
  /** The ticket of the mail job queued for a resend; null for a link, which leaves no earlier job to issue a token. */
  readonly mailTicket: string | null;
  /** How long the invitation can be accepted for from now, counted by the database's clock. */
  readonly ttlSeconds: number;
}

export type InvitationRevocation =
  /** The invitation was pending and is revoked now. */
  | { readonly kind: "revoked"; readonly invitation: InvitationRecord }
  /** The invitation was revoked before; nothing was written. */
  | { readonly kind: "already_revoked" }
  /** The workspace has no pending or revoked invitation of that identifier, an accepted one included. */
  | { readonly kind: "not_found" };

/** The stores of listing, resending, linking and revoking, bound to the transaction of the request. */
export interface InvitationManagementStore {
  /** The role of the account of the transaction in the workspace of the transaction; undefined when it is no member. */
  actorRole(): Promise<WorkspaceRole | undefined>;
  /** The pending invitation `invitationId` of the workspace of the transaction; undefined when there is none. */
  pending(invitationId: string): Promise<InvitationRecord | undefined>;
  /** Up to `limit` pending invitations of the workspace of the transaction, newest first, after the one named. */
  listPending(afterId: string | null, limit: number): Promise<readonly InvitationListing[]>;
  /**
   * Replaces the token hash, the mail ticket and the expiry of the pending invitation `invitationId` and makes the account of
   * the transaction its inviter; undefined, with nothing changed, when the workspace has no such pending invitation.
   */
  renew(invitationId: string, renewal: InvitationRenewal): Promise<InvitationRecord | undefined>;
  revoke(invitationId: string): Promise<InvitationRevocation>;
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
  /**
   * Whether the composition mails the invitation's link. Where it does not, an address with a pending invitation
   * keeps the token hash of the link already copied for it, since no mail would bring another.
   */
  readonly mailed: boolean;
  /** What the caller sent. */
  readonly email: string;
  readonly role: string;
  readonly teamIds: readonly string[];
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type InvitationOutcome =
  /** The invitation was written; `locale` is the language its email is written in and `mailTicket` the ticket its mail job carries. */
  | { readonly kind: "invited" | "resent"; readonly invitation: InvitationRecord; readonly locale: string; readonly mailTicket: string }
  /** The account that asks is not an admin or owner of the workspace; nothing was written. */
  | { readonly kind: "forbidden" }
  /** The role is not one an invitation can grant; nothing was written. */
  | { readonly kind: "invalid_role" }
  /** The request names an identifier that is no team of the workspace; nothing was written. */
  | { readonly kind: "unknown_team" }
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
  const actorRole = await store.actorRole();
  if (actorRole !== "owner" && actorRole !== "admin") {
    return { kind: "forbidden" };
  }
  const teamIds = [...new Set(ask.teamIds.map((teamId) => teamId.toLowerCase()))];
  if (teamIds.length > 0 && !(await store.teamsExist(teamIds))) {
    return { kind: "unknown_team" };
  }
  const email = normalizeEmail(ask.email);
  if (await store.memberHoldsEmail(email)) {
    return { kind: "already_member" };
  }
  const mailTicket = newId();
  const { invitation, resent } = await store.writePending({
    id: newId(),
    email,
    role: ask.role,
    teamIds,
    tokenHash: generateCredentialToken().hash,
    keepTokenHash: !ask.mailed,
    mailTicket,
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
  return { kind: resent ? "resent" : "invited", invitation, locale, mailTicket };
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
  /** `owner` only for the invitation an instance admin issued (doc 02 section 11.1). */
  readonly role: WorkspaceRole;
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

/** The path of the page that accepts an invitation, on the deployment's origin. */
const INVITE_PATH = "/invite/";

/** The link that carries `token` to the invitation page of the deployment at `origin`. */
export function invitationLink(origin: string, token: string): string {
  return `${new URL(origin).origin}${INVITE_PATH}${token}`;
}

export interface InvitationActionDependencies {
  readonly store: InvitationManagementStore;
  /** Bound to the same transaction as the store. */
  readonly audit: AuditWriter;
  /** A fresh UUIDv7, the ticket of the mail job a resend queues. */
  readonly newId: () => string;
  /** How long an invitation can be accepted for from a resend or a link. */
  readonly ttlSeconds: number;
}

export interface InvitationActionAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /** The language of the account that asks: the email of a resend is written in it when the invitee's is not known. */
  readonly actorLocale: string;
  readonly invitationId: string;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export type InvitationListOutcome =
  | { readonly kind: "listed"; readonly invitations: readonly InvitationListing[] }
  /** The account that asks is not an admin or owner of the workspace; nothing was read. */
  | { readonly kind: "forbidden" };

export type InvitationResendOutcome =
  /** The invitation has a new expiry and a token nobody holds; `locale` is the language its email is written in and `mailTicket` the ticket its mail job carries. */
  | { readonly kind: "resent"; readonly invitation: InvitationRecord; readonly locale: string; readonly mailTicket: string }
  | { readonly kind: "forbidden" }
  /** The workspace has no pending invitation of that identifier; nothing was written. */
  | { readonly kind: "not_found" };

export type InvitationLinkOutcome =
  /** The invitation has a new expiry and the token whose value is `token`, which no stored row holds. */
  | { readonly kind: "linked"; readonly invitation: InvitationRecord; readonly token: string }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" };

export type InvitationRevokeOutcome =
  | { readonly kind: "revoked" | "already_revoked" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" };

async function mayManage(store: Pick<InvitationManagementStore, "actorRole">): Promise<boolean> {
  const role = await store.actorRole();
  return role === "owner" || role === "admin";
}

/** The pending invitations of the workspace, for an admin or an owner. */
export async function listInvitations({ store }: Pick<InvitationActionDependencies, "store">, ask: { readonly afterId: string | null; readonly limit: number }): Promise<InvitationListOutcome> {
  if (!(await mayManage(store))) {
    return { kind: "forbidden" };
  }
  return { kind: "listed", invitations: await store.listPending(ask.afterId, ask.limit) };
}

/**
 * Gives the pending invitation a new expiry and a token hash nobody holds the token of, which ends the earlier
 * link, and records `invitation.resent`, in the transaction the stores are bound to. The caller queues the job
 * that mails the new link.
 */
export async function resendInvitation({ store, audit, newId, ttlSeconds }: InvitationActionDependencies, ask: InvitationActionAsk): Promise<InvitationResendOutcome> {
  if (!(await mayManage(store))) {
    return { kind: "forbidden" };
  }
  const mailTicket = newId();
  const invitation = await store.renew(ask.invitationId, { tokenHash: generateCredentialToken().hash, mailTicket, ttlSeconds });
  if (invitation === undefined) {
    return { kind: "not_found" };
  }
  await audit.write({
    action: "invitation.resent",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "invitation", id: invitation.id },
    metadata: { role: invitation.role },
    ipPrefix: ask.ipPrefix,
  });
  const locale = (await store.inviteeLocale(invitation.id)) ?? ask.actorLocale;
  return { kind: "resent", invitation, locale, mailTicket };
}

/**
 * Gives the pending invitation a new expiry and a new token, stores only the token's hash, which ends the
 * earlier link and any mail job queued before it, and records `invitation.link_created`. The token's value is
 * in the outcome and nowhere else.
 */
export async function createInvitationLink({ store, audit, ttlSeconds }: Omit<InvitationActionDependencies, "newId">, ask: InvitationActionAsk): Promise<InvitationLinkOutcome> {
  if (!(await mayManage(store))) {
    return { kind: "forbidden" };
  }
  const token = generateCredentialToken();
  const invitation = await store.renew(ask.invitationId, { tokenHash: token.hash, mailTicket: null, ttlSeconds });
  if (invitation === undefined) {
    return { kind: "not_found" };
  }
  await audit.write({
    action: "invitation.link_created",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "invitation", id: invitation.id },
    metadata: { role: invitation.role },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "linked", invitation, token: token.value };
}

/** Revokes the pending invitation and records `invitation.revoked`; a revoked one is answered the same way and writes nothing. */
export async function revokeInvitation({ store, audit }: Pick<InvitationActionDependencies, "store" | "audit">, ask: InvitationActionAsk): Promise<InvitationRevokeOutcome> {
  if (!(await mayManage(store))) {
    return { kind: "forbidden" };
  }
  const outcome = await store.revoke(ask.invitationId);
  if (outcome.kind !== "revoked") {
    return { kind: outcome.kind };
  }
  await audit.write({
    action: "invitation.revoked",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "invitation", id: outcome.invitation.id },
    metadata: { role: outcome.invitation.role },
    ipPrefix: ask.ipPrefix,
  });
  return { kind: "revoked" };
}
