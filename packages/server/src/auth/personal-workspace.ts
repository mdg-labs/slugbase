import { provisionPersonalWorkspace, type EntitlementLimit, type PersonalWorkspaceStore } from "@slugbase/core";
import type { PersonalWorkspaceWriter } from "@slugbase/db";
import { queueDomainEvent } from "../events/publish.ts";
import { uuidv7 } from "./uuidv7.ts";

// The personal workspace of a registered account (doc 02 section 2.2): the core service run against the
// writer of the transaction that verifies the address, or that registers the account on a deployment that
// does not require verification. The `workspace.created` event is queued and its audit event written in that same transaction.
// The ceiling `workspaces.ownMax` (doc 01 section 7.5) is the account's value from the entitlement source; an account at it gets
// no workspace and no error, so the registration or the verification that asked still succeeds (doc 02 section 2.2, doc 10 T11).

function storeOf(writer: PersonalWorkspaceWriter): PersonalWorkspaceStore {
  return {
    async create({ events, ownedMax, ...request }) {
      const outcome = await writer.create({ ...request, ownedMax: ownedMax === "unlimited" ? null : ownedMax, jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)) });
      return outcome === "unavailable" ? undefined : outcome;
    },
  };
}

/** The `workspaces.ownMax` of an account, asked of the entitlement source; a source that fails rejects. */
export type OwnedWorkspaceLimit = (accountId: string) => Promise<EntitlementLimit>;

/**
 * Gives the account its personal workspace unless it owns one or is at `ownedMax`, in the open transaction `writer` is
 * bound to; rejects, so the transaction does not commit, when the account cannot be given one for another reason.
 */
export async function provisionWorkspaceIn(accountId: string, writer: PersonalWorkspaceWriter, ownedMax: EntitlementLimit): Promise<void> {
  await provisionPersonalWorkspace({ store: storeOf(writer), newId: uuidv7 }, accountId, ownedMax);
}

/** The provisioning of a flow that learns the account in the transaction (the redemption of a verification link): the ceiling is read before the workspace is made, and a source that fails rejects, so the transaction does not commit. */
export function provisionWorkspaceWithLimit(ownedWorkspaceLimit: OwnedWorkspaceLimit): (accountId: string, writer: PersonalWorkspaceWriter) => Promise<void> {
  return async (accountId, writer) => provisionWorkspaceIn(accountId, writer, await ownedWorkspaceLimit(accountId));
}
