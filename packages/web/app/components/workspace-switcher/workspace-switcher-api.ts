import {
  apiFetch,
  serverFetchJson,
} from "../../lib/client-api-fetch.js";

export interface WorkspaceListItem {
  id: string;
  name: string;
  plan: "free" | "personal" | "team";
  role: "OWNER" | "ADMIN" | "MEMBER";
}

/** Fetch all workspaces the current user belongs to. Gracefully returns [] on failure. */
export async function listWorkspaces(request?: Request): Promise<WorkspaceListItem[]> {
  if (request) {
    const data = await serverFetchJson<unknown>(request, "/workspaces");
    return Array.isArray(data) ? (data as WorkspaceListItem[]) : [];
  }

  try {
    const res = await apiFetch("/workspaces");
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as WorkspaceListItem[]) : [];
  } catch {
    return [];
  }
}

/** Activate (switch to) a workspace by its ID. */
export async function activateWorkspace(workspaceId: string): Promise<void> {
  const res = await apiFetch(`/workspaces/${workspaceId}/activate`, {
    method: "POST",
    csrf: true,
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to activate workspace");
}

/** Create a new workspace with the given name. Returns the created workspace. */
export async function createWorkspace(name: string): Promise<WorkspaceListItem> {
  const res = await apiFetch("/workspaces", {
    method: "POST",
    csrf: true,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to create workspace");
  return (await res.json()) as WorkspaceListItem;
}
