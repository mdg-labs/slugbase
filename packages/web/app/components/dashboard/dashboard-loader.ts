import type { DashboardBookmark, DashboardData } from "./dashboard.types.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

interface ApiBookmark {
  id: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
}

interface ApiFolder {
  id: string;
  name: string;
  icon: string | null;
  bookmarkCount: number;
}

interface ApiTag {
  id: string;
  name: string;
  color: string | null;
  bookmarkCount: number;
}

interface ApiWorkspace {
  id: string;
  name: string;
  plan: "free" | "personal";
}

function mapBookmark(item: ApiBookmark): DashboardBookmark {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    slug: item.slug,
    forwardingEnabled: item.forwardingEnabled,
    pinned: item.pinned,
    accessCount: item.accessCount,
    lastAccessedAt: item.lastAccessedAt,
  };
}

async function fetchJson<T>(
  request: Request,
  path: string,
): Promise<T | null> {
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    const res = await fetch(`${getApiBaseUrl()}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Loads dashboard aggregates from the NestJS API (cookie-forwarding). */
export async function loadDashboardData(
  request: Request,
): Promise<DashboardData | null> {
  const [
    workspace,
    bookmarkTotals,
    foldersResponse,
    tagsResponse,
    pinnedResponse,
    recentResponse,
    quickAccessResponse,
    sharedWithMeResponse,
    sharedByMeResponse,
  ] = await Promise.all([
    fetchJson<ApiWorkspace>(request, "/workspaces/active"),
    fetchJson<PaginatedResponse<ApiBookmark>>(
      request,
      "/bookmarks?pageSize=1",
    ),
    fetchJson<PaginatedResponse<ApiFolder>>(request, "/folders?pageSize=100"),
    fetchJson<PaginatedResponse<ApiTag>>(request, "/tags?pageSize=100"),
    fetchJson<PaginatedResponse<ApiBookmark>>(
      request,
      "/bookmarks?pinned=true&pageSize=8&sort=title-asc",
    ),
    fetchJson<PaginatedResponse<ApiBookmark>>(
      request,
      "/bookmarks?sort=last-accessed-desc&pageSize=6",
    ),
    fetchJson<PaginatedResponse<ApiBookmark>>(
      request,
      "/bookmarks?sort=access-count-desc&pageSize=24",
    ),
    fetchJson<PaginatedResponse<ApiBookmark>>(
      request,
      "/bookmarks?scope=shared-with-me&pageSize=1",
    ),
    fetchJson<PaginatedResponse<ApiBookmark>>(
      request,
      "/bookmarks?scope=shared-by-me&pageSize=1",
    ),
  ]);

  if (!workspace || !bookmarkTotals || !foldersResponse || !tagsResponse) {
    return null;
  }

  const quickAccess = (quickAccessResponse?.items ?? [])
    .filter((item) => item.slug !== null)
    .slice(0, 6)
    .map(mapBookmark);

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
    },
    counts: {
      bookmarks: bookmarkTotals.total,
      folders: foldersResponse.total,
      tags: tagsResponse.total,
      sharedWithMe: sharedWithMeResponse?.total ?? 0,
      sharedByMe: sharedByMeResponse?.total ?? 0,
    },
    quickAccess,
    pinned: (pinnedResponse?.items ?? []).map(mapBookmark),
    recent: (recentResponse?.items ?? []).map(mapBookmark),
    folders: foldersResponse.items.map((item) => ({
      id: item.id,
      name: item.name,
      icon: item.icon,
      bookmarkCount: item.bookmarkCount,
    })),
    tags: tagsResponse.items.map((item) => ({
      id: item.id,
      name: item.name,
      color: item.color,
      bookmarkCount: item.bookmarkCount,
    })),
  };
}
