/** Optional tag accent color — 6-digit hex with leading # (design tokens compatible). */
export const TAG_COLOR_GRAMMAR = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_TAG_PAGE_SIZE = 24;
export const MAX_TAG_PAGE_SIZE = 100;

export type TagSort =
  | "name-asc"
  | "name-desc"
  | "created-desc"
  | "created-asc"
  | "usage-desc"
  | "usage-asc";

export function sanitizeTagName(name: string): string {
  return name.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function normalizeOptionalColor(color: string | null | undefined): string | null {
  if (color == null) return null;
  const trimmed = color.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function assertTagColorValid(color: string): void {
  if (!TAG_COLOR_GRAMMAR.test(color)) {
    throw new Error("Color must be a 6-digit hex value with leading # (e.g. #7782f7)");
  }
}

export function parseTagSort(sort: string | undefined): TagSort {
  if (sort == null || sort === "created-desc") return "created-desc";
  if (
    sort === "name-asc" ||
    sort === "name-desc" ||
    sort === "created-asc" ||
    sort === "usage-desc" ||
    sort === "usage-asc"
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
  if (pageSize == null || Number.isNaN(pageSize)) return DEFAULT_TAG_PAGE_SIZE;
  return Math.min(MAX_TAG_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}
