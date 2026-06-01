import { Inject, Injectable } from "@nestjs/common";

import { DbService } from "../../db/db.service.js";
import { SharingRepository } from "../../sharing/sharing.repository.js";

@Injectable()
export class AuthzService {
  private readonly sharingRepo: SharingRepository;

  constructor(@Inject(DbService) db: DbService) {
    this.sharingRepo = new SharingRepository(db.getOrm());
  }

  async canReadBookmark(
    workspaceId: string,
    userId: string,
    bookmarkId: string,
    ownerUserId: string,
  ): Promise<boolean> {
    if (ownerUserId === userId) return true;
    return this.sharingRepo.canReadBookmark(workspaceId, userId, bookmarkId);
  }

  canWriteBookmark(ownerUserId: string, userId: string): boolean {
    return ownerUserId === userId;
  }

  async canReadFolder(
    workspaceId: string,
    userId: string,
    folderId: string,
    ownerUserId: string,
  ): Promise<boolean> {
    if (ownerUserId === userId) return true;
    return this.sharingRepo.canReadFolder(workspaceId, userId, folderId);
  }

  canWriteFolder(ownerUserId: string, userId: string): boolean {
    return ownerUserId === userId;
  }
}
