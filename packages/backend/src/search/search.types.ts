import type { BookmarkRecord } from "../bookmarks/bookmark.types.js";
import type { FolderRecord } from "../folders/folder.types.js";
import type { TagRecord } from "../tags/tag.types.js";
import type { GLOBAL_SEARCH_FALLBACK } from "./search.constants.js";

export interface GlobalSearchQuery {
  q?: string;
  bookmarkLimit?: number;
  folderLimit?: number;
  tagLimit?: number;
}

export interface ParsedSearchLimits {
  bookmarks: number;
  folders: number;
  tags: number;
}

export interface SearchResultSlice<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface GlobalSearchResult {
  q: string;
  limits: ParsedSearchLimits;
  bookmarks: SearchResultSlice<BookmarkRecord>;
  folders: SearchResultSlice<FolderRecord>;
  tags: SearchResultSlice<TagRecord>;
  fallback: typeof GLOBAL_SEARCH_FALLBACK;
}
