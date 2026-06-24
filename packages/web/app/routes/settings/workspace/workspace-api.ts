import {
  apiFetch,
  parseApiErrorMessage,
  serverFetchJson,
} from "../../../lib/client-api-fetch.js";
import { listWorkspaces } from "../../../components/workspace-switcher/workspace-switcher-api.js";
import { resolveActiveWorkspaceRole } from "./workspace-entitlements.js";
import { fetchMembersWithFallback } from "../members-fetch.js";
import type { AiSettingsData, WorkspaceSummary } from "./workspace.types.js";

interface ApiMember {
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}

export async function loadWorkspaceSettingsContext(
  request: Request,
  currentUserId: string,
): Promise<{
  workspace: WorkspaceSummary;
  currentUserRole: ApiMember["role"];
  membersForbidden: boolean;
} | null> {
  const workspace = await serverFetchJson<WorkspaceSummary & { planSeats?: number | null }>(
    request,
    "/workspaces/active",
  );
  const { members, forbidden } = await fetchMembersWithFallback(request);
  if (!workspace) return null;

  if (forbidden || !members) {
    const workspaces = await listWorkspaces(request);
    const currentUserRole = resolveActiveWorkspaceRole(workspace.id, workspaces);

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
      },
      currentUserRole,
      membersForbidden: true,
    };
  }

  const currentMember = members.find((member) => member.userId === currentUserId);
  if (!currentMember) return null;

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
    },
    currentUserRole: currentMember.role,
    membersForbidden: false,
  };
}

export async function loadAiSettings(request: Request): Promise<AiSettingsData | null> {
  return serverFetchJson<AiSettingsData>(request, "/workspace/settings/ai");
}

export async function updateWorkspaceName(name: string): Promise<WorkspaceSummary> {
  const res = await apiFetch("/workspaces/active", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as WorkspaceSummary;
}

export async function deleteWorkspace(): Promise<void> {
  const res = await apiFetch("/workspaces/active", { method: "DELETE", csrf: true });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
}

export async function updateAiSettings(body: {
  enabled: boolean;
  apiKey?: string;
  model?: string;
}): Promise<AiSettingsData> {
  const res = await apiFetch("/workspace/settings/ai", {
    method: "PATCH",
    csrf: true,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiErrorMessage(res));
  }
  return (await res.json()) as AiSettingsData;
}
