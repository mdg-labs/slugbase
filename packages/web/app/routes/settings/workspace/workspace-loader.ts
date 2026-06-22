import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { getSessionUser } from "../../../lib/session-client.js";
import { loadWorkspaceInterfaceConfig } from "./workspace-config.js";
import { loadAiSettings, loadWorkspaceSettingsContext } from "./workspace-api.js";
import type { WorkspaceSettingsData } from "./workspace.types.js";

export async function workspaceSettingsLoader({
  request,
}: LoaderFunctionArgs): Promise<WorkspaceSettingsData> {
  const user = await getSessionUser(request);
  if (!user) {
    return redirect("/login") as never;
  }

  const context = await loadWorkspaceSettingsContext(request, user.id);
  if (!context) {
    throw new Error("Failed to load workspace settings");
  }

  const interfaceConfig = await loadWorkspaceInterfaceConfig();
  const ai = await loadAiSettings(request);

  return {
    workspace: context.workspace,
    currentUserRole: context.currentUserRole,
    membersForbidden: context.membersForbidden,
    interfaceConfig,
    ai,
  };
}
