import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { DbService } from "../../db/db.service.js";
import { FolderRepository } from "../../folders/folder.repository.js";
import { TagRepository } from "../../tags/tag.repository.js";
import { WorkspaceDataGuard } from "../../workspaces/workspace-data.guard.js";
import type { WorkspaceRecord } from "../../workspaces/workspace.types.js";
import { BookmarkRepository } from "../bookmark.repository.js";
import type { ListBookmarksQuery } from "../bookmark.types.js";
import { BookmarksService } from "../bookmarks.service.js";
import type {
  BulkAddTagsPreviewResult,
  BulkMoveToFolderBody,
  BulkPinBody,
  BulkResult,
  BulkSelectionBody,
  BulkTagsBody,
} from "./bulk.types.js";
import { assertBulkSelection } from "./bulk.validation.js";

interface ResolvedSelection {
  ownedIds: string[];
  skippedIds: string[];
}

@Injectable()
export class BulkBookmarksService {
  private readonly bookmarkRepo: BookmarkRepository;
  private readonly folderRepo: FolderRepository;
  private readonly tagRepo: TagRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(BookmarksService) private readonly bookmarksService: BookmarksService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
  ) {
    const orm = db.getOrm();
    this.bookmarkRepo = new BookmarkRepository(orm);
    this.folderRepo = new FolderRepository(orm);
    this.tagRepo = new TagRepository(orm);
  }

  async bulkDelete(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkSelectionBody,
  ): Promise<BulkResult> {
    const { ownedIds, skippedIds } = await this.resolveSelection(
      workspace,
      userId,
      body,
    );

    for (const bookmarkId of ownedIds) {
      await this.bookmarkRepo.delete(workspace.id, bookmarkId);
    }

    return this.toResult(ownedIds.length, skippedIds);
  }

  async bulkPin(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkPinBody,
  ): Promise<BulkResult> {
    const { ownedIds, skippedIds } = await this.resolveSelection(
      workspace,
      userId,
      body,
    );

    for (const bookmarkId of ownedIds) {
      await this.bookmarkRepo.update(workspace.id, bookmarkId, {
        pinned: body.pinned,
      });
    }

    return this.toResult(ownedIds.length, skippedIds);
  }

  async bulkMoveToFolder(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkMoveToFolderBody,
  ): Promise<BulkResult> {
    await this.requireOwnedFolder(workspace, userId, body.folderId);

    const { ownedIds, skippedIds } = await this.resolveSelection(
      workspace,
      userId,
      body,
    );

    for (const bookmarkId of ownedIds) {
      await this.folderRepo.addBookmarkToFolder(
        workspace.id,
        userId,
        body.folderId,
        bookmarkId,
      );
    }

    return this.toResult(ownedIds.length, skippedIds);
  }

  async bulkAddTags(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkTagsBody,
  ): Promise<BulkResult> {
    await this.requireOwnedTags(workspace, userId, body.tagIds);

    const { ownedIds, skippedIds } = await this.resolveSelection(
      workspace,
      userId,
      body,
    );

    for (const bookmarkId of ownedIds) {
      for (const tagId of body.tagIds) {
        await this.tagRepo.addBookmarkToTag(
          workspace.id,
          userId,
          tagId,
          bookmarkId,
        );
      }
    }

    return this.toResult(ownedIds.length, skippedIds);
  }

  async bulkRemoveTags(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkTagsBody,
  ): Promise<BulkResult> {
    await this.requireOwnedTags(workspace, userId, body.tagIds);

    const { ownedIds, skippedIds } = await this.resolveSelection(
      workspace,
      userId,
      body,
    );

    for (const bookmarkId of ownedIds) {
      for (const tagId of body.tagIds) {
        await this.tagRepo.removeBookmarkFromTag(
          workspace.id,
          tagId,
          bookmarkId,
        );
      }
    }

    return this.toResult(ownedIds.length, skippedIds);
  }

  async previewBulkAddTags(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkTagsBody,
  ): Promise<BulkAddTagsPreviewResult> {
    if (body.tagIds.length === 0) {
      throw new BadRequestException("tagIds must not be empty");
    }
    await this.requireOwnedTags(workspace, userId, body.tagIds);

    const { ownedIds } = await this.resolveSelection(workspace, userId, body);
    const tags = [];

    for (const tagId of body.tagIds) {
      let alreadyTagged = 0;
      for (const bookmarkId of ownedIds) {
        const tagIds = await this.tagRepo.listTagIdsForBookmark(
          workspace.id,
          bookmarkId,
        );
        if (tagIds.includes(tagId)) alreadyTagged += 1;
      }
      tags.push({
        tagId,
        alreadyTagged,
        newlyTagged: ownedIds.length - alreadyTagged,
      });
    }

    return { total: ownedIds.length, tags };
  }

  private async resolveSelection(
    workspace: WorkspaceRecord,
    userId: string,
    body: BulkSelectionBody,
  ): Promise<ResolvedSelection> {
    assertBulkSelection(body);

    let candidateIds: string[];
    if (body.selectAll === true) {
      const listQuery = this.toListQuery(body);
      const result = await this.bookmarksService.selectAllBookmarkIds(
        workspace,
        userId,
        listQuery,
      );
      candidateIds = result.ids;
    } else {
      candidateIds = body.bookmarkIds ?? [];
    }

    const ownedIds: string[] = [];
    const skippedIds: string[] = [];

    for (const bookmarkId of candidateIds) {
      const bookmark = await this.bookmarkRepo.findById(workspace.id, bookmarkId);
      if (!bookmark) {
        skippedIds.push(bookmarkId);
        continue;
      }
      try {
        this.wsDataGuard.verifyOwnership(workspace.id, bookmark);
      } catch {
        skippedIds.push(bookmarkId);
        continue;
      }
      if (bookmark.userId !== userId) {
        skippedIds.push(bookmarkId);
        continue;
      }
      ownedIds.push(bookmarkId);
    }

    return { ownedIds, skippedIds };
  }

  private toListQuery(body: BulkSelectionBody): ListBookmarksQuery {
    return {
      q: body.q,
      folderId: body.folderId,
      tagIds: body.tagIds,
      pinned: body.pinned,
      scope: body.scope,
      sort: body.sort,
    };
  }

  private async requireOwnedFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
  ): Promise<void> {
    const folder = await this.folderRepo.findById(workspace.id, folderId);
    if (!folder) throw new NotFoundException("Folder not found");
    this.wsDataGuard.verifyOwnership(workspace.id, folder);
    if (folder.userId !== userId) {
      throw new ForbiddenException("Only the folder owner may modify this folder");
    }
  }

  private async requireOwnedTags(
    workspace: WorkspaceRecord,
    userId: string,
    tagIds: string[],
  ): Promise<void> {
    if (tagIds.length === 0) {
      throw new BadRequestException("tagIds must not be empty");
    }

    for (const tagId of tagIds) {
      const tag = await this.tagRepo.findById(workspace.id, tagId);
      if (!tag) throw new NotFoundException(`Tag not found: ${tagId}`);
      this.wsDataGuard.verifyOwnership(workspace.id, tag);
      if (tag.userId !== userId) {
        throw new ForbiddenException("Tag is not accessible");
      }
    }
  }

  private toResult(processed: number, skippedIds: string[]): BulkResult {
    return {
      processed,
      skipped: skippedIds.length,
      skippedIds,
    };
  }
}
