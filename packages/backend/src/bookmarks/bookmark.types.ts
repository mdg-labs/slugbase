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
