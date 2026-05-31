import type { SharingScope } from "./sharing.types.js";

const VALID_SCOPES = new Set<SharingScope>([
  "all",
  "mine",
  "shared-with-me",
  "shared-by-me",
]);

export function parseSharingScope(value: string | null | undefined): SharingScope {
  if (value && VALID_SCOPES.has(value as SharingScope)) {
    return value as SharingScope;
  }
  return "all";
}

export function resolveBookmarkSharingScope(
  ownerUserId: string,
  currentUserId: string,
  shareGrantCount = 0,
): SharingScope {
  if (ownerUserId !== currentUserId) {
    return "shared-with-me";
  }
  if (shareGrantCount > 0) {
    return "shared-by-me";
  }
  return "mine";
}

export function buildBookmarkListQuery(params: {
  scope: SharingScope;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}): string {
  const search = new URLSearchParams();
  if (params.scope !== "all") {
    search.set("scope", params.scope);
  }
  if (params.q) {
    search.set("q", params.q);
  }
  if (params.page != null) {
    search.set("page", String(params.page));
  }
  if (params.pageSize != null) {
    search.set("pageSize", String(params.pageSize));
  }
  if (params.sort) {
    search.set("sort", params.sort);
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}
