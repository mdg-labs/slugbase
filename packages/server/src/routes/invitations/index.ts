import {
  acceptInvitation,
  createInvitation,
  createInvitationLink,
  inspectInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  type InvitationListItemSchema,
  type InvitationSchema,
} from "@slugbase/contracts";
import {
  INVITATION_TTL_SECONDS,
  acceptInvitation as acceptPending,
  acceptInvitationWithAccount,
  createAuditWriter,
  createInvitationLink as makeInvitationLink,
  hashCredentialToken,
  inspectInvitation as inspectPending,
  invitationLink,
  inviteMember,
  listInvitations as listPending,
  resendInvitation as resendPending,
  revokeInvitation as revokePending,
  type AuditActor,
  type InvitationActionAsk,
  type InvitationListing,
  type InvitationRecord,
  type EntitlementCheck,
  type EntitlementUpgradeCheck,
  type InvitationSignupEvent,
  type MailPort,
  type PasswordPolicy,
  type SessionCookieSpec,
  normalizeEmail,
  registrationLocale,
  truncateUserAgent,
} from "@slugbase/core";
import {
  accountProfileRepository,
  auditEventRepository,
  invitationAcceptanceRepository,
  invitationRepository,
  workspaceRepository,
  type AuthStore,
  type Database,
  type TenantTx,
} from "@slugbase/db";
import { z } from "zod";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { emailLimitKey } from "../../auth/email-limit.ts";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { assertRegistrationAllowed } from "../../auth/registration-gate.ts";
import { hashSessionToken, newSessionToken } from "../../auth/session-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import { entitlementRequired } from "../../http/authorize.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueInvitationMail } from "../../worker/jobs/invitation-mail.ts";
import { route } from "../register.ts";
import { InvitationLearned, type LearnedInvitation } from "./learned.ts";

// The invitation operations of doc 04 section 10.5 ( doc 02 section 3.4, doc 10 T1, T4 and T19). It acts in the workspace
// the request is bound to and names no other: the authorization stage lets an admin or owner of it through, and
// the invitation service judges the role again under the same transaction. The invitation, its audit event and
// the job that mails its link are one transaction, so a refusal at the commit leaves none of them. The response
// is the invitation and never its token: the token is made by the job that sends the email, which also ends
// the link of an earlier send. A deployment that cannot send mail queues no job and still has the invitation;
// inviting an address that has a pending one there changes its role, teams and expiry and keeps the stored token
// hash, so the link an admin copied for it keeps working.
// The operations declare `members.invite` (revoking does not); the authorization stage refuses it while no
// entitlement source of the composition holds that entitlement, and they declare no token scope, so an API
// token never reaches them.
//
// An admin or owner also lists the pending invitations, resends one, gets the link of one and revokes one. Each
// names an invitation by identifier and acts in the workspace of the request only: the identifier of another
// workspace's invitation is answered like one that does not exist (404). A resend counts against the
// per-address limit of the `reset` bucket under the invited address, shared with the other operations of that
// bucket, and queues the job that mails the new link; for an invitation of the workspace, on a composition that
// cannot send mail it is refused with 503 before anything is written, since it would end the earlier link and
// send no other. A link makes a token
// in the request, stores its hash and returns the link once: the token is in no log, audit event or stored
// response, and another link or a resend ends it; a mail job queued before the link finds the invitation renewed and issues no token. Revoking a revoked invitation is answered 204 again. Each
// action, its audit event and, for a resend, the mail job are one transaction.
//
// The invited person redeems the token with two operations that act on no workspace of the request. The inspection
// is anonymous and answers what the invitation page shows; an unknown, malformed, used, revoked, replaced or expired
// token, and one of a workspace being deleted, is one 410 token_expired. The acceptance is anonymous in the contract
// and takes one of two forms, told by the body. With the token alone it is the signed-in account's: in an
// account-level transaction, `sys_invitation_accept` locks the workspace, the account and the invitation, checks
// that the account's verified address is the invited one and that it is no member yet, and inserts the membership
// with exactly the invited role; the `member.joined` event job, its audit event and the move of the session to the
// workspace are in the same transaction, and a failure of any rolls all of it back. The handler requires the
// session the stages would have required of an account operation, and takes the per-account limit of the bucket,
// which the rate-limit stage takes for no anonymous operation. With a display name and a password it is the
// invited person's who has no account: the registration policy is asked first with the invited address and the path
// `invitation`, then the password policy, and `sys_invitation_accept_new_account` creates the verified account of
// the invited address, its membership, the accepted invitation and a full session in one transaction with the
// `account.created` and `member.joined` events and the `member.joined` audit event; a session cookie the request
// carried is replaced. An address that has an account is 409 email_taken and nothing is written. Both forms count
// against the `token_redeem` bucket of the client address.
//
// Both forms also need the workspace of the invitation to hold `members.invite` and a free seat (doc 01 sections 7.5 and
// 13.1, doc 10 T11 and T19). The token names the workspace and the operation declares none, so the handler decides both,
// after the token has proved to be a pending invitation's (a dead token is the same 410 whatever the plan) and before
// anything is committed. Each form runs the acceptance once with no seat limit to learn the workspace and the invitation,
// which it abandons by rolling the transaction back (the refusals that need no entitlement end there: another address, a
// member already, an address that has an account). Then it asks the source whether the workspace holds `members.invite`,
// reading the workspace as it is now since the invited account is no member to read the version of the row, and asks the
// hook dispatcher for the seat limit: the workspace's `seats.max`, replaced by the seat-check hooks of the modules. A hook
// that fails or does not answer in time refuses the acceptance with 503 and nothing is written. The acceptance that
// writes is run only then, and carries the limit to `sys_invitation_accept` or `sys_invitation_accept_new_account`,
// which count the members under the workspace's lock and answer `422 seat_limit_reached` at the limit, leaving the
// invitation pending. Sending, resending and listing invitations count no seat.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "No such resource.";
const NOT_ALLOWED = "Your role does not allow this.";
const ALREADY_MEMBER = "This address already belongs to a member of the workspace.";
const TEAMS_UNAVAILABLE = "Teams cannot be invited into yet.";
const INVALID_ROLE = "An invitation can grant the admin or the member role.";
const NO_SUCH_INVITATION = "No such resource.";
const BAD_CURSOR = "The cursor is not valid.";
const TOKEN_REFUSED = "The invitation link is invalid or has expired.";
const EMAIL_MISMATCH = "This invitation is for another email address.";
const ACCEPT_ALREADY_MEMBER = "You are already a member of this workspace.";
const NO_SEAT = "The workspace has no seat left.";
const SECOND_FACTOR = "A second factor is required.";
const EMAIL_TAKEN = "An account already holds the invited email address. Sign in and accept the invitation.";
const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";
const MAIL_UNAVAILABLE = "Email delivery is not available on this instance; use the link of the invitation instead.";

export interface InvitationRoutesOptions {
  /** The mail port: the invitation email is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
  /** `APP_ORIGIN`: the link an invitation's token is returned in points to it. */
  readonly appOrigin: string;
  /** The account lookup a resend counts its per-address limit under, which folds an address as the accounts do, and the inspection of an invitation by its token. */
  readonly store: Pick<AuthStore, "emailKey" | "inspectInvitation" | "acceptInvitationWithNewAccount">;
  /** Opens the account-level transaction accepting an invitation runs in. */
  readonly withTenant: Database["withTenant"];
  /** How long an invitation can be accepted for; seven days unless the composition says otherwise. */
  readonly ttlSeconds?: number;
  /** The session cookie of an account created by accepting an invitation. */
  readonly cookie: SessionCookieSpec;
  /** The password policy every password-setting flow goes through. */
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  /** Decides `members.invite` for the workspace of an invitation, which accepting it needs. */
  readonly entitlements: EntitlementCheck;
  /** Says whether a workspace without it has a better plan to offer. */
  readonly upgradeAvailable: EntitlementUpgradeCheck;
}

const MEMBERS_INVITE = "members.invite";

/** The problem the signed-in form answers a refused acceptance with. */
function acceptanceRefusal(kind: "gone" | "email_mismatch" | "already_member" | "seat_limit_reached"): ProblemError {
  switch (kind) {
    case "gone":
      return new ProblemError("token_expired", TOKEN_REFUSED);
    case "email_mismatch":
      return new ProblemError("forbidden", EMAIL_MISMATCH, { errors: [{ path: "token", code: "invitation_email_mismatch" }] });
    case "already_member":
      return new ProblemError("already_member", ACCEPT_ALREADY_MEMBER);
    case "seat_limit_reached":
      return new ProblemError("seat_limit_reached", NO_SEAT);
  }
}

/** The invitation as the contract's `Invitation` schema has it. */
export function invitationBody(invitation: InvitationRecord): z.input<typeof InvitationSchema> {
  const { id, email, role, teamIds, status, invitedBy, expiresAt, createdAt } = invitation;
  return { id, email, role, teamIds: [...teamIds], status, invitedBy, expiresAt: expiresAt.toISOString(), createdAt: createdAt.toISOString() };
}

/** The invitation as the contract's `InvitationListItem` schema has it. */
export function invitationListItemBody(invitation: InvitationListing): z.input<typeof InvitationListItemSchema> {
  return { ...invitationBody(invitation), expired: invitation.expired };
}

function sessionOf(context: ChainContext): { readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal;
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** What an action on one invitation needs of the transaction it runs in; undefined when the account's profile is gone. */
async function actionOf(tx: TenantTx, context: ChainContext, invitationId: string) {
  const { accountId } = sessionOf(context);
  const tenant = tenantOf(context);
  const profile = await accountProfileRepository(tx).profile();
  if (profile === undefined) {
    return undefined;
  }
  const actor: AuditActor = { type: "account", accountId, label: profile.displayName };
  const ask: InvitationActionAsk = {
    workspaceId: tenant.workspaceId,
    actor,
    actorLocale: profile.locale,
    invitationId,
    ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
  };
  return { ask, accountId, repository: invitationRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) };
}

/**
 * The session that accepts with the token alone: the account and the session the workspace is made active in.
 * The operation is anonymous in the contract, so the authorization stage has not required it; this is what it
 * requires of an account operation: a session whose second factor is complete.
 */
function acceptingSessionOf(context: ChainContext): { readonly accountId: string; readonly sessionId: string } {
  const principal = context.get("principal");
  // An anonymous operation does not read the principal of an API token (doc 04 section 4.2): a token request is one with no session.
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  if (principal.mfaPending === true) {
    throw new ProblemError("mfa_required", SECOND_FACTOR);
  }
  return principal;
}

/** The job of a domain event the acceptance queues. */
function eventJob(event: InvitationSignupEvent) {
  return event.name === "account.created"
    ? queueDomainEvent(event.eventId, event.name, event.payload)
    : queueDomainEvent(event.eventId, event.name, event.payload);
}

export function invitationRoutes({
  mail,
  cursorSecret,
  appOrigin,
  store,
  withTenant,
  ttlSeconds = INVITATION_TTL_SECONDS,
  cookie,
  passwordPolicy,
  hashPassword,
  entitlements,
  upgradeAvailable,
}: InvitationRoutesOptions): RouteBinding[] {
  const cursors = createPageCursorCodec(cursorSecret, "invitations");

  // Refuses with 403 entitlement_required unless the workspace the account is joining holds `members.invite`.
  const requireInviteEntitlement = async (context: ChainContext, accountId: string, workspaceId: string): Promise<void> => {
    const subject = { accountId, workspaceId, joining: true };
    if (!(await entitlements(MEMBERS_INVITE, subject, context.req.raw))) {
      throw entitlementRequired(MEMBERS_INVITE, await upgradeAvailable(MEMBERS_INVITE, subject, context.req.raw));
    }
  };

  // The seats the workspace may hold: its `seats.max`, replaced by the seat-check hooks of the composed modules (doc 01 section 13.1). A hook that fails refuses the acceptance with 503.
  const seatLimitOf = async (context: ChainContext, input: LearnedInvitation): Promise<number | null> => {
    const hooks = context.get("hooks");
    if (hooks === undefined) {
      throw new Error("the accept route was reached without the hook dispatcher");
    }
    return hooks.acceptanceSeatLimit(input, context.req.raw);
  };

  // The form of the acceptance with registration fields. Whether the address has an account is told only after the
  // registration policy has answered for it, so a refused address learns nothing from the answer.
  const acceptWithNewAccount = async (context: ChainContext, request: { readonly token: string; readonly displayName: string; readonly password: string }) => {
    const inspected = await inspectPending({ store }, { token: request.token });
    if (inspected.kind === "gone") {
      throw new ProblemError("token_expired", TOKEN_REFUSED);
    }
    const hooks = context.get("hooks");
    if (hooks === undefined) {
      throw new Error("the accept route was reached without the hook dispatcher");
    }
    await assertRegistrationAllowed(hooks, { email: normalizeEmail(inspected.preview.email), path: "invitation" });
    const problems = passwordPolicy.check(request.password);
    if (problems.length > 0) {
      throw new ProblemError("weak_password", problems.includes("breached") ? BREACHED_DETAIL : LENGTH_DETAIL, {
        errors: problems.map((code) => ({ path: "password", code })),
      });
    }
    const token = newSessionToken();
    const header = context.req.raw.headers.get("cookie");
    const carried = header === null ? undefined : readCookie(header, cookie.name);
    // The account does not exist yet; the seat check is told the identifier it will get.
    const accountId = uuidv7();
    const ask = {
      token: request.token,
      accountId,
      displayName: request.displayName,
      passwordHash: await hashPassword(request.password),
      locale: registrationLocale(context.req.raw.headers.get("accept-language")),
      session: {
        id: uuidv7(),
        tokenHash: token.hash,
        replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
        ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
        userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      },
    };
    const acceptAs = (learn: boolean, seatLimit: number | null) =>
      acceptInvitationWithAccount(
        {
          store: {
            acceptWithNewAccount: (acceptance) =>
              store.acceptInvitationWithNewAccount({
                ...acceptance,
                onAccepted: (accepted) => {
                  if (learn) {
                    throw new InvitationLearned({ workspaceId: accepted.workspaceId, invitationId: accepted.invitationId, accountId });
                  }
                  const { audit, events } = acceptance.onAccepted(accepted);
                  return { audit, jobs: events.map(eventJob) };
                },
              }),
          },
          newId: uuidv7,
        },
        { ...ask, seatLimit },
      );
    let outcome: Awaited<ReturnType<typeof acceptAs>>;
    try {
      outcome = await acceptAs(true, null);
    } catch (error) {
      if (!(error instanceof InvitationLearned)) {
        throw error;
      }
      // The entitlement and the seat limit are known before anything is written, and the acceptance that writes carries the limit.
      await requireInviteEntitlement(context, accountId, error.learned.workspaceId);
      outcome = await acceptAs(false, await seatLimitOf(context, error.learned));
    }
    switch (outcome.kind) {
      case "accepted":
        return { status: 201, headers: { "Set-Cookie": setSessionCookie(cookie, token.value) }, body: { workspaceId: outcome.workspaceId, role: outcome.role } } as const;
      case "gone":
        throw new ProblemError("token_expired", TOKEN_REFUSED);
      case "seat_limit_reached":
        throw new ProblemError("seat_limit_reached", NO_SEAT);
      case "email_taken":
        throw new ProblemError("email_taken", EMAIL_TAKEN);
    }
  };

  return [
    route(inspectInvitation).handle(async ({ body }) => {
      const outcome = await inspectPending({ store }, { token: body.token });
      if (outcome.kind === "gone") {
        throw new ProblemError("token_expired", TOKEN_REFUSED);
      }
      return { status: 200, body: outcome.preview };
    }),

    route(acceptInvitation).handle(async ({ body }, context) => {
      if (body.displayName !== undefined && body.password !== undefined) {
        return acceptWithNewAccount(context, { token: body.token, displayName: body.displayName, password: body.password });
      }
      const { accountId, sessionId } = acceptingSessionOf(context);
      const takeAccountLimit = context.get("takeAccountLimit");
      if (takeAccountLimit === undefined) {
        throw new Error("the accept route was reached without the rate-limit stage that counts attempts per account");
      }
      await takeAccountLimit(context, accountId);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const tokenHash = hashCredentialToken(body.token);
      if (tokenHash === undefined) {
        throw new ProblemError("token_expired", TOKEN_REFUSED);
      }
      // The entitlement and the seat limit are asked about the workspace the token names, and the seat limit goes to the
      // acceptance that writes. The first transaction learns the workspace and the invitation and is always rolled back.
      const learned = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        if ((await accountProfileRepository(tx).profile()) === undefined) {
          return undefined;
        }
        const result = await invitationAcceptanceRepository(tx).accept(tokenHash, null);
        if (result.kind === "accepted") {
          throw new InvitationLearned({ workspaceId: result.workspaceId, invitationId: result.invitationId, accountId });
        }
        return result;
      }).catch((error: unknown) => {
        if (error instanceof InvitationLearned) {
          return error.learned;
        }
        throw error;
      });
      if (learned === undefined) {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      if ("kind" in learned) {
        throw acceptanceRefusal(learned.kind);
      }
      await requireInviteEntitlement(context, accountId, learned.workspaceId);
      const seatLimit = await seatLimitOf(context, learned);
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return undefined;
        }
        const repository = invitationAcceptanceRepository(tx);
        return acceptPending(
          {
            store: {
              accept: (hash, limit) => repository.accept(hash, limit),
              queueEvents: (events) => repository.enqueue(events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload))),
              activate: (session, workspaceId) => workspaceRepository(tx).setActive(session, workspaceId),
            },
            audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }),
            newId: uuidv7,
          },
          { token: body.token, actor: { type: "account", accountId, label: profile.displayName }, sessionId, seatLimit, ipPrefix },
        );
      });
      if (outcome === undefined) {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      if (outcome.kind !== "accepted") {
        throw acceptanceRefusal(outcome.kind);
      }
      return { status: 200, body: { workspaceId: outcome.workspaceId, role: outcome.role } };
    }),

    route(createInvitation).handle(async ({ body }, context) => {
      const { accountId } = sessionOf(context);
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "forbidden" } as const;
        }
        const repository = invitationRepository(tx);
        const actor: AuditActor = { type: "account", accountId, label: profile.displayName };
        const result = await inviteMember(
          { store: repository, audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }), newId: uuidv7, ttlSeconds },
          {
            workspaceId: tenant.workspaceId,
            actor,
            actorLocale: profile.locale,
            mailed: mail.available,
            email: body.email,
            role: body.role,
            teamIds: body.teamIds ?? [],
            ipPrefix,
          },
        );
        if ((result.kind === "invited" || result.kind === "resent") && mail.available) {
          await repository.enqueue([queueInvitationMail(uuidv7(), {
              invitationId: result.invitation.id,
              workspaceId: tenant.workspaceId,
              accountId,
              locale: result.locale,
              mailTicket: result.mailTicket,
            })]);
        }
        return result;
      });
      switch (outcome.kind) {
        case "invited":
        case "resent":
          return { status: 201, body: invitationBody(outcome.invitation) };
        case "forbidden":
          throw new ProblemError("forbidden", NOT_ALLOWED);
        case "already_member":
          throw new ProblemError("already_member", ALREADY_MEMBER);
        case "teams_unavailable":
          throw new ProblemError("validation_failed", TEAMS_UNAVAILABLE, { errors: [{ path: "teamIds", code: "teams_unavailable" }] });
        case "invalid_role":
          throw new ProblemError("validation_failed", INVALID_ROLE, { errors: [{ path: "role", code: "invalid_role" }] });
      }
    }),

    route(listInvitations).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      let afterId: string | null = null;
      if (query.cursor !== undefined) {
        const decoded = cursors.decode(query.cursor, tenant.workspaceId);
        if (decoded === undefined || !z.uuid().safeParse(decoded).success) {
          throw new ProblemError("bad_request", BAD_CURSOR);
        }
        afterId = decoded;
      }
      // One more than the page, to know whether another page follows.
      const outcome = await tenant.withTenant((tx) => listPending({ store: invitationRepository(tx) }, { afterId, limit: query.limit + 1 }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", NOT_ALLOWED);
      }
      const page = outcome.invitations.slice(0, query.limit);
      const last = page.at(-1);
      return {
        status: 200,
        body: {
          items: page.map(invitationListItemBody),
          nextCursor: outcome.invitations.length > query.limit && last !== undefined ? cursors.encode(last.id, tenant.workspaceId) : null,
        },
      };
    }),

    route(resendInvitation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const invitationId = params.id.toLowerCase();
      const takeEmailLimit = context.get("takeEmailLimit");
      if (takeEmailLimit === undefined) {
        throw new Error("the resend route was reached without the rate-limit stage that counts attempts per email");
      }
      // The limit counts under the invited address, which only the invitation knows, so the invitation is read before it is taken and again, locked, by the resend.
      const target = await tenant.withTenant((tx) => invitationRepository(tx).pending(invitationId));
      if (target === undefined) {
        throw new ProblemError("not_found", NO_SUCH_INVITATION);
      }
      if (!mail.available) {
        throw new ProblemError("mail_unavailable", MAIL_UNAVAILABLE);
      }
      await takeEmailLimit(context, await emailLimitKey(store, target.email));
      const outcome = await tenant.withTenant(async (tx) => {
        const action = await actionOf(tx, context, invitationId);
        if (action === undefined) {
          return { kind: "forbidden" } as const;
        }
        const result = await resendPending({ store: action.repository, audit: action.audit, newId: uuidv7, ttlSeconds }, action.ask);
        if (result.kind === "resent") {
          await action.repository.enqueue([
            queueInvitationMail(uuidv7(), {
              invitationId: result.invitation.id,
              workspaceId: tenant.workspaceId,
              accountId: action.accountId,
              locale: result.locale,
              mailTicket: result.mailTicket,
            }),
          ]);
        }
        return result;
      });
      switch (outcome.kind) {
        case "resent":
          return { status: 200, body: invitationBody(outcome.invitation) };
        case "forbidden":
          throw new ProblemError("forbidden", NOT_ALLOWED);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_INVITATION);
      }
    }),

    route(createInvitationLink).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant(async (tx) => {
        const action = await actionOf(tx, context, params.id.toLowerCase());
        if (action === undefined) {
          return { kind: "forbidden" } as const;
        }
        return makeInvitationLink({ store: action.repository, audit: action.audit, ttlSeconds }, action.ask);
      });
      switch (outcome.kind) {
        case "linked":
          return { status: 200, body: { invitation: invitationBody(outcome.invitation), link: invitationLink(appOrigin, outcome.token) } };
        case "forbidden":
          throw new ProblemError("forbidden", NOT_ALLOWED);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_INVITATION);
      }
    }),

    route(revokeInvitation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant(async (tx) => {
        const action = await actionOf(tx, context, params.id.toLowerCase());
        if (action === undefined) {
          return { kind: "forbidden" } as const;
        }
        return revokePending({ store: action.repository, audit: action.audit }, action.ask);
      });
      switch (outcome.kind) {
        case "revoked":
        case "already_revoked":
          return { status: 204 };
        case "forbidden":
          throw new ProblemError("forbidden", NOT_ALLOWED);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_INVITATION);
      }
    }),
  ];
}
