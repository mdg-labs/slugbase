import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { BookmarkRepository } from "../bookmarks/bookmark.repository.js";
import { DbService } from "../db/db.service.js";
import { WorkspaceDataGuard } from "../workspaces/workspace-data.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { TagRepository } from "./tag.repository.js";
import type {
  CreateTagData,
  ListTagsQuery,
  PaginatedTags,
  ParsedListTagsQuery,
  TagRecord,
  UpdateTagData,
} from "./tag.types.js";
import {
  assertTagColorValid,
  normalizeOptionalColor,
  parseTagSort,
  sanitizeTagName,
} from "./tag.validation.js";

@Injectable()
export class TagsService {
  private readonly tagRepo: TagRepository;
  private readonly bookmarkRepo: BookmarkRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
  ) {
    this.tagRepo = new TagRepository(db.getOrm(), db.dialect);
    this.bookmarkRepo = new BookmarkRepository(db.getOrm(), db.dialect);
  }

  async createTag(
    workspace: WorkspaceRecord,
    userId: string,
    dto: CreateTagData,
  ): Promise<TagRecord> {
    const name = sanitizeTagName(dto.name.trim());
    if (!name) throw new BadRequestException("name is required");

    const color = this.normalizeColor(dto.color);
    if (dto.bookmarkIds?.length) {
      await this.assertBookmarksOwned(workspace.id, userId, dto.bookmarkIds);
    }

    const tag = await this.tagRepo.create(workspace.id, userId, {
      name,
      color,
      bookmarkIds: dto.bookmarkIds,
    });
    return this.wsDataGuard.verifyOwnership(workspace.id, tag);
  }

  async getTag(
    workspace: WorkspaceRecord,
    userId: string,
    tagId: string,
  ): Promise<TagRecord> {
    const tag = await this.requireOwnedTag(workspace, userId, tagId);
    return this.wsDataGuard.verifyOwnership(workspace.id, tag);
  }

  async listTags(
    workspace: WorkspaceRecord,
    userId: string,
    query: ListTagsQuery,
  ): Promise<PaginatedTags> {
    let sort;
    try {
      sort = parseTagSort(query.sort);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid list query",
      );
    }

    const parsed: ParsedListTagsQuery = {
      q: query.q,
      sort,
      page: query.page,
      pageSize: query.pageSize,
    };
    const result = await this.tagRepo.list(workspace.id, userId, parsed);
    return {
      ...result,
      items: result.items.map((item) =>
        this.wsDataGuard.verifyOwnership(workspace.id, item),
      ),
    };
  }

  async updateTag(
    workspace: WorkspaceRecord,
    userId: string,
    tagId: string,
    patch: UpdateTagData,
  ): Promise<TagRecord> {
    const existing = await this.requireOwnedTag(workspace, userId, tagId);

    const nextName =
      patch.name !== undefined ? sanitizeTagName(patch.name.trim()) : existing.name;
    if (!nextName) throw new BadRequestException("name is required");

    const nextColor =
      patch.color !== undefined ? this.normalizeColor(patch.color) : existing.color;

    const updated = await this.tagRepo.update(workspace.id, tagId, {
      name: nextName,
      color: nextColor,
    });

    if (!updated) throw new NotFoundException("Tag not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, updated);
  }

  async deleteTag(
    workspace: WorkspaceRecord,
    userId: string,
    tagId: string,
  ): Promise<void> {
    await this.requireOwnedTag(workspace, userId, tagId);
    await this.tagRepo.delete(workspace.id, tagId);
  }

  async setTagBookmarks(
    workspace: WorkspaceRecord,
    userId: string,
    tagId: string,
    bookmarkIds: string[],
  ): Promise<TagRecord> {
    await this.requireOwnedTag(workspace, userId, tagId);
    await this.assertBookmarksOwned(workspace.id, userId, bookmarkIds);
    await this.tagRepo.replaceTagBookmarks(
      workspace.id,
      userId,
      tagId,
      bookmarkIds,
    );
    const tag = await this.tagRepo.findById(workspace.id, tagId);
    if (!tag) throw new NotFoundException("Tag not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, tag);
  }

  async addBookmarkToTag(
    workspace: WorkspaceRecord,
    userId: string,
    tagId: string,
    bookmarkId: string,
  ): Promise<TagRecord> {
    await this.requireOwnedTag(workspace, userId, tagId);
    await this.assertBookmarksOwned(workspace.id, userId, [bookmarkId]);
    await this.tagRepo.addBookmarkToTag(workspace.id, userId, tagId, bookmarkId);
    const tag = await this.tagRepo.findById(workspace.id, tagId);
    if (!tag) throw new NotFoundException("Tag not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, tag);
  }

  /** Exposed for integration tests — bookmark with multiple tags. */
  async countTagsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {
    return this.tagRepo.countTagsForBookmark(workspaceId, bookmarkId);
  }

  /** Exposed for integration tests — list tag IDs on a bookmark. */
  async listTagIdsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<string[]> {
    return this.tagRepo.listTagIdsForBookmark(workspaceId, bookmarkId);
  }

  /** Called when a bookmark is hard-deleted to cascade junction rows. */
  async deleteBookmarkTagLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {
    await this.tagRepo.deleteBookmarkTagLinksForBookmark(workspaceId, bookmarkId);
  }

  private normalizeColor(color: string | null | undefined): string | null {
    const normalized = normalizeOptionalColor(color);
    if (normalized) {
      try {
        assertTagColorValid(normalized);
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : "Invalid color",
        );
      }
    }
    return normalized;
  }

  private async requireOwnedTag(
    workspace: WorkspaceRecord,
    userId: string,
    tagId: string,
  ): Promise<TagRecord> {
    const tag = await this.tagRepo.findById(workspace.id, tagId);
    if (!tag) throw new NotFoundException("Tag not found");
    this.wsDataGuard.verifyOwnership(workspace.id, tag);
    if (tag.userId !== userId) {
      throw new ForbiddenException("Tag is not accessible");
    }
    return tag;
  }

  private async assertBookmarksOwned(
    workspaceId: string,
    userId: string,
    bookmarkIds: string[],
  ): Promise<void> {
    for (const bookmarkId of bookmarkIds) {
      const bookmark = await this.bookmarkRepo.findById(workspaceId, bookmarkId);
      if (!bookmark) {
        throw new NotFoundException(`Bookmark not found: ${bookmarkId}`);
      }
      if (bookmark.userId !== userId) {
        throw new ForbiddenException(
          "Only bookmarks you own can be tagged",
        );
      }
    }
  }
}
