import type {
  AuditActor,
  AuditEventsPage,
  WorkspacePlanSummary,
} from "./audit.types.js";

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

/** Raw paginated audit response from the NestJS API (no `actors` field). */
interface ApiPaginatedAuditEvents {
  items: ApiAuditEventItem[];
  total: number;
  page: number;
  pageSize: number;
  actors?: AuditActor[];
}

interface ApiAuditEventItem {
  actorId?: string;
  actorUserId?: string;
  actorName?: string | null;
}

export function deriveAuditActors(
  items: readonly ApiAuditEventItem[],
): AuditActor[] {
  const byId = new Map<string, AuditActor>();

  for (const item of items) {
    const id = item.actorId ?? item.actorUserId;
    if (!id) continue;

    const name = item.actorName?.trim() || "Unknown";
    const existing = byId.get(id);
    if (!existing || (existing.name === "Unknown" && name !== "Unknown")) {
      byId.set(id, { id, name });
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeAuditEventsPage(
  response: ApiPaginatedAuditEvents,
): AuditEventsPage {
  return {
    items: response.items as AuditEventsPage["items"],
    total: response.total,
    page: response.page,
    pageSize: response.pageSize,
    actors: response.actors ?? deriveAuditActors(response.items),
  };
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
  if (params.search) qs.set("q", params.search);
  if (params.actorId && params.actorId !== "all") {
    qs.set("actorUserId", params.actorId);
  }
  if (params.type && params.type !== "all") qs.set("entityType", params.type);

  const response = await fetchJson<ApiPaginatedAuditEvents>(
    request,
    `/audit/events?${qs.toString()}`,
  );
  if (!response) return null;

  return normalizeAuditEventsPage(response);
}
