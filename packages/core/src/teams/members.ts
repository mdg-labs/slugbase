import type { AuditActor, AuditWriter } from "../audit/index.ts";
import type { TeamMembersReplacement, TeamStore } from "./store.ts";

// Replacing the members of a team (doc 02 section 4, doc 04 section 10.5, doc 10 T11). The set the caller sends becomes the team's members:
// accounts not in it are removed, accounts in it are added, and one named twice counts once. Every account must be a current member of the
// workspace; the store checks that under a lock and writes nothing otherwise. The store also compares the team's version with the `If-Match`
// the caller sent under that lock, so two replacements made against one version cannot both apply. A change records `team.members_changed` with the team's name and
// nothing about the members, in the transaction the stores are bound to; a set the team has already records nothing.

export interface TeamMembersDependencies {
  readonly store: Pick<TeamStore, "replaceMembers">;
  readonly audit: AuditWriter;
}

export interface TeamMembersAsk {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  readonly teamId: string;
  readonly accountIds: readonly string[];
  readonly expectedVersions: readonly number[] | undefined;
}

export async function replaceTeamMembers({ store, audit }: TeamMembersDependencies, ask: TeamMembersAsk): Promise<TeamMembersReplacement> {
  const result = await store.replaceMembers({ teamId: ask.teamId, accountIds: ask.accountIds, expectedVersions: ask.expectedVersions });
  if (result.kind === "replaced") {
    await audit.write({
      action: "team.members_changed",
      workspaceId: ask.workspaceId,
      actor: ask.actor,
      entity: { type: "team", id: result.team.id },
      metadata: { name: result.team.name },
      ipPrefix: ask.ipPrefix,
    });
  }
  return result;
}
