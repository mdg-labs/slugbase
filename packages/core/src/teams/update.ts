import type { AuditActor, AuditWriter } from "../audit/index.ts";
import { normalizeTeamDescription, normalizeTeamName, type TeamChanges, type TeamInvalid, type TeamStore, type TeamUpdateResult } from "./store.ts";

// Changing a team (doc 02 section 4, doc 04 sections 2.4 and 10.5, doc 10 T11). The service validates everything the caller sent before anything
// is written, then asks the store to apply it: the store finds the team by identifier in the workspace, locks it, compares its version with the
// `If-Match` the caller sent and writes what differs. A change records `team.updated` with the old and the new name, in the transaction the
// stores are bound to; a patch that changes nothing records nothing.

/** The fields of a JSON Merge Patch of a team (doc 04 section 2.4): a field left out is left as it is. */
export interface TeamPatch {
  readonly name?: string;
  readonly description?: string;
}

export interface TeamUpdateDependencies {
  readonly store: Pick<TeamStore, "update">;
  readonly audit: AuditWriter;
}

export interface TeamUpdateAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  readonly teamId: string;
  readonly patch: TeamPatch;
  readonly expectedVersions: readonly number[] | undefined;
}

export type TeamUpdateOutcome = TeamUpdateResult | TeamInvalid;

export async function updateTeam({ store, audit }: TeamUpdateDependencies, ask: TeamUpdateAsk): Promise<TeamUpdateOutcome> {
  const { patch } = ask;
  const changes: { name?: string; description?: string } = {};
  if (patch.name !== undefined) {
    const name = normalizeTeamName(patch.name);
    if ("refusal" in name) {
      return { kind: "invalid", field: "name", reason: name.refusal };
    }
    changes.name = name.name;
  }
  if (patch.description !== undefined) {
    const description = normalizeTeamDescription(patch.description);
    if ("refusal" in description) {
      return { kind: "invalid", field: "description", reason: description.refusal };
    }
    changes.description = description.description;
  }
  const teamChanges: TeamChanges = changes;
  const result = await store.update({ teamId: ask.teamId, changes: teamChanges, expectedVersions: ask.expectedVersions });
  if (result.kind === "updated") {
    await audit.write({
      action: "team.updated",
      workspaceId: ask.workspaceId,
      actor: ask.actor,
      entity: { type: "team", id: result.team.id },
      metadata: { from: result.previousName, to: result.team.name },
      ipPrefix: ask.ipPrefix,
    });
  }
  return result;
}
