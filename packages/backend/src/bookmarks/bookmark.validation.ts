/** Slug grammar and reserved list - docs/internal/defaults-and-constants.md §1, spec §8. */
export const SLUG_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const RESERVED_SLUGS = new Set([
  "go",
  "api",
  "auth",
  "health",
  "version",
  "login",
  "logout",
  "setup",
]);

export const DEFAULT_BOOKMARK_PAGE_SIZE = 24;
export const MAX_BOOKMARK_PAGE_SIZE = 100;

export type BookmarkScope = "all" | "mine" | "shared-with-me" | "shared-by-me";

export type BookmarkSort =
  | "created-desc"
  | "title-asc"
  | "access-count-desc"
  | "last-accessed-desc";

export function sanitizeBookmarkTitle(title: string): string {
  return title.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function normalizeOptionalSlug(slug: string | null | undefined): string | null {
  if (slug == null) return null;
  const trimmed = slug.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function assertSlugValid(slug: string): void {
  if (!SLUG_GRAMMAR.test(slug)) {
    throw new Error("Slug must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Slug "${slug}" is reserved`);
  }
}

export function parseBookmarkScope(scope: string | undefined): BookmarkScope {
  if (scope == null || scope === "all") return "all";
  if (
    scope === "mine" ||
    scope === "shared-with-me" ||
    scope === "shared-by-me"
  ) {
    return scope;
  }
  throw new Error(`Invalid scope: ${scope}`);
}

export function parseBookmarkSort(sort: string | undefined): BookmarkSort {
  if (sort == null || sort === "created-desc") return "created-desc";
  if (
    sort === "title-asc" ||
    sort === "access-count-desc" ||
    sort === "last-accessed-desc"
  ) {
    return sort;
  }
  throw new Error(`Invalid sort: ${sort}`);
}

export function parsePage(page: number | undefined): number {
  if (page == null || Number.isNaN(page)) return 1;
  return Math.max(1, Math.floor(page));
}

export function parsePageSize(pageSize: number | undefined): number {
  if (pageSize == null || Number.isNaN(pageSize)) return DEFAULT_BOOKMARK_PAGE_SIZE;
  return Math.min(MAX_BOOKMARK_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

export function parseTagIds(
  tagIds: string | string[] | undefined,
): string[] | undefined {
  if (tagIds == null) return undefined;
  const ids = Array.isArray(tagIds)
    ? tagIds
    : tagIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

export function parsePinned(
  pinned: boolean | string | undefined,
): boolean | undefined {
  if (pinned == null) return undefined;
  if (typeof pinned === "boolean") return pinned;
  if (pinned === "true") return true;
  if (pinned === "false") return false;
  throw new Error("Invalid pinned filter");
}
