import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { BookmarkRepository } from "../bookmarks/bookmark.repository.js";
import { DbService } from "../db/db.service.js";
import { FolderRepository } from "../folders/folder.repository.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { SharingRepository } from "./sharing.repository.js";

export type ShareTargetKind = "user" | "team";

@Injectable()
export class SharingService {
  private readonly sharingRepo: SharingRepository;
  private readonly bookmarkRepo: BookmarkRepository;
  private readonly folderRepo: FolderRepository;

  constructor(@Inject(DbService) db: DbService) {
    const orm = db.getOrm();
    const dialect = db.dialect;
    this.sharingRepo = new SharingRepository(orm, dialect);
    this.bookmarkRepo = new BookmarkRepository(orm, dialect);
    this.folderRepo = new FolderRepository(orm, dialect);
  }

  async shareBookmarkWithUser(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
    granteeUserId: string,
  ): Promise<void> {
    await this.requireBookmarkOwner(workspace.id, ownerUserId, bookmarkId);
    await this.sharingRepo.grantBookmarkUserShare(
      workspace.id,
      bookmarkId,
      granteeUserId,
    );
  }

  async shareBookmarkWithTeam(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
    teamId: string,
  ): Promise<void> {
    await this.requireBookmarkOwner(workspace.id, ownerUserId, bookmarkId);
    await this.sharingRepo.grantBookmarkTeamShare(workspace.id, bookmarkId, teamId);
  }

  async shareFolderWithUser(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
    granteeUserId: string,
  ): Promise<void> {
    await this.requireFolderOwner(workspace.id, ownerUserId, folderId);
    await this.sharingRepo.grantFolderUserShare(workspace.id, folderId, granteeUserId);
  }

  async shareFolderWithTeam(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
    teamId: string,
  ): Promise<void> {
    await this.requireFolderOwner(workspace.id, ownerUserId, folderId);
    await this.sharingRepo.grantFolderTeamShare(workspace.id, folderId, teamId);
  }

  private async requireBookmarkOwner(
    workspaceId: string,
    userId: string,
    bookmarkId: string,
  ): Promise<void> {
    const bookmark = await this.bookmarkRepo.findById(workspaceId, bookmarkId);
    if (!bookmark) throw new NotFoundException("Bookmark not found");
    if (bookmark.userId !== userId) {
      throw new ForbiddenException("Only the bookmark owner may share this bookmark");
    }
  }

  private async requireFolderOwner(
    workspaceId: string,
    userId: string,
    folderId: string,
  ): Promise<void> {
    const folder = await this.folderRepo.findById(workspaceId, folderId);
    if (!folder) throw new NotFoundException("Folder not found");
    if (folder.userId !== userId) {
      throw new ForbiddenException("Only the folder owner may share this folder");
    }
  }
}
