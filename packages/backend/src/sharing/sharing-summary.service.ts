import { Inject, Injectable } from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import type { BookmarkRecord } from "../bookmarks/bookmark.types.js";
import {
  assembleBookmarkSharingSummary,
  groupDirectShares,
  groupViaFolderShares,
  pickAccessPaths,
} from "./sharing-summary.assembler.js";
import { SharingRepository } from "./sharing.repository.js";
import type { BookmarkSharingSummary } from "./sharing.types.js";

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
}
