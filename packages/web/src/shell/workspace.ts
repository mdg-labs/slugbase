import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";
import type { Me } from "../account/me.ts";

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
