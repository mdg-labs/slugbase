import type { BookmarkScope, BookmarkSort } from "./bookmark.validation.js";

export interface BookmarkFolderSummary {
  id: string;
  name: string;
}

export interface BookmarkTagSummary {
  id: string;
  name: string;
}

export interface BookmarkRecord {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  planArchived: boolean;
  accessCount: number;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  folders: BookmarkFolderSummary[];
  tags: BookmarkTagSummary[];
}

export interface CreateBookmarkData {
  title: string;
  url: string;
  slug?: string | null;
  forwardingEnabled?: boolean;
  pinned?: boolean;
}

export interface UpdateBookmarkData {
  title?: string;
  url?: string;
  slug?: string | null;
  forwardingEnabled?: boolean;
  pinned?: boolean;
  planArchived?: boolean;
}

export interface SlugPreferenceRecord {
  id: string;
  workspaceId: string;
  userId: string;
  slug: string;
  bookmarkId: string;
  createdAt: Date;
}

export interface CreateSlugPreferenceData {
  workspaceId: string;
  userId: string;
  slug: string;
  bookmarkId: string;
}

/** Raw HTTP query - scope/sort/tagIds are parsed in the service before listing. */
export interface ListBookmarksQuery {
  q?: string;
  folderId?: string;
  tagIds?: string | string[];
  pinned?: boolean | string;
  scope?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ParsedListBookmarksQuery {
  q?: string;
  folderId?: string;
  tagIds?: string[];
  pinned?: boolean;
  scope: BookmarkScope;
  sort: BookmarkSort;
  page?: number;
  pageSize?: number;
}

export interface PaginatedBookmarks {
  items: BookmarkRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BookmarkIdsResult {
  ids: string[];
  total: number;
}
