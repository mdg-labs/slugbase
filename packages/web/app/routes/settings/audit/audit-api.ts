import type {
  AuditActor,
  AuditEventsPage,
  WorkspaceMemberRole,
  WorkspacePlanSummary,
} from "./audit.types.js";

import { listWorkspaces } from "../../../components/workspace-switcher/workspace-switcher-api.js";
import { getServerApiBaseUrl } from "../../../lib/server-api-base-url.js";
import { resolveActiveWorkspaceRole } from "../workspace/workspace-entitlements.js";

type FetchJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null };

async function fetchJsonWithStatus<T>(
  request: Request,
  path: string,
): Promise<FetchJsonResult<T>> {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getServerApiBaseUrl()}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: null };
  }
}

interface ApiWorkspace {
  id: string;
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

export async function loadAuditSettingsContext(
  request: Request,
): Promise<{
  workspace: WorkspacePlanSummary | null;
  currentUserRole: WorkspaceMemberRole;
}> {
  const workspaceResult = await fetchJsonWithStatus<ApiWorkspace>(
    request,
    "/workspaces/active",
  );
  const workspaces = await listWorkspaces(request);

  if (!workspaceResult.ok) {
    return { workspace: null, currentUserRole: "MEMBER" };
  }

  const workspace: WorkspacePlanSummary = {
    id: workspaceResult.data.id,
    plan: workspaceResult.data.plan,
  };

  return {
    workspace,
    currentUserRole: resolveActiveWorkspaceRole(workspace.id, workspaces),
  };
}

export async function loadAuditWorkspacePlan(
  request: Request,
): Promise<WorkspacePlanSummary | null> {
  const context = await loadAuditSettingsContext(request);
  return context.workspace;
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
): Promise<FetchJsonResult<AuditEventsPage>> {
  const qs = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.search) qs.set("q", params.search);
  if (params.actorId && params.actorId !== "all") {
    qs.set("actorUserId", params.actorId);
  }
  if (params.type && params.type !== "all") qs.set("entityType", params.type);

  const response = await fetchJsonWithStatus<ApiPaginatedAuditEvents>(
    request,
    `/audit/events?${qs.toString()}`,
  );
  if (!response.ok) return response;

  return { ok: true, data: normalizeAuditEventsPage(response.data) };
}
