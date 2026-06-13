import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

export type TagListItem = {
  id: string;
  name: string;
  color: string | null;
  bookmarkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TagListData = {
  q: string;
  sort: string;
  page: number;
  pageSize: number;
  total: number;
  items: TagListItem[];
  maxBookmarkCount: number;
};

interface ApiTag {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  color: string | null;
  bookmarkCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedTags {
  items: ApiTag[];
  total: number;
  page: number;
  pageSize: number;
}

async function fetchJson<T>(request: Request, path: string): Promise<T | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  try {
    const res = await fetch(`${getServerApiBaseUrl()}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function buildTagListQuery(params: {
  q?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const str = sp.toString();
  return str ? `?${str}` : "";
}

export async function loadTagListData(
  request: Request,
): Promise<TagListData | null> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const sort = url.searchParams.get("sort") ?? "usage-desc";
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "50");

  const listPath = `/tags${buildTagListQuery({
    q: q || undefined,
    sort,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 50,
  })}`;

  const list = await fetchJson<PaginatedTags>(request, listPath);
  if (!list) return null;

  const maxBookmarkCount = list.items.reduce(
    (max, item) => Math.max(max, item.bookmarkCount),
    1,
  );

  return {
    q,
    sort,
    page: list.page,
    pageSize: list.pageSize,
    total: list.total,
    maxBookmarkCount,
    items: list.items.map((item) => ({
      id: item.id,
      name: item.name,
      color: item.color,
      bookmarkCount: item.bookmarkCount,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}
