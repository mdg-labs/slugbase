import { Inject, Injectable } from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import type { BookmarkRecord } from "../bookmarks/bookmark.types.js";
import {
  assembleBookmarkSharingSummary,
  assembleFolderSharingSummary,
  groupDirectFolderShares,
  groupDirectShares,
  groupViaFolderShares,
  pickAccessPaths,
  pickFolderAccessPaths,
} from "./sharing-summary.assembler.js";
import { SharingRepository } from "./sharing.repository.js";
import type { BookmarkSharingSummary, FolderSharingSummary } from "./sharing.types.js";

@Injectable()
export class SharingSummaryService {
  private readonly sharingRepo: SharingRepository;

  constructor(@Inject(DbService) db: DbService) {
    this.sharingRepo = new SharingRepository(db.getOrm());
  }

  async assembleForBookmarkList(
    workspaceId: string,
    viewerUserId: string,
    bookmarks: BookmarkRecord[],
  ): Promise<Map<string, BookmarkSharingSummary>> {
    if (bookmarks.length === 0) {
      return new Map();
    }

    const ownedBookmarkIds = bookmarks
      .filter((bookmark) => bookmark.userId === viewerUserId)
      .map((bookmark) => bookmark.id);
    const sharedBookmarkRefs = bookmarks
      .filter((bookmark) => bookmark.userId !== viewerUserId)
      .map((bookmark) => ({
        bookmarkId: bookmark.id,
        ownerUserId: bookmark.userId,
      }));

    const [directRows, viaFolderRows, accessPathCandidates] = await Promise.all([
      ownedBookmarkIds.length > 0
        ? this.sharingRepo.batchListDirectBookmarkShares(workspaceId, ownedBookmarkIds)
        : Promise.resolve([]),
      ownedBookmarkIds.length > 0
        ? this.sharingRepo.batchListFolderTransitiveShares(workspaceId, ownedBookmarkIds)
        : Promise.resolve([]),
      sharedBookmarkRefs.length > 0
        ? this.sharingRepo.batchResolveAccessPaths(
            workspaceId,
            viewerUserId,
            sharedBookmarkRefs,
          )
        : Promise.resolve([]),
    ]);

    const directByBookmark = groupDirectShares(directRows);
    const viaFoldersByBookmark = groupViaFolderShares(viaFolderRows);
    const accessPathsByBookmark = pickAccessPaths(accessPathCandidates);

    const summaries = new Map<string, BookmarkSharingSummary>();
    for (const bookmark of bookmarks) {
      summaries.set(
        bookmark.id,
        assembleBookmarkSharingSummary(
          bookmark.id,
          bookmark.userId,
          viewerUserId,
          directByBookmark,
          viaFoldersByBookmark,
          accessPathsByBookmark,
        ),
      );
    }

    return summaries;
  }

  async assembleForFolderList(
    workspaceId: string,
    viewerUserId: string,
    folders: Array<{ id: string; userId: string }>,
  ): Promise<Map<string, FolderSharingSummary>> {
    if (folders.length === 0) {
      return new Map();
    }

    const ownedFolderIds = folders
      .filter((folder) => folder.userId === viewerUserId)
      .map((folder) => folder.id);
    const sharedFolderRefs = folders
      .filter((folder) => folder.userId !== viewerUserId)
      .map((folder) => ({
        folderId: folder.id,
        ownerUserId: folder.userId,
      }));

    const [directRows, accessPathCandidates] = await Promise.all([
      ownedFolderIds.length > 0
        ? this.sharingRepo.batchListDirectFolderShares(workspaceId, ownedFolderIds)
        : Promise.resolve([]),
      sharedFolderRefs.length > 0
        ? this.sharingRepo.batchResolveFolderAccessPaths(
            workspaceId,
            viewerUserId,
            sharedFolderRefs,
          )
        : Promise.resolve([]),
    ]);

    const directByFolder = groupDirectFolderShares(directRows);
    const accessPathsByFolder = pickFolderAccessPaths(accessPathCandidates);

    const summaries = new Map<string, FolderSharingSummary>();
    for (const folder of folders) {
      summaries.set(
        folder.id,
        assembleFolderSharingSummary(
          folder.id,
          folder.userId,
          viewerUserId,
          directByFolder,
          accessPathsByFolder,
        ),
      );
    }

    return summaries;
  }
}
