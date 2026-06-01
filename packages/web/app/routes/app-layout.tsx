import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { AppChrome } from "../components/AppChrome.js";
import { getSessionUser } from "../lib/session-client.js";
import type { WorkspaceListItem } from "../components/workspace-switcher/workspace-switcher-api.js";
import type { SidebarFolder } from "../components/AppSidebar.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

async function fetchJson<T>(request: Request, path: string): Promise<T | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getApiBaseUrl()}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
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

  const [workspace, workspacesRaw, foldersResponse, bookmarkTotals] = await Promise.all([
    fetchJson<ApiActiveWorkspace>(request, "/workspaces/active"),
    fetchJson<unknown>(request, "/workspaces"),
    fetchJson<PaginatedResponse<ApiFolder>>(request, "/folders?pageSize=20&sort=name-asc"),
    fetchJson<PaginatedResponse<Record<string, unknown>>>(request, "/bookmarks?pageSize=1"),
  ]);

  if (!workspace) {
    throw new Error("Failed to load active workspace");
  }

  const workspaces: WorkspaceListItem[] = Array.isArray(workspacesRaw)
    ? (workspacesRaw as WorkspaceListItem[])
    : [{ id: workspace.id, name: workspace.name, plan: workspace.plan, role: "OWNER" }];

  const sidebarFolders: SidebarFolder[] = (foldersResponse?.items ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    color: f.icon,
    bookmarkCount: f.bookmarkCount,
  }));

  return {
    user,
    workspace: { id: workspace.id, name: workspace.name, plan: workspace.plan },
    workspaces,
    sidebarFolders,
    bookmarkTotal: bookmarkTotals?.total ?? 0,
  };
}

export default function AppLayoutRoute() {
  return <AppChrome />;
}

export { AppShellErrorBoundary as ErrorBoundary } from "./errors/AppShellErrorBoundary.js";
