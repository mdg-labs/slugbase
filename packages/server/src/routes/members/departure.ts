import type { MembershipEndedSchema } from "@slugbase/contracts";
import { createAuditWriter, endMembership, type AuditActor, type MemberContentChoice, type MembershipEndStore } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, isLastOwnerViolation, memberRepository } from "@slugbase/db";
import type { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { ChainContext } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";

// Ending a membership for DELETE /api/v1/members/{accountId} and POST /api/v1/workspace/leave (doc 04
// sections 10.4 and 10.5, doc 02 section 3.6, doc 10 T1 and T2). Both act in the workspace the request is
// bound to and the session's own account is the one that asks; they differ in the member whose membership
// ends. The roles are judged by the member service under the lock of the workspace's row, the membership
// is deleted, `member.left` is queued and the audit event is written in one transaction, and the database
// refuses the commit of a transaction that leaves the workspace without an owner, which is answered 409
// `last_owner` with nothing written (the membership, the event job, the audit event and the tokens bound
// to the membership all stay). Access ends with the commit: the member's sessions are re-derived to another
// workspace by the tenant stage on their next request, and the tokens are gone with the membership.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "No such resource.";
const NO_SUCH_MEMBER = "There is no such member.";
const NOT_ALLOWED = "Your role does not allow this change.";
const LAST_OWNER = "A workspace always has an owner; make another member an owner first.";
const NO_SUCH_RECIPIENT = "There is no such member to receive the content.";
const INVALID_RECIPIENT = "The content cannot go to the member who is leaving.";

export interface MembershipEndRequest {
  readonly targetAccountId: string;
  readonly content: MemberContentChoice;
  readonly transferTo: string | undefined;
}

/** Ends the membership and answers the body of the `200`; every refusal is a `ProblemError`. */
export async function endMembershipOf(context: ChainContext, request: MembershipEndRequest): Promise<z.input<typeof MembershipEndedSchema>> {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
  let outcome;
  try {
    outcome = await tenant.withTenant(async (tx) => {
      const profile = await accountProfileRepository(tx).profile();
      if (profile === undefined) {
        return { kind: "not_found" } as const;
      }
      const repository = memberRepository(tx);
      const store: MembershipEndStore = {
        roles: (targetAccountId) => repository.roles(targetAccountId),
        setRole: (targetAccountId, role) => repository.setRole(targetAccountId, role),
        longestStandingOwner: (excludingAccountId) => repository.longestStandingOwner(excludingAccountId),
        end: ({ accountId, events }) => repository.remove(accountId, events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload))),
      };
      const actor: AuditActor = { type: "account", accountId: principal.accountId, label: profile.displayName };
      return endMembership(
        { store, audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }), newId: uuidv7 },
        {
          workspaceId: tenant.workspaceId,
          actor,
          actorAccountId: principal.accountId,
          targetAccountId: request.targetAccountId,
          content: request.content,
          ...(request.transferTo === undefined ? {} : { transferTo: request.transferTo }),
          ipPrefix,
        },
      );
    });
  } catch (error) {
    if (isLastOwnerViolation(error)) {
      throw new ProblemError("last_owner", LAST_OWNER);
    }
    throw error;
  }
  switch (outcome.kind) {
    case "ended":
      return { content: outcome.content, transferTo: outcome.transferTo };
    case "forbidden":
      throw new ProblemError("forbidden", NOT_ALLOWED);
    case "not_found":
      throw new ProblemError("not_found", NO_SUCH_MEMBER);
    case "last_owner":
      throw new ProblemError("last_owner", LAST_OWNER);
    case "recipient_not_found":
      throw new ProblemError("not_found", NO_SUCH_RECIPIENT, { errors: [{ path: "transferTo", code: "not_found" }] });
    case "invalid_recipient":
      throw new ProblemError("validation_failed", INVALID_RECIPIENT, { errors: [{ path: "transferTo", code: "invalid_recipient" }] });
  }
}
