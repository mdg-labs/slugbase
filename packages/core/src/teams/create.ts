import type { AuditActor, AuditWriter } from "../audit/index.ts";
import { normalizeTeamDescription, normalizeTeamName, type TeamDetail, type TeamInvalid, type TeamStore } from "./store.ts";

// Creating a team (doc 02 section 4, doc 04 section 10.5, doc 10 T11). The service validates the name and the description before anything is
// written, creates the team with no members and records `team.created` in the transaction the stores are bound to, so the event exists exactly
// when the team does.

export interface TeamCreationDependencies {
  readonly store: Pick<TeamStore, "create">;
  readonly audit: AuditWriter;
  /** Generates the identifier of a new team: a UUIDv7. */
  readonly newId: () => string;
}

export interface TeamCreationAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  readonly name: string;
  /** Left out: empty. */
  readonly description: string | undefined;
}

export type TeamCreationOutcome = { readonly kind: "created"; readonly team: TeamDetail } | TeamInvalid | { readonly kind: "name_taken" };

export async function createTeam({ store, audit, newId }: TeamCreationDependencies, ask: TeamCreationAsk): Promise<TeamCreationOutcome> {
  const name = normalizeTeamName(ask.name);
  if ("refusal" in name) {
    return { kind: "invalid", field: "name", reason: name.refusal };
  }
  const description = normalizeTeamDescription(ask.description ?? "");
  if ("refusal" in description) {
    return { kind: "invalid", field: "description", reason: description.refusal };
  }
  const result = await store.create({ id: newId(), name: name.name, description: description.description });
  if (result.kind === "name_taken") {
    return result;
  }
  await audit.write({
    action: "team.created",
    workspaceId: ask.workspaceId,
    actor: ask.actor,
    entity: { type: "team", id: result.team.id },
    metadata: { name: result.team.name },
    ipPrefix: ask.ipPrefix,
  });
  return result;
}
