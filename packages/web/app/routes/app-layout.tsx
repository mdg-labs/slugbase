import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { AppChrome } from "../components/AppChrome.js";
import { getSessionUser } from "../lib/session-client.js";
import type { WorkspaceListItem } from "../components/workspace-switcher/workspace-switcher-api.js";
import type { SidebarFolder } from "../components/AppSidebar.js";
import { LoaderStatusError } from "./errors/loader-status-error.js";
import { appRouteMeta } from "../lib/route-meta.js";

import { getServerApiBaseUrl } from "../lib/server-api-base-url.js";

type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number };

async function fetchJson<T>(request: Request, path: string): Promise<FetchResult<T>> {
  const apiBaseUrl = getServerApiBaseUrl();
  if (!apiBaseUrl) {
    return { ok: false, status: 503 };
  }
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: 503 };
  }
}

interface ApiActiveWorkspace {
  id: string;
  name: string;
  plan: "free" | "personal" | "team";
  bookmarkCount?: number;
}

interface ApiFolder {
  id: string;
  name: string;
  icon: string | null;
  bookmarkCount: number;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (!user) return redirect("/login");

  const apiBaseUrl = getServerApiBaseUrl();
  if (!apiBaseUrl) {
    throw new LoaderStatusError(503);
  }

  const [workspaceResult, workspacesResult, foldersResult, bookmarksResult] = await Promise.all([
    fetchJson<ApiActiveWorkspace>(request, "/workspaces/active"),
    fetchJson<WorkspaceListItem[]>(request, "/workspaces"),
    fetchJson<PaginatedResponse<ApiFolder>>(request, "/folders?pageSize=20&sort=name-asc"),
    fetchJson<PaginatedResponse<Record<string, unknown>>>(request, "/bookmarks?pageSize=1"),
  ]);

  if (!workspaceResult.ok) {
    if (workspaceResult.status === 401) {
      throw new LoaderStatusError(401);
    }
    if (workspaceResult.status === 403) {
      throw new LoaderStatusError(403);
    }
    throw new LoaderStatusError(503);
  }

  const workspace = workspaceResult.data;

  const workspaces: WorkspaceListItem[] = workspacesResult.ok && Array.isArray(workspacesResult.data)
    ? workspacesResult.data
    : [{ id: workspace.id, name: workspace.name, plan: workspace.plan, role: "OWNER" }];

  const folderItems = foldersResult.ok ? foldersResult.data.items : [];
  const sidebarFolders: SidebarFolder[] = folderItems.map((f) => ({
    id: f.id,
    name: f.name,
    color: f.icon,
    bookmarkCount: f.bookmarkCount,
  }));

  const bookmarkTotal = bookmarksResult.ok ? bookmarksResult.data.total : 0;

  const activeWorkspaceItem = workspaces.find((item) => item.id === workspace.id);
  const currentUserRole = activeWorkspaceItem?.role ?? "OWNER";

  return {
    user,
    workspace: { id: workspace.id, name: workspace.name, plan: workspace.plan },
    workspaces,
    currentUserRole,
    sidebarFolders,
    bookmarkTotal,
  };
}

export default function AppLayoutRoute() {
  return <AppChrome />;
}

export const meta = appRouteMeta;

export { AppShellErrorBoundary as ErrorBoundary } from "./errors/AppShellErrorBoundary.js";
