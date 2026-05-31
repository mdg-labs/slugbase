import {
  DEFAULT_SEARCH_LIMIT_PER_TYPE,
  MAX_SEARCH_LIMIT_PER_TYPE,
} from "./search.constants.js";
import type { ParsedSearchLimits } from "./search.types.js";

function parseLimit(value: number | undefined, fallback: number): number {
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.min(
    MAX_SEARCH_LIMIT_PER_TYPE,
    Math.max(1, Math.floor(value)),
  );
}

export function parseSearchLimits(limits: {
  bookmarkLimit?: number;
  folderLimit?: number;
  tagLimit?: number;
}): ParsedSearchLimits {
  return {
    bookmarks: parseLimit(
      limits.bookmarkLimit,
      DEFAULT_SEARCH_LIMIT_PER_TYPE,
    ),
    folders: parseLimit(limits.folderLimit, DEFAULT_SEARCH_LIMIT_PER_TYPE),
    tags: parseLimit(limits.tagLimit, DEFAULT_SEARCH_LIMIT_PER_TYPE),
  };
}

export function parseSearchQuery(q: string | undefined): string {
  const trimmed = q?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new Error("q is required");
  }
  return trimmed;
}
