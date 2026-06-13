const getApiBaseUrl = (): string => {
  const fromProcess = typeof process !== "undefined" ? process.env["API_BASE_URL"] : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess.replace(/\/$/, "");
  const fromVite = typeof import.meta !== "undefined" ? (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL : undefined;
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite.replace(/\/$/, "");
  return "";
};

export interface WorkspaceListItem {
  id: string;
  name: string;
  plan: "free" | "personal" | "team";
  role: "OWNER" | "ADMIN" | "MEMBER";
}

async function getMutationHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${getApiBaseUrl()}/auth/csrf-token`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch CSRF token");
  const data = (await res.json()) as { csrfToken: string };
  return { "Content-Type": "application/json", "x-csrf-token": data.csrfToken };
}

/** Fetch all workspaces the current user belongs to. Gracefully returns [] on failure. */
export async function listWorkspaces(request?: Request): Promise<WorkspaceListItem[]> {
  const cookie = request?.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getApiBaseUrl()}/workspaces`, {
      headers: cookie ? { Cookie: cookie } : {},
      credentials: request ? undefined : "include",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as WorkspaceListItem[]) : [];
  } catch {
    return [];
  }
}

/** Activate (switch to) a workspace by its ID. */
export async function activateWorkspace(workspaceId: string): Promise<void> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspaces/${workspaceId}/activate`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to activate workspace");
}

/** Create a new workspace with the given name. Returns the created workspace. */
export async function createWorkspace(name: string): Promise<WorkspaceListItem> {
  const headers = await getMutationHeaders();
  const res = await fetch(`${getApiBaseUrl()}/workspaces`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to create workspace");
  return (await res.json()) as WorkspaceListItem;
}
