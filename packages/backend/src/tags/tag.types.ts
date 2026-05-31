import type { TagSort } from "./tag.validation.js";

export interface TagRecord {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  color: string | null;
  bookmarkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTagData {
  name: string;
  color?: string | null;
  bookmarkIds?: string[];
}

export interface UpdateTagData {
  name?: string;
  color?: string | null;
}

/** Raw HTTP query — sort is parsed in the service before listing. */
export interface ListTagsQuery {
  q?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ParsedListTagsQuery {
  q?: string;
  sort: TagSort;
  page?: number;
  pageSize?: number;
}

export interface PaginatedTags {
  items: TagRecord[];
  total: number;
  page: number;
  pageSize: number;
}
