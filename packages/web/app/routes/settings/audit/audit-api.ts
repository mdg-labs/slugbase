import type { AuditEventsPage, WorkspacePlanSummary } from "./audit.types.js";

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

interface ApiWorkspace {
  plan: "free" | "personal" | "team";
}

export async function loadAuditWorkspacePlan(
  request: Request,
): Promise<WorkspacePlanSummary | null> {
  const workspace = await fetchJson<ApiWorkspace>(request, "/workspaces/active");
  if (!workspace) return null;
  return { plan: workspace.plan };
}

export async function loadAuditEvents(
  request: Request,
  params: {
    page: number;
    pageSize: number;
    search?: string;
    actorId?: string;
    type?: string;
  },
): Promise<AuditEventsPage | null> {
  const qs = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.search) qs.set("search", params.search);
  if (params.actorId && params.actorId !== "all") qs.set("actorId", params.actorId);
  if (params.type && params.type !== "all") qs.set("type", params.type);

  return fetchJson<AuditEventsPage>(request, `/audit/events?${qs.toString()}`);
}
