import type { FolderSharingSummary } from "../../components/sharing/sharing-recipients.utils.js";
import type { SharingScope } from "../../components/sharing/sharing.types.js";
import {
  buildScopedListQuery,
  parseSharingScope,
} from "../../components/sharing/sharing.utils.js";

import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";

export const PRIVATE_FOLDER_SHARING_SUMMARY: FolderSharingSummary = {
  scope: "mine",
  directRecipients: [],
};

export type FolderListItem = {
  id: string;
  userId: string;
  name: string;
  icon: string | null;
  color: string | null;
  bookmarkCount: number;
  sharingSummary: FolderSharingSummary;
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
  ownerNames: Record<string, string>;
};

interface ApiFolder {
  id: string;
  userId: string;
  name: string;
  icon: string | null;
  color: string | null;
  bookmarkCount: number;
  sharingSummary?: FolderSharingSummary;
  updatedAt: string;
}

interface PaginatedFolders {
  items: ApiFolder[];
  total: number;
  page: number;
  pageSize: number;
}

interface ShareTargetsResponse {
  members: Array<{ userId: string; name: string; email: string }>;
  teams: Array<{ id: string; name: string; memberCount: number }>;
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

  // Resolve owner names for shared-with-me scope
  const ownerNames: Record<string, string> = {};
  if (scope === "shared-with-me" && list.items.length > 0) {
    const targets = await fetchJson<ShareTargetsResponse>(
      request,
      "/sharing/targets",
    );
    if (targets) {
      for (const member of targets.members) {
        ownerNames[member.userId] = member.name;
      }
    }
  }

  return {
    scope,
    q,
    page: list.page,
    pageSize: list.pageSize,
    sort,
    total: list.total,
    ownerNames,
    items: list.items.map((item) => ({
      ...item,
      sharingSummary: item.sharingSummary ?? PRIVATE_FOLDER_SHARING_SUMMARY,
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