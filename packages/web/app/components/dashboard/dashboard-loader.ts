import type { DashboardBookmark, DashboardData } from "./dashboard.types.js";

import type { BookmarkSharingSummary } from "../sharing/sharing-recipients.utils.js";
import { PRIVATE_BOOKMARK_SHARING_SUMMARY } from "../../routes/bookmarks/bookmarks-loader.js";
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
  sharingSummary?: BookmarkSharingSummary;
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

function mapBookmark(item: ApiBookmark): DashboardBookmark {
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
    sharingSummary: item.sharingSummary ?? PRIVATE_BOOKMARK_SHARING_SUMMARY,
    folders: item.folders,
    tags: item.tags,
  };
}

function mapBookmarks(items: ApiBookmark[]): DashboardBookmark[] {
  return items.map((item) => mapBookmark(item));
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
    quickAccess: mapBookmarks(quickAccessItems),
    pinned: mapBookmarks(pinnedItems),
    recent: mapBookmarks(recentItems),
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
