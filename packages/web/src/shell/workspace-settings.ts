import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";
import { WORKSPACE_QUERY_KEY } from "./workspace.ts";

export type WorkspaceSettings = ComponentTypes["schemas"]["WorkspaceSettings"];
export type WorkspaceSettingsChanges = ComponentTypes["schemas"]["UpdateWorkspaceSettingsRequest"];

/** The key carries the workspace the settings belong to; callers take it from the account's active workspace, which follows a switch once the account confirms it. */
export function workspaceSettingsKey(workspaceId: string) {
  return [...WORKSPACE_QUERY_KEY, "settings", workspaceId] as const;
}

/** The typed settings of the workspace the session acts in (doc 04 section 10.4). Only an admin or an owner may ask. */
export function workspaceSettingsQuery(api: ApiClient, workspaceId: string) {
  return queryOptions({
    queryKey: workspaceSettingsKey(workspaceId),
    queryFn: async ({ signal }): Promise<WorkspaceSettings> => {
      const { data, error } = await api.GET("/api/v1/workspace/settings", { signal });
      if (data === undefined) {
        throw new Error("The workspace settings request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/** Changes the settings given and answers the settings after the change; a setting left out keeps its value. */
export async function updateWorkspaceSettings(api: ApiClient, changes: WorkspaceSettingsChanges): Promise<WorkspaceSettings> {
  const { data, error } = await api.PATCH("/api/v1/workspace/settings", { body: changes });
  if (data === undefined) {
    throw new Error("The workspace settings update did not answer with a document", { cause: error });
  }
  return data;
}
