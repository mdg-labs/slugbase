import type { AuditActor, AuditWriter } from "../audit/index.ts";
import type { TeamStore } from "./store.ts";

// Deleting a team (doc 02 section 4, doc 04 sections 2.4 and 10.5). A delete is hard: the team goes with its memberships, and the store keeps
// no tombstone, so a delete of a team that is gone or belongs to another workspace is the same `false`. The deletion and `team.deleted` are one
// transaction.

export interface TeamDeletionDependencies {
  readonly store: Pick<TeamStore, "remove">;
  readonly audit: AuditWriter;
}

export interface TeamDeletionAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  readonly teamId: string;
}

/** True when the team was deleted; false when the workspace has no such team. */
export async function deleteTeam({ store, audit }: TeamDeletionDependencies, ask: TeamDeletionAsk): Promise<boolean> {
  const name = await store.remove(ask.teamId);
  if (name === undefined) {
    return false;
  }
  await audit.write({
    action: "team.deleted",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "team", id: ask.teamId },
    metadata: { name },
    ipPrefix: ask.ipPrefix,
  });
  return true;
}
