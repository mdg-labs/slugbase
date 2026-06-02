import type { SharingScope } from "../../components/sharing/sharing.types.js";
import { parseSharingScope } from "../../components/sharing/sharing.utils.js";

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
  createdAt: string | null;
  shareGrantCount: number;
  folders: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
};

export type ToolbarFolder = { id: string; name: string; bookmarkCount: number };
export type ToolbarTag = { id: string; name: string };

export type BookmarkListData = {
  scope: SharingScope;
  q: string;
  folderId: string | null;
  tagIds: string[];
  pinnedOnly: boolean;
  view: "grid" | "table";
  defaultBookmarkView: "grid" | "table";
  page: number;
  pageSize: number;
  sort: string;
  total: number;
  items: BookmarkListItem[];
  toolbarFolders: ToolbarFolder[];
  toolbarTags: ToolbarTag[];
  /** Bookmark cap for the workspace (50 for Free, null for unlimited) */
  bookmarkCap: number | null;
  /** Total bookmarks in workspace for cap calculation */
  workspaceBookmarkTotal: number;
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
  createdAt: string | null;
  folders: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
}

interface PaginatedBookmarks {
  items: ApiBookmark[];
  total: number;
  page: number;
  pageSize: number;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

interface ApiFolder {
  id: string;
  name: string;
  bookmarkCount: number;
}

interface ApiTag {
  id: string;
  name: string;
}

interface ApiWorkspace {
  id: string;
  plan: "free" | "personal" | "team";
}

const FREE_BOOKMARK_CAP = 50;

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
  const folderId = url.searchParams.get("folderId") ?? null;
  const tagIdsParam = url.searchParams.get("tagIds") ?? "";
  const tagIds = tagIdsParam
    ? tagIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const pinnedOnly = url.searchParams.get("pinned") === "true";
  const viewParam = url.searchParams.get("view");

  const accountSettings = await fetchJson<{ defaultBookmarkView?: "grid" | "table" }>(
    request,
    "/auth/account",
  );
  const defaultBookmarkView =
    accountSettings?.defaultBookmarkView === "table" ? "table" : "grid";
  const view: "grid" | "table" =
    viewParam === "table" ? "table" : viewParam === "grid" ? "grid" : defaultBookmarkView;
  const defaultPageSize = view === "table" ? 50 : 24;
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(
    url.searchParams.get("pageSize") ?? String(defaultPageSize),
  );
  const sort = url.searchParams.get("sort") ?? "created-desc";

  const listParams = new URLSearchParams();
  if (scope !== "all") listParams.set("scope", scope);
  if (q) listParams.set("q", q);
  if (folderId) listParams.set("folderId", folderId);
  for (const tagId of tagIds) listParams.append("tagIds", tagId);
  if (pinnedOnly) listParams.set("pinned", "true");
  listParams.set("page", String(Number.isFinite(page) ? page : 1));
  listParams.set(
    "pageSize",
    String(Number.isFinite(pageSize) ? pageSize : defaultPageSize),
  );
  listParams.set("sort", sort);

  const [list, foldersResponse, tagsResponse, workspace] = await Promise.all([
    fetchJson<PaginatedBookmarks>(
      request,
      `/bookmarks?${listParams.toString()}`,
    ),
    fetchJson<PaginatedResponse<ApiFolder>>(
      request,
      "/folders?pageSize=100&sort=name-asc",
    ),
    fetchJson<PaginatedResponse<ApiTag>>(
      request,
      "/tags?pageSize=100&sort=name-asc",
    ),
    fetchJson<ApiWorkspace>(request, "/workspaces/active"),
  ]);

  if (!list) return null;

  const ownedIds = list.items.filter((item) => item.userId).map((item) => item.id);
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

  const plan = workspace?.plan ?? "personal";
  const bookmarkCap = plan === "free" ? FREE_BOOKMARK_CAP : null;

  return {
    scope,
    q,
    folderId,
    tagIds,
    pinnedOnly,
    view,
    defaultBookmarkView,
    page: list.page,
    pageSize: list.pageSize,
    sort,
    total: list.total,
    items: list.items.map((item) => ({
      ...item,
      createdAt: item.createdAt ?? null,
      shareGrantCount: shareCounts.get(item.id) ?? 0,
      folders: item.folders,
      tags: item.tags,
    })),
    toolbarFolders: (foldersResponse?.items ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      bookmarkCount: f.bookmarkCount,
    })),
    toolbarTags: (tagsResponse?.items ?? []).map((t) => ({
      id: t.id,
      name: t.name,
    })),
    bookmarkCap,
    workspaceBookmarkTotal: list.total,
  };
}

export function buildBookmarkListSearch(params: {
  scope?: SharingScope;
  q?: string;
  folderId?: string | null;
  tagIds?: string[];
  pinned?: boolean;
  view?: "grid" | "table";
  page?: number;
  pageSize?: number;
  sort?: string;
}): string {
  const p = new URLSearchParams();
  if (params.scope && params.scope !== "all") p.set("scope", params.scope);
  if (params.q) p.set("q", params.q);
  if (params.folderId) p.set("folderId", params.folderId);
  if (params.tagIds?.length) p.set("tagIds", params.tagIds.join(","));
  if (params.pinned) p.set("pinned", "true");
  if (params.view && params.view !== "grid") p.set("view", params.view);
  if (params.page != null) p.set("page", String(params.page));
  if (params.pageSize != null) p.set("pageSize", String(params.pageSize));
  if (params.sort && params.sort !== "created-desc") p.set("sort", params.sort);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}
