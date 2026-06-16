import type { DashboardBookmark, DashboardData } from "./dashboard.types.js";

import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

interface ApiBookmark {
  id: string;
  userId: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string | null;
  folders: Array<{ id: string; name: string; color: string | null }>;
  tags: Array<{ id: string; name: string; color: string | null }>;
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

function mapBookmark(
  item: ApiBookmark,
  shareGrantCount = 0,
): DashboardBookmark {
  return {
    id: item.id,
    userId: item.userId,
    title: item.title,
    url: item.url,
    slug: item.slug,
    forwardingEnabled: item.forwardingEnabled,
    pinned: item.pinned,
    accessCount: item.accessCount,
    lastAccessedAt: item.lastAccessedAt,
    createdAt: item.createdAt ?? null,
    shareGrantCount,
    folders: item.folders,
    tags: item.tags,
  };
}

async function loadShareGrantCounts(
  request: Request,
  bookmarkIds: string[],
): Promise<Map<string, number>> {
  const shareCounts = new Map<string, number>();
  if (bookmarkIds.length === 0) {
    return shareCounts;
  }

  await Promise.all(
    bookmarkIds.map(async (bookmarkId) => {
      const shares = await fetchJson<{ grants: Array<{ id: string }> }>(
        request,
        `/sharing/bookmarks/${bookmarkId}`,
      );
      if (shares) {
        shareCounts.set(bookmarkId, shares.grants.length);
      }
    }),
  );

  return shareCounts;
}

function mapBookmarksWithShares(
  items: ApiBookmark[],
  shareCounts: Map<string, number>,
): DashboardBookmark[] {
  return items.map((item) =>
    mapBookmark(item, shareCounts.get(item.id) ?? 0),
  );
}

async function fetchJson<T>(
  request: Request,
  path: string,
): Promise<T | null> {
  const cookie = request.headers.get("Cookie") ?? "";

  try {
    const res = await fetch(`${getServerApiBaseUrl()}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(8_000),
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

  const quickAccessItems = (quickAccessResponse?.items ?? [])
    .filter((item) => item.slug !== null)
    .slice(0, 6);
  const pinnedItems = pinnedResponse?.items ?? [];
  const recentItems = recentResponse?.items ?? [];
  const allBookmarkIds = [
    ...new Set(
      [...quickAccessItems, ...pinnedItems, ...recentItems].map(
        (item) => item.id,
      ),
    ),
  ];
  const shareCounts = await loadShareGrantCounts(request, allBookmarkIds);

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
    quickAccess: mapBookmarksWithShares(quickAccessItems, shareCounts),
    pinned: mapBookmarksWithShares(pinnedItems, shareCounts),
    recent: mapBookmarksWithShares(recentItems, shareCounts),
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
