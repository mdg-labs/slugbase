/** Lucide icon name - kebab-case identifier from the searchable icon set (spec §7.1). */
export const FOLDER_ICON_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DEFAULT_FOLDER_PAGE_SIZE = 24;
export const MAX_FOLDER_PAGE_SIZE = 100;

export type FolderScope = "all" | "mine" | "shared-with-me" | "shared-by-me";

export type FolderSort =
  | "name-asc"
  | "name-desc"
  | "created-desc"
  | "created-asc";

export function sanitizeFolderName(name: string): string {
  return name.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function normalizeOptionalIcon(icon: string | null | undefined): string | null {
  if (icon == null) return null;
  const trimmed = icon.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function assertFolderIconValid(icon: string): void {
  if (!FOLDER_ICON_GRAMMAR.test(icon)) {
    throw new Error("Icon must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
}

export function parseFolderScope(scope: string | undefined): FolderScope {
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

export function parseFolderSort(sort: string | undefined): FolderSort {
  if (sort == null || sort === "created-desc") return "created-desc";
  if (sort === "name-asc" || sort === "name-desc" || sort === "created-asc") {
    return sort;
  }
  throw new Error(`Invalid sort: ${sort}`);
}

export function parsePage(page: number | undefined): number {
  if (page == null || Number.isNaN(page)) return 1;
  return Math.max(1, Math.floor(page));
}

export function parsePageSize(pageSize: number | undefined): number {
  if (pageSize == null || Number.isNaN(pageSize)) return DEFAULT_FOLDER_PAGE_SIZE;
  return Math.min(MAX_FOLDER_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}
