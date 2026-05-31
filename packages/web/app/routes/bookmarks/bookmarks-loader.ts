import type { SharingScope } from "../../components/sharing/sharing.types.js";
import { buildBookmarkListQuery, parseSharingScope } from "../../components/sharing/sharing.utils.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

export type BookmarkListItem = {
  id: string;
  userId: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
  shareGrantCount: number;
};

export type BookmarkListData = {
  scope: SharingScope;
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  total: number;
  items: BookmarkListItem[];
};

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
}

interface PaginatedBookmarks {
  items: ApiBookmark[];
  total: number;
  page: number;
  pageSize: number;
}

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

export async function loadBookmarkListData(
  request: Request,
): Promise<BookmarkListData | null> {
  const url = new URL(request.url);
  const scope = parseSharingScope(url.searchParams.get("scope"));
  const q = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "12");
  const sort = url.searchParams.get("sort") ?? "created-desc";

  const listPath = `/bookmarks${buildBookmarkListQuery({
    scope,
    q: q || undefined,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 12,
    sort,
  })}`;

  const list = await fetchJson<PaginatedBookmarks>(request, listPath);
  if (!list) return null;

  const ownedIds = list.items
    .filter((item) => item.userId)
    .map((item) => item.id);

  const shareCounts = new Map<string, number>();
  if (ownedIds.length > 0) {
    await Promise.all(
      ownedIds.map(async (bookmarkId) => {
        const shares = await fetchJson<{ grants: Array<{ id: string }> }>(
          request,
          `/sharing/bookmarks/${bookmarkId}`,
        );
        if (shares) {
          shareCounts.set(bookmarkId, shares.grants.length);
        }
      }),
    );
  }

  return {
    scope,
    q,
    page: list.page,
    pageSize: list.pageSize,
    sort,
    total: list.total,
    items: list.items.map((item) => ({
      ...item,
      shareGrantCount: shareCounts.get(item.id) ?? 0,
    })),
  };
}

export function buildBookmarkListSearch(params: {
  scope?: SharingScope;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}): string {
  return buildBookmarkListQuery({
    scope: params.scope ?? "all",
    q: params.q,
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
  });
}
