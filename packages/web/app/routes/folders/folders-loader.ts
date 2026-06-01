import type { SharingScope } from "../../components/sharing/sharing.types.js";
import {
  buildScopedListQuery,
  parseSharingScope,
} from "../../components/sharing/sharing.utils.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

export type FolderListItem = {
  id: string;
  userId: string;
  name: string;
  icon: string | null;
  color: string | null;
  bookmarkCount: number;
  shareGrantCount: number;
  updatedAt: string;
};

export type FolderListData = {
  scope: SharingScope;
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  total: number;
  items: FolderListItem[];
};

interface ApiFolder {
  id: string;
  userId: string;
  name: string;
  icon: string | null;
  color: string | null;
  bookmarkCount: number;
  updatedAt: string;
}

interface PaginatedFolders {
  items: ApiFolder[];
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

export async function loadFolderListData(
  request: Request,
): Promise<FolderListData | null> {
  const url = new URL(request.url);
  const scope = parseSharingScope(url.searchParams.get("scope"));
  const q = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "12");
  const sort = url.searchParams.get("sort") ?? "name-asc";

  const listPath = `/folders${buildScopedListQuery({
    scope,
    q: q || undefined,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 12,
    sort,
  })}`;

  const list = await fetchJson<PaginatedFolders>(request, listPath);
  if (!list) return null;

  const ownedIds = list.items.map((item) => item.id);

  const shareCounts = new Map<string, number>();
  if (ownedIds.length > 0) {
    await Promise.all(
      ownedIds.map(async (folderId) => {
        const shares = await fetchJson<{ grants: Array<{ id: string }> }>(
          request,
          `/sharing/folders/${folderId}`,
        );
        if (shares) {
          shareCounts.set(folderId, shares.grants.length);
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
      updatedAt: item.updatedAt,
    })),
  };
}

export function buildFolderListSearch(params: {
  scope?: SharingScope;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}): string {
  return buildScopedListQuery({
    scope: params.scope ?? "all",
    q: params.q,
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
  });
}
