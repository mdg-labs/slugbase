import { provisionPersonalWorkspace, type PersonalWorkspaceStore } from "@slugbase/core";
import type { PersonalWorkspaceWriter } from "@slugbase/db";
import { queueDomainEvent } from "../events/publish.ts";
import { uuidv7 } from "./uuidv7.ts";

// The personal workspace of a registered account (doc 02 section 2.2): the core service run against the
// writer of the transaction that verifies the address, or that registers the account on a deployment that
// does not require verification. The `workspace.created` event is queued and its audit event written in that same transaction.

function storeOf(writer: PersonalWorkspaceWriter): PersonalWorkspaceStore {
  return {
    async create({ events, ...request }) {
      const outcome = await writer.create({ ...request, jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)) });
      return outcome === "unavailable" ? undefined : outcome;
    },
  };
}

/** Gives the account its personal workspace unless it owns one, in the open transaction `writer` is bound to; rejects, so the transaction does not commit, when it cannot. */
export async function provisionWorkspaceIn(accountId: string, writer: PersonalWorkspaceWriter): Promise<void> {
  await provisionPersonalWorkspace({ store: storeOf(writer), newId: uuidv7 }, accountId);
}
