export const DEFAULT_TEAM_PAGE_SIZE = 24;
export const MAX_TEAM_PAGE_SIZE = 100;

export type TeamSort =
  | "name-asc"
  | "name-desc"
  | "created-desc"
  | "created-asc"
  | "members-desc"
  | "members-asc";

export function sanitizeTeamName(name: string): string {
  return name.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function sanitizeTeamDescription(
  description: string | null | undefined,
): string | null {
  if (description == null) return null;
  const trimmed = description.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function parseTeamSort(sort: string | undefined): TeamSort {
  if (sort == null || sort === "created-desc") return "created-desc";
  if (
    sort === "name-asc" ||
    sort === "name-desc" ||
    sort === "created-asc" ||
    sort === "members-desc" ||
    sort === "members-asc"
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
  if (pageSize == null || Number.isNaN(pageSize)) return DEFAULT_TEAM_PAGE_SIZE;
  return Math.min(MAX_TEAM_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}
