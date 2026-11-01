import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ApiProblemError, type ApiClient, type ApiProblemCode } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";
import { meQuery, type Me } from "../account/me.ts";

export type Workspace = ComponentTypes["schemas"]["Workspace"];
export type WorkspaceRole = Workspace["role"];

export const WORKSPACE_QUERY_KEY = ["workspace"] as const;

/** The workspace the session acts in, with the caller's role and the version a rename is made against. */
export function workspaceQuery(api: ApiClient) {
  return queryOptions({
    queryKey: WORKSPACE_QUERY_KEY,
    queryFn: async (): Promise<Workspace> => {
      const { data, error } = await api.GET("/api/v1/workspace");
      if (data === undefined) {
        throw new Error("The workspace request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/** What a page reads of the workspace the session acts in. */
export interface WorkspaceRead {
  readonly data: Workspace | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

/**
 * The workspace the session acts in, as pages read it. The request names no workspace and its answer is cached under
 * one key, so after a switch the cache holds the previous workspace's document until the new one arrives. A document
 * whose workspace is not the account's active one is not the page's to show or to act on (a rename sends the
 * document's version to the session's workspace), so it reads as not loaded. While the account is not known the
 * document stands as it is.
 */
export function useWorkspace(): WorkspaceRead {
  const api = useRouter().options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const { data, isPending, isError, isFetching, refetch } = useQuery(workspaceQuery(api));
  const activeId = me.data?.activeWorkspaceId;
  if (data !== undefined && typeof activeId === "string" && data.id !== activeId) {
    return { data: undefined, isPending: !isError, isError, isFetching, refetch };
  }
  return { data, isPending, isError, isFetching, refetch };
}

/** Renames the workspace if it is still at `version`; a workspace at another version answers `412` and keeps its name. */
export async function renameWorkspace(api: ApiClient, name: string, version: number): Promise<Workspace> {
  const { data, error } = await api.PATCH("/api/v1/workspace", {
    params: { header: { "If-Match": `"${String(version)}"` } },
    body: { name },
  });
  if (data === undefined) {
    throw new Error("The workspace rename did not answer with a document", { cause: error });
  }
  return data;
}

/** The account's role in the workspace its session acts in, as the cached account has it; undefined while the account or the workspace is unknown. */
export function activeRole(me: Me | undefined): WorkspaceRole | undefined {
  return me?.memberships.find(({ workspaceId }) => workspaceId === me.activeWorkspaceId)?.role;
}

/** Whether the role may change the workspace: an admin or an owner. */
export function canAdminister(role: WorkspaceRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Why the deletion of the workspace was refused, as far as the owner is told. A guard refusal carries the code the deployment's deletion guard answered with (doc 01 section 13.2). */
export type DeletionRefusal =
  | { readonly kind: "reauthRequired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "gone" }
  | { readonly kind: "guard"; readonly code: ApiProblemCode };

export type WorkspaceDeletion = { readonly status: "accepted" } | { readonly status: "refused"; readonly refusal: DeletionRefusal };

/**
 * Asks for the workspace the session acts in to be deleted (doc 04 section 4.4). The call needs a fresh re-authentication; the API
 * client opens the shared prompt for it and sends the call again. A refusal the dialog explains (the prompt was closed, the caller
 * is no longer an owner, the workspace is gone, the deletion guard refuses) is an answer; any other failure throws.
 */
export async function deleteWorkspace(api: ApiClient): Promise<WorkspaceDeletion> {
  try {
    const { response, error } = await api.DELETE("/api/v1/workspace");
    if (!response.ok) {
      throw new Error("The workspace deletion did not answer with a problem document", { cause: error });
    }
    return { status: "accepted" };
  } catch (caught) {
    if (isReauthCancelled(caught)) {
      return { status: "refused", refusal: { kind: "reauthRequired" } };
    }
    if (caught instanceof ApiProblemError) {
      if (caught.status === 401 && caught.code === "reauth_required") {
        return { status: "refused", refusal: { kind: "reauthRequired" } };
      }
      if (caught.status === 403) {
        return { status: "refused", refusal: { kind: "forbidden" } };
      }
      if (caught.status === 404) {
        return { status: "refused", refusal: { kind: "gone" } };
      }
      if (caught.status === 409) {
        return { status: "refused", refusal: { kind: "guard", code: caught.code } };
      }
    }
    throw caught;
  }
}
