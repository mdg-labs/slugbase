import { useRouteLoaderData } from "react-router";

import type { WorkspaceListItem } from "../components/workspace-switcher/workspace-switcher-api.js";
import type { SidebarFolder } from "../components/AppSidebar.js";
import { getServerApiBaseUrl } from "./server-api-base-url.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  language: "en" | "de";
  mfaState: "not_enrolled" | "pending" | "enrolled";
  emailVerified: boolean;
  onboardingCompletedAt: number | null;
  dashboardChecklistDismissed: boolean;
  dashboardChecklistManual: {
    import: boolean;
    browser_shortcut: boolean;
    folder: boolean;
    tag: boolean;
  };
}

/**
 * Fetches the current session user from the backend by forwarding the session
 * cookie. Returns `null` when unauthenticated or the request fails.
 *
 * Designed for use in React Router v7 server-side loaders and actions.
 */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const apiBaseUrl = getServerApiBaseUrl();
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    const res = await fetch(`${apiBaseUrl}/auth/me`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionUser;
  } catch {
    return null;
  }
}

export interface AppShellLoaderData {
  user: SessionUser;
  workspace: { id: string; name: string; plan: "free" | "personal" | "team" };
  workspaces: WorkspaceListItem[];
  currentUserRole: WorkspaceListItem["role"];
  sidebarFolders: SidebarFolder[];
  bookmarkTotal: number;
}

/**
 * React hook that reads the authenticated session user from the app-layout
 * loader data. Must be called from a route rendered inside the auth-guarded
 * app layout.
 */
export function useSession(): SessionUser {
  // useRouteLoaderData returns the serialized app-layout loader data
  const rawData: unknown = useRouteLoaderData("routes/app-layout");
  const data = rawData as AppShellLoaderData | undefined;
  if (!data?.user) {
    throw new Error("useSession must be used within an authenticated route");
  }
  return data.user;
}

/**
 * React hook that reads the full app-shell data (user, workspace, workspaces,
 * sidebar folders, bookmark total) from the app-layout loader.
 * Must be called from a route rendered inside the auth-guarded app layout.
 */
export function useAppShellData(): AppShellLoaderData {
  const rawData: unknown = useRouteLoaderData("routes/app-layout");
  const data = rawData as AppShellLoaderData | undefined;
  if (!data?.user) {
    throw new Error("useAppShellData must be used within an authenticated route");
  }
  return data;
}
