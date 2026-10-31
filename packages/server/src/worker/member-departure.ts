import type { DomainEvent } from "@slugbase/core";
import { memberRepository } from "@slugbase/db";
import type { ModuleContext, ModuleContribution } from "../create-server.ts";

// `member.left` (doc 02 section 3.6, doc 05 sections 2.4 and 7.1, doc 01 section 7.1): applies the content choice a departure recorded. Ending a membership releases
// the member's bookmarks and folders (they lose their owner and carry the identifier of the event that queued this delivery), and the event carries the choice and the
// recipient. The handler applies the choice to exactly those rows in one tenant transaction, through `sys_member_departure_apply`: `transfer` gives them to the
// recipient, and `delete` deletes them with the shares on them. Delivery is at least once: a repeated delivery finds no row of the departure and changes nothing,
// and a delivery after the recipient left the workspace leaves the content ownerless instead of handing it to a non-member. A member who joined again owns
// everything of theirs, so none of it is touched. A failure rolls the transaction back and rejects, so the event job retries and nothing is half applied.
// The log line carries counts and never a bookmark's address or a folder's name.

/** The request id of the tenant transaction of a delivery; there is no request. */
const JOB_REQUEST_ID = "event.member.left";

type DepartureContext = Pick<ModuleContext, "withTenant" | "logger">;

/** Applies the content choice of one delivery of `member.left`; rejects when the transaction does. */
export function applyDeparture(context: DepartureContext): (event: DomainEvent<"member.left">) => Promise<void> {
  return async ({ eventId, payload }) => {
    // The recipient is the account of the transaction; the operation reads no role of it, so one who has left the workspace changes nothing about the outcome.
    const applied = await context.withTenant({ accountId: payload.transferTo, workspaceId: payload.workspaceId, requestId: JOB_REQUEST_ID }, (tx) =>
      memberRepository(tx).applyDeparture({ departureId: eventId, content: payload.content, recipientId: payload.transferTo }),
    );
    context.logger.info("Departure content applied", { eventId, content: payload.content, ...applied });
  };
}

export function memberDepartureContribution(context: DepartureContext): ModuleContribution {
  return { subscribers: [{ event: "member.left", handle: applyDeparture(context) }] };
}
