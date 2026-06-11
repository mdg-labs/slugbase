import type { FolderScope, FolderSort } from "./folder.validation.js";

export interface FolderRecord {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  icon: string | null;
  color: string | null;
  bookmarkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFolderData {
  name: string;
  icon?: string | null;
  color?: string | null;
  bookmarkIds?: string[];
}

export interface UpdateFolderData {
  name?: string;
  icon?: string | null;
  color?: string | null;
}

/** Raw HTTP query - scope/sort are parsed in the service before listing. */
export interface ListFoldersQuery {
  q?: string;
  scope?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ParsedListFoldersQuery {
  q?: string;
  scope: FolderScope;
  sort: FolderSort;
  page?: number;
  pageSize?: number;
}

export interface PaginatedFolders {
  items: FolderRecord[];
  total: number;
  page: number;
  pageSize: number;
}
