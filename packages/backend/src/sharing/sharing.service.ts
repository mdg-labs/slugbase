import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { AccountsService } from "../accounts/accounts.service.js";
import { BookmarkRepository } from "../bookmarks/bookmark.repository.js";
import { DbService } from "../db/db.service.js";
import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { FolderRepository } from "../folders/folder.repository.js";
import { GoService } from "../slugs/go.service.js";
import { TeamRepository } from "../teams/team.repository.js";
import { WorkspaceDataGuard } from "../common/tenant/index.js";
import { WorkspaceMembersService } from "../workspaces/workspace-members.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { assertTeamSharingEntitlement } from "./sharing.entitlements.js";
import { SharingRepository } from "./sharing.repository.js";
import type {
  GrantShareData,
  ShareGrantRecord,
  ShareTargetsRecord,
} from "./sharing.types.js";

@Injectable()
export class SharingService {
  private readonly sharingRepo: SharingRepository;
  private readonly bookmarkRepo: BookmarkRepository;
  private readonly folderRepo: FolderRepository;
  private readonly teamRepo: TeamRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
    @Inject(WorkspaceMembersService)
    private readonly workspaceMembers: WorkspaceMembersService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(GoService) private readonly goService: GoService,
  ) {
    const orm = db.getOrm();
    this.sharingRepo = new SharingRepository(orm);
    this.bookmarkRepo = new BookmarkRepository(orm);
    this.folderRepo = new FolderRepository(orm);
    this.teamRepo = new TeamRepository(orm);
  }

  async listShareTargets(
    workspace: WorkspaceRecord,
    requesterUserId: string,
  ): Promise<ShareTargetsRecord> {
    assertTeamSharingEntitlement(this.entitlements, workspace);
    await this.workspaceMembers.getMember(workspace.id, requesterUserId);

    const [members, teamsPage] = await Promise.all([
      this.workspaceMembers.listMembers(workspace.id),
      this.teamRepo.list(workspace.id, {
        sort: "name-asc",
        page: 1,
        pageSize: 100,
      }),
    ]);

    const memberProfiles = await Promise.all(
      members
        .filter((member) => member.userId !== requesterUserId)
        .map(async (member) => {
          const account = await this.accounts.findById(member.userId);
          return {
            userId: member.userId,
            name: account?.name ?? member.userId,
            email: account?.email ?? "",
          };
        }),
    );

    return {
      members: memberProfiles,
      teams: teamsPage.items.map((team) => ({
        id: team.id,
        name: team.name,
        memberCount: team.memberCount,
      })),
    };
  }

  async listBookmarkShares(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
  ): Promise<ShareGrantRecord[]> {
    await this.requireBookmarkOwner(workspace.id, ownerUserId, bookmarkId);
    return this.sharingRepo.listBookmarkShares(workspace.id, bookmarkId);
  }

  async grantBookmarkShare(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
    dto: GrantShareData,
  ): Promise<ShareGrantRecord> {
    assertTeamSharingEntitlement(this.entitlements, workspace);
    await this.requireBookmarkOwner(workspace.id, ownerUserId, bookmarkId);
    await this.assertShareTarget(workspace.id, ownerUserId, dto);

    if (dto.kind === "user") {
      await this.sharingRepo.grantBookmarkUserShare(
        workspace.id,
        bookmarkId,
        dto.targetId,
      );
    } else {
      await this.sharingRepo.grantBookmarkTeamShare(
        workspace.id,
        bookmarkId,
        dto.targetId,
      );
    }

    const grants = await this.sharingRepo.listBookmarkShares(workspace.id, bookmarkId);
    const created = grants.find(
      (grant) => grant.kind === dto.kind && grant.targetId === dto.targetId,
    );
    if (!created) {
      throw new NotFoundException("Share grant was not created");
    }
    return created;
  }

  async revokeBookmarkShare(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
    grantId: string,
  ): Promise<void> {
    await this.requireBookmarkOwner(workspace.id, ownerUserId, bookmarkId);
    const [bookmark, grants] = await Promise.all([
      this.bookmarkRepo.findById(workspace.id, bookmarkId),
      this.sharingRepo.listBookmarkShares(workspace.id, bookmarkId),
    ]);
    const grant = grants.find((entry) => entry.id === grantId);
    const removed = await this.sharingRepo.revokeBookmarkShare(
      workspace.id,
      bookmarkId,
      grantId,
    );
    if (!removed) {
      throw new NotFoundException("Share grant not found");
    }
    if (grant?.kind === "user") {
      await this.goService.reEvaluateAfterShareRevoke(
        workspace.id,
        grant.targetId,
        bookmark?.slug ?? null,
      );
    }
  }

  async listFolderShares(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
  ): Promise<ShareGrantRecord[]> {
    await this.requireFolderOwner(workspace.id, ownerUserId, folderId);
    return this.sharingRepo.listFolderShares(workspace.id, folderId);
  }

  async grantFolderShare(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
    dto: GrantShareData,
  ): Promise<ShareGrantRecord> {
    assertTeamSharingEntitlement(this.entitlements, workspace);
    await this.requireFolderOwner(workspace.id, ownerUserId, folderId);
    await this.assertShareTarget(workspace.id, ownerUserId, dto);

    if (dto.kind === "user") {
      await this.sharingRepo.grantFolderUserShare(
        workspace.id,
        folderId,
        dto.targetId,
      );
    } else {
      await this.sharingRepo.grantFolderTeamShare(
        workspace.id,
        folderId,
        dto.targetId,
      );
    }

    const grants = await this.sharingRepo.listFolderShares(workspace.id, folderId);
    const created = grants.find(
      (grant) => grant.kind === dto.kind && grant.targetId === dto.targetId,
    );
    if (!created) {
      throw new NotFoundException("Share grant was not created");
    }
    return created;
  }

  async revokeFolderShare(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
    grantId: string,
  ): Promise<void> {
    await this.requireFolderOwner(workspace.id, ownerUserId, folderId);
    const removed = await this.sharingRepo.revokeFolderShare(
      workspace.id,
      folderId,
      grantId,
    );
    if (!removed) {
      throw new NotFoundException("Share grant not found");
    }
  }

  async shareBookmarkWithUser(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
    granteeUserId: string,
  ): Promise<void> {
    await this.grantBookmarkShare(workspace, ownerUserId, bookmarkId, {
      kind: "user",
      targetId: granteeUserId,
    });
  }

  async shareBookmarkWithTeam(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    bookmarkId: string,
    teamId: string,
  ): Promise<void> {
    await this.grantBookmarkShare(workspace, ownerUserId, bookmarkId, {
      kind: "team",
      targetId: teamId,
    });
  }

  async shareFolderWithUser(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
    granteeUserId: string,
  ): Promise<void> {
    await this.grantFolderShare(workspace, ownerUserId, folderId, {
      kind: "user",
      targetId: granteeUserId,
    });
  }

  async shareFolderWithTeam(
    workspace: WorkspaceRecord,
    ownerUserId: string,
    folderId: string,
    teamId: string,
  ): Promise<void> {
    await this.grantFolderShare(workspace, ownerUserId, folderId, {
      kind: "team",
      targetId: teamId,
    });
  }

  private async assertShareTarget(
    workspaceId: string,
    ownerUserId: string,
    dto: GrantShareData,
  ): Promise<void> {
    if (dto.kind === "user") {
      if (dto.targetId === ownerUserId) {
        throw new BadRequestException("Cannot share a resource with yourself");
      }
      await this.workspaceMembers.getMember(workspaceId, dto.targetId);
      return;
    }

    const team = await this.teamRepo.findById(workspaceId, dto.targetId);
    if (!team) {
      throw new NotFoundException("Team not found");
    }
  }

  private async requireBookmarkOwner(
    workspaceId: string,
    userId: string,
    bookmarkId: string,
  ): Promise<void> {
    const bookmark = await this.bookmarkRepo.findById(workspaceId, bookmarkId);
    if (!bookmark) throw new NotFoundException("Bookmark not found");
    this.wsDataGuard.verifyOwnership(workspaceId, bookmark);
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
    this.wsDataGuard.verifyOwnership(workspaceId, folder);
    if (folder.userId !== userId) {
      throw new ForbiddenException("Only the folder owner may share this folder");
    }
  }
}
