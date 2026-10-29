import type { TeamDetail, TeamListRequest, TeamRecord, TeamStore } from "./store.ts";

// Reading the teams (doc 02 section 4, doc 04 section 10.5). Every member reads every team of the workspace with its members, which the share
// picker needs; the store names the workspace in each statement, so a team of another workspace is a team it does not find, and the caller
// must not tell that from one that does not exist.

export interface TeamReadDependencies<Method extends "list" | "find"> {
  readonly store: Pick<TeamStore, Method>;
}

/** One page of the teams of the workspace, at most `request.limit`. */
export function listTeams({ store }: TeamReadDependencies<"list">, request: TeamListRequest): Promise<readonly TeamRecord[]> {
  return store.list(request);
}

/** The team with its members, or undefined when the workspace has no such team. */
export function readTeam({ store }: TeamReadDependencies<"find">, ask: { readonly teamId: string }): Promise<TeamDetail | undefined> {
  return store.find(ask.teamId);
}
