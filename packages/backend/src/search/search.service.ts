import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";

import { BookmarksService } from "../bookmarks/bookmarks.service.js";
import { FoldersService } from "../folders/folders.service.js";
import { TagsService } from "../tags/tags.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { GLOBAL_SEARCH_FALLBACK } from "./search.constants.js";
import type {
  GlobalSearchQuery,
  GlobalSearchResult,
  SearchResultSlice,
} from "./search.types.js";
import { parseSearchLimits, parseSearchQuery } from "./search.validation.js";

@Injectable()
export class SearchService {
  constructor(
    @Inject(BookmarksService) private readonly bookmarks: BookmarksService,
    @Inject(FoldersService) private readonly folders: FoldersService,
    @Inject(TagsService) private readonly tags: TagsService,
  ) {}

  async search(
    workspace: WorkspaceRecord,
    userId: string,
    query: GlobalSearchQuery,
  ): Promise<GlobalSearchResult> {
    let q: string;
    try {
      q = parseSearchQuery(query.q);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid search query",
      );
    }

    const limits = parseSearchLimits(query);

    const [bookmarkPage, folderPage, tagPage] = await Promise.all([
      this.bookmarks.listBookmarks(workspace, userId, {
        q,
        scope: "all",
        sort: "title-asc",
        page: 1,
        pageSize: limits.bookmarks,
      }),
      this.folders.listFolders(workspace, userId, {
        q,
        scope: "all",
        sort: "name-asc",
        page: 1,
        pageSize: limits.folders,
      }),
      this.tags.listTags(workspace, userId, {
        q,
        sort: "name-asc",
        page: 1,
        pageSize: limits.tags,
      }),
    ]);

    return {
      q,
      limits,
      bookmarks: toSlice(bookmarkPage.items, bookmarkPage.total, limits.bookmarks),
      folders: toSlice(folderPage.items, folderPage.total, limits.folders),
      tags: toSlice(tagPage.items, tagPage.total, limits.tags),
      fallback: GLOBAL_SEARCH_FALLBACK,
    };
  }
}

function toSlice<T>(
  items: T[],
  total: number,
  limit: number,
): SearchResultSlice<T> {
  return {
    items,
    total,
    truncated: total > limit,
  };
}
