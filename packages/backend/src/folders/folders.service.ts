import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { BookmarkRepository } from "../bookmarks/bookmark.repository.js";
import { AuthzService } from "../common/authz/authz.service.js";
import { DbService } from "../db/db.service.js";
import { WorkspaceDataGuard } from "../workspaces/workspace-data.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { FolderRepository } from "./folder.repository.js";
import type {
  CreateFolderData,
  FolderRecord,
  ListFoldersQuery,
  ParsedListFoldersQuery,
  PaginatedFolders,
  UpdateFolderData,
} from "./folder.types.js";
import {
  assertFolderIconValid,
  normalizeOptionalIcon,
  parseFolderScope,
  parseFolderSort,
  sanitizeFolderName,
} from "./folder.validation.js";

@Injectable()
export class FoldersService {
  private readonly folderRepo: FolderRepository;
  private readonly bookmarkRepo: BookmarkRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
    @Inject(AuthzService) private readonly authz: AuthzService,
  ) {
    this.folderRepo = new FolderRepository(db.getOrm());
    this.bookmarkRepo = new BookmarkRepository(db.getOrm());
  }

  async createFolder(
    workspace: WorkspaceRecord,
    userId: string,
    dto: CreateFolderData,
  ): Promise<FolderRecord> {
    const name = sanitizeFolderName(dto.name.trim());
    if (!name) throw new BadRequestException("name is required");

    const icon = this.normalizeIcon(dto.icon);
    const color = this.normalizeColor(dto.color);
    if (dto.bookmarkIds?.length) {
      await this.assertBookmarksOwned(workspace.id, userId, dto.bookmarkIds);
    }

    const folder = await this.folderRepo.create(workspace.id, userId, {
      name,
      icon,
      color,
      bookmarkIds: dto.bookmarkIds,
    });
    return this.wsDataGuard.verifyOwnership(workspace.id, folder);
  }

  async getFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
  ): Promise<FolderRecord> {
    const folder = await this.requireReadableFolder(workspace, userId, folderId);
    return this.wsDataGuard.verifyOwnership(workspace.id, folder);
  }

  async listFolders(
    workspace: WorkspaceRecord,
    userId: string,
    query: ListFoldersQuery,
  ): Promise<PaginatedFolders> {
    let scope;
    let sort;
    try {
      scope = parseFolderScope(query.scope);
      sort = parseFolderSort(query.sort);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid list query",
      );
    }

    const parsed: ParsedListFoldersQuery = {
      q: query.q,
      scope,
      sort,
      page: query.page,
      pageSize: query.pageSize,
    };
    const result = await this.folderRepo.list(workspace.id, userId, parsed);
    return {
      ...result,
      items: result.items.map((item) =>
        this.wsDataGuard.verifyOwnership(workspace.id, item),
      ),
    };
  }

  async updateFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
    patch: UpdateFolderData,
  ): Promise<FolderRecord> {
    const existing = await this.requireOwnedFolder(workspace, userId, folderId);

    const nextName =
      patch.name !== undefined
        ? sanitizeFolderName(patch.name.trim())
        : existing.name;
    if (!nextName) throw new BadRequestException("name is required");

    const nextIcon =
      patch.icon !== undefined ? this.normalizeIcon(patch.icon) : existing.icon;
    const nextColor =
      patch.color !== undefined ? this.normalizeColor(patch.color) : existing.color;

    const updated = await this.folderRepo.update(workspace.id, folderId, {
      name: nextName,
      icon: nextIcon,
      color: nextColor,
    });

    if (!updated) throw new NotFoundException("Folder not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, updated);
  }

  async deleteFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
  ): Promise<void> {
    await this.requireOwnedFolder(workspace, userId, folderId);
    await this.folderRepo.delete(workspace.id, folderId);
  }

  async setFolderBookmarks(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
    bookmarkIds: string[],
  ): Promise<FolderRecord> {
    await this.requireOwnedFolder(workspace, userId, folderId);
    await this.assertBookmarksOwned(workspace.id, userId, bookmarkIds);
    await this.folderRepo.replaceFolderBookmarks(
      workspace.id,
      userId,
      folderId,
      bookmarkIds,
    );
    const folder = await this.folderRepo.findById(workspace.id, folderId);
    if (!folder) throw new NotFoundException("Folder not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, folder);
  }

  async addBookmarkToFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
    bookmarkId: string,
  ): Promise<FolderRecord> {
    await this.requireOwnedFolder(workspace, userId, folderId);
    await this.assertBookmarksOwned(workspace.id, userId, [bookmarkId]);
    await this.folderRepo.addBookmarkToFolder(
      workspace.id,
      userId,
      folderId,
      bookmarkId,
    );
    const folder = await this.folderRepo.findById(workspace.id, folderId);
    if (!folder) throw new NotFoundException("Folder not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, folder);
  }

  /** Exposed for integration tests - bookmark in multiple folders. */
  async countFoldersForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<number> {
    return this.folderRepo.countFoldersForBookmark(workspaceId, bookmarkId);
  }

  /** Exposed for integration tests - list folder IDs containing a bookmark. */
  async listFolderIdsForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<string[]> {
    return this.folderRepo.listFolderIdsForBookmark(workspaceId, bookmarkId);
  }

  /** Called when a bookmark is hard-deleted to cascade junction rows. */
  async deleteBookmarkFolderLinksForBookmark(
    workspaceId: string,
    bookmarkId: string,
  ): Promise<void> {
    await this.folderRepo.deleteBookmarkFolderLinksForBookmark(
      workspaceId,
      bookmarkId,
    );
  }

  private normalizeIcon(icon: string | null | undefined): string | null {
    const normalized = normalizeOptionalIcon(icon);
    if (normalized) {
      try {
        assertFolderIconValid(normalized);
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : "Invalid icon",
        );
      }
    }
    return normalized;
  }

  private normalizeColor(color: string | null | undefined): string | null {
    if (color === null || color === undefined) return null;
    const trimmed = color.trim();
    if (!trimmed) return null;
    if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
      throw new BadRequestException(
        "Invalid color format - expected hex color e.g. #7782f7",
      );
    }
    return trimmed.toLowerCase();
  }

  private async requireOwnedFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
  ): Promise<FolderRecord> {
    const folder = await this.folderRepo.findById(workspace.id, folderId);
    if (!folder) throw new NotFoundException("Folder not found");
    this.wsDataGuard.verifyOwnership(workspace.id, folder);
    if (folder.userId !== userId) {
      throw new ForbiddenException("Only the folder owner may modify this folder");
    }
    return folder;
  }

  private async requireReadableFolder(
    workspace: WorkspaceRecord,
    userId: string,
    folderId: string,
  ): Promise<FolderRecord> {
    const folder = await this.folderRepo.findById(workspace.id, folderId);
    if (!folder) throw new NotFoundException("Folder not found");
    this.wsDataGuard.verifyOwnership(workspace.id, folder);
    const canRead = await this.authz.canReadFolder(
      workspace.id,
      userId,
      folderId,
      folder.userId,
    );
    if (!canRead) {
      throw new ForbiddenException("Folder is not accessible");
    }
    return folder;
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
          "Only bookmarks you own can be added to your folders",
        );
      }
    }
  }
}
