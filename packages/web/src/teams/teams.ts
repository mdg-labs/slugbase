import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";

export { TEAM_DESCRIPTION_MAX_LENGTH, TEAM_NAME_MAX_LENGTH } from "@slugbase/contracts";

export type Team = ComponentTypes["schemas"]["Team"];
export type TeamWithMembers = ComponentTypes["schemas"]["TeamWithMembers"];
export type TeamMember = ComponentTypes["schemas"]["TeamMember"];

export const TEAMS_QUERY_KEY = ["teams"] as const;

const PAGE_SIZE = 50;

/** The workspace's teams by name, a page at a time. Every member may read them. */
export function teamListQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: [...TEAMS_QUERY_KEY, "list"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await api.GET("/api/v1/teams", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The teams request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}

async function readTeam(api: ApiClient, id: string, signal?: AbortSignal): Promise<TeamWithMembers> {
  const { data, error } = await api.GET("/api/v1/teams/{id}", { params: { path: { id } }, ...(signal === undefined ? {} : { signal }) });
  if (data === undefined) {
    throw new Error("The team request did not answer with a document", { cause: error });
  }
  return data;
}

/** One team with its members: the list holds only their count, so the avatars of a row come from here. */
export function teamQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: [...TEAMS_QUERY_KEY, "detail", id],
    queryFn: ({ signal }) => readTeam(api, id, signal),
  });
}

/**
 * The team an edit starts from. It is read when the edit opens and kept no longer than the edit is open, so the form never
 * starts from a copy that the list kept earlier, and it is not read again behind the form while the form is open.
 */
export function teamForEditQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: [...TEAMS_QUERY_KEY, "edit", id],
    queryFn: ({ signal }) => readTeam(api, id, signal),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** What the form holds: the fields of a team and the accounts that are its members. */
export interface TeamDraft {
  readonly name: string;
  readonly description: string;
  readonly memberIds: readonly string[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/**
 * Brings the team to the draft: creates it when there is none, changes the name and description if they differ, and replaces the
 * members if they differ. These are separate requests, so `applied` is called with the team after each one that went through; a
 * caller that keeps the latest one sends only what remains when it tries again. A step that fails throws and the steps after it
 * are not sent.
 */
export async function saveTeam(
  api: ApiClient,
  base: TeamWithMembers | undefined,
  draft: TeamDraft,
  applied: (team: TeamWithMembers) => void,
): Promise<TeamWithMembers> {
  let current = base;
  if (current === undefined) {
    const { data, error } = await api.POST("/api/v1/teams", { body: { name: draft.name, description: draft.description } });
    if (data === undefined) {
      throw new Error("The team creation did not answer with a document", { cause: error });
    }
    current = data;
    applied(current);
  } else if (current.name !== draft.name || current.description !== draft.description) {
    const { data, error } = await api.PATCH("/api/v1/teams/{id}", {
      params: { path: { id: current.id }, header: { "If-Match": `"${String(current.version)}"` } },
      body: { name: draft.name, description: draft.description },
    });
    if (data === undefined) {
      throw new Error("The team update did not answer with a document", { cause: error });
    }
    current = data;
    applied(current);
  }
  if (!sameSet(
    current.members.map(({ accountId }) => accountId),
    draft.memberIds,
  )) {
    const { data, error } = await api.PUT("/api/v1/teams/{id}/members", {
      params: { path: { id: current.id } },
      body: { accountIds: [...new Set(draft.memberIds)] },
    });
    if (data === undefined) {
      throw new Error("The team members did not answer with a document", { cause: error });
    }
    current = data;
    applied(current);
  }
  return current;
}

/**
 * Brings the teams of one member to `wanted`, given the teams `current` that the member is in as far as the caller knows. Each team
 * that changes is read again first, with its members, and then replaced through `PUT /teams/{id}/members` with that set plus or
 * minus the member, so what other people put into the team since the page was read is kept. The requests are sent one after the
 * other, the teams to leave before the teams to join, and `applied` is called with the member's teams after each one that went
 * through; a caller that keeps the latest set sends only what remains when it tries again. A step that fails throws and the steps
 * after it are not sent. A team to leave that is gone already is left; a team to join that is gone is a `404`.
 */
export async function saveMemberTeams(
  api: ApiClient,
  accountId: string,
  current: readonly string[],
  wanted: readonly string[],
  applied: (teamIds: readonly string[]) => void,
): Promise<readonly string[]> {
  let held = [...current];
  const leaving = current.filter((id) => !wanted.includes(id));
  const joining = wanted.filter((id) => !current.includes(id));
  for (const id of [...leaving, ...joining]) {
    const joins = joining.includes(id);
    let team: TeamWithMembers;
    try {
      team = await readTeam(api, id);
    } catch (caught) {
      if (!joins && caught instanceof ApiProblemError && caught.status === 404) {
        held = held.filter((candidate) => candidate !== id);
        applied(held);
        continue;
      }
      throw caught;
    }
    const memberIds = team.members.map((member) => member.accountId);
    if (memberIds.includes(accountId) === joins) {
      // The team already holds the member as wanted: another admin made the change first.
      held = joins ? [...held, id] : held.filter((candidate) => candidate !== id);
      applied(held);
      continue;
    }
    const { data, error } = await api.PUT("/api/v1/teams/{id}/members", {
      params: { path: { id } },
      body: { accountIds: joins ? [...memberIds, accountId] : memberIds.filter((candidate) => candidate !== accountId) },
    });
    if (data === undefined) {
      throw new Error("The team members did not answer with a document", { cause: error });
    }
    held = joins ? [...held, id] : held.filter((candidate) => candidate !== id);
    applied(held);
  }
  return held;
}

/** Deletes the team with its memberships; the members stay members of the workspace. */
export async function deleteTeam(api: ApiClient, id: string): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/teams/{id}", { params: { path: { id } } });
  if (!response.ok) {
    throw new Error("The team deletion did not answer with a problem document", { cause: error });
  }
}

/** Why a save or a delete did not go through, as far as the member is told. */
export type TeamFailure =
  | { readonly kind: "nameTaken" | "invalidName" | "memberGone" | "changedElsewhere" | "notFound" | "unavailable" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function teamFailureOf(error: unknown): TeamFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    switch (error.status) {
      case 429:
        return { kind: "rateLimited", seconds: error.retryAfterSeconds };
      case 409:
        return { kind: "nameTaken" };
      case 412:
        return { kind: "changedElsewhere" };
      case 404:
        return { kind: "notFound" };
      case 422:
        return error.errors.some(({ path }) => path.startsWith("accountIds")) ? { kind: "memberGone" } : { kind: "invalidName" };
    }
  }
  return { kind: "unavailable" };
}
