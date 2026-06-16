/** Mirrors GET /search response from packages/backend/src/search/search.types.ts */

export interface SearchBookmarkHit {
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
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchFolderHit {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  icon: string | null;
  color: string | null;
  bookmarkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchTagHit {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  color: string | null;
  bookmarkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResultSlice<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface GlobalSearchResult {
  q: string;
  limits: {
    bookmarks: number;
    folders: number;
    tags: number;
  };
  bookmarks: SearchResultSlice<SearchBookmarkHit>;
  folders: SearchResultSlice<SearchFolderHit>;
  tags: SearchResultSlice<SearchTagHit>;
  fallback: {
    bookmarks: { path: string; queryParam: "q" };
    folders: { path: string; queryParam: "q" };
    tags: { path: string; queryParam: "q" };
  };
}
