import { createInvitation, type InvitationSchema } from "@slugbase/contracts";
import { INVITATION_TTL_SECONDS, createAuditWriter, inviteMember, type AuditActor, type InvitationRecord, type MailPort } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, invitationRepository } from "@slugbase/db";
import type { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueInvitationMail } from "../../worker/jobs/invitation-mail.ts";
import { route } from "../register.ts";

// POST /api/v1/invitations (doc 04 section 10.5, doc 02 section 3.4, doc 10 T1, T4 and T19). It acts in the workspace
// the request is bound to and names no other: the authorization stage lets an admin or owner of it through, and
// the invitation service judges the role again under the same transaction. The invitation, its audit event and
// the job that mails its link are one transaction, so a refusal at the commit leaves none of them. The response
// is the invitation and never its token: the token is made by the job that sends the email, which also ends
// the link of an earlier send. A deployment that cannot send mail queues no job and still has the invitation.
// The operation declares `members.invite`; the authorization stage refuses it while no entitlement source of
// the composition holds that entitlement, and declares no token scope, so an API token never reaches it.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "No such resource.";
const NOT_ALLOWED = "Your role does not allow this.";
const ALREADY_MEMBER = "This address already belongs to a member of the workspace.";
const TEAMS_UNAVAILABLE = "Teams cannot be invited into yet.";
const INVALID_ROLE = "An invitation can grant the admin or the member role.";

export interface InvitationRoutesOptions {
  /** The mail port: the invitation email is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
  /** How long an invitation can be accepted for; seven days unless the composition says otherwise. */
  readonly ttlSeconds?: number;
}

/** The invitation as the contract's `Invitation` schema has it. */
export function invitationBody(invitation: InvitationRecord): z.input<typeof InvitationSchema> {
  const { id, email, role, teamIds, status, invitedBy, expiresAt, createdAt } = invitation;
  return { id, email, role, teamIds: [...teamIds], status, invitedBy, expiresAt: expiresAt.toISOString(), createdAt: createdAt.toISOString() };
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

export function invitationRoutes({ mail, ttlSeconds = INVITATION_TTL_SECONDS }: InvitationRoutesOptions): RouteBinding[] {
  return [
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
            email: body.email,
            role: body.role,
            teamIds: body.teamIds ?? [],
            ipPrefix,
          },
        );
        if ((result.kind === "invited" || result.kind === "resent") && mail.available) {
          await repository.enqueue([queueInvitationMail(uuidv7(), { invitationId: result.invitation.id, workspaceId: tenant.workspaceId, accountId, locale: result.locale })]);
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
  ];
}
