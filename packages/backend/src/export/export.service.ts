import { Inject, Injectable } from "@nestjs/common";

import { BookmarkRepository } from "../bookmarks/bookmark.repository.js";
import { MAX_BOOKMARK_PAGE_SIZE } from "../bookmarks/bookmark.validation.js";
import { DbService } from "../db/db.service.js";
import { FolderRepository } from "../folders/folder.repository.js";
import { TagRepository } from "../tags/tag.repository.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { ExportBookmarkEntry } from "./export.types.js";

@Injectable()
export class ExportService {
  private readonly bookmarkRepo: BookmarkRepository;
  private readonly folderRepo: FolderRepository;
  private readonly tagRepo: TagRepository;

  constructor(@Inject(DbService) dbService: DbService) {
    const db = dbService.getOrm();
    this.bookmarkRepo = new BookmarkRepository(db);
    this.folderRepo = new FolderRepository(db);
    this.tagRepo = new TagRepository(db);
  }

  async exportJson(
    workspace: WorkspaceRecord,
    userId: string,
  ): Promise<ExportBookmarkEntry[]> {
    const bookmarks = await this.listAccessibleBookmarks(workspace.id, userId);
    if (bookmarks.length === 0) return [];

    const folderNamesById = await this.loadFolderNameMap(workspace.id, userId);
    const tagNamesById = await this.loadTagNameMap(workspace.id, userId);

    const entries: ExportBookmarkEntry[] = [];

    for (const bookmark of bookmarks) {
      const folderIds = await this.folderRepo.listFolderIdsForBookmark(
        workspace.id,
        bookmark.id,
      );
      const tagIds = await this.tagRepo.listTagIdsForBookmark(
        workspace.id,
        bookmark.id,
      );

      const folders = folderIds
        .map((id) => folderNamesById.get(id))
        .filter((name): name is string => name != null)
        .sort((a, b) => a.localeCompare(b));

      const tags = tagIds
        .map((id) => tagNamesById.get(id))
        .filter((name): name is string => name != null)
        .sort((a, b) => a.localeCompare(b));

      entries.push({
        title: bookmark.title,
        url: bookmark.url,
        slug: bookmark.slug,
        forwardingEnabled: bookmark.forwardingEnabled,
        pinned: bookmark.pinned,
        folders,
        tags,
      });
    }

    return entries;
  }

  private async listAccessibleBookmarks(workspaceId: string, userId: string) {
    const items = [];
    let page = 1;
    let total = 0;

    do {
      const result = await this.bookmarkRepo.list(workspaceId, userId, {
        scope: "all",
        sort: "title-asc",
        page,
        pageSize: MAX_BOOKMARK_PAGE_SIZE,
      });
      items.push(...result.items);
      total = result.total;
      page += 1;
    } while (items.length < total);

    return items;
  }

  private async loadFolderNameMap(
    workspaceId: string,
    userId: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let page = 1;
    let total = 0;

    do {
      const result = await this.folderRepo.list(workspaceId, userId, {
        scope: "mine",
        sort: "name-asc",
        page,
        pageSize: 100,
      });
      for (const folder of result.items) {
        map.set(folder.id, folder.name);
      }
      total = result.total;
      page += 1;
    } while (map.size < total);

    return map;
  }

  private async loadTagNameMap(
    workspaceId: string,
    userId: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let page = 1;
    let total = 0;

    do {
      const result = await this.tagRepo.list(workspaceId, userId, {
        sort: "name-asc",
        page,
        pageSize: 100,
      });
      for (const tag of result.items) {
        map.set(tag.id, tag.name);
      }
      total = result.total;
      page += 1;
    } while (map.size < total);

    return map;
  }
}
