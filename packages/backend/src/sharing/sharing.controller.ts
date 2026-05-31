import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { GrantShareData } from "./sharing.types.js";
import { SharingService } from "./sharing.service.js";

@Controller("sharing")
@UseGuards(TenantGuard)
export class SharingController {
  constructor(@Inject(SharingService) private readonly sharing: SharingService) {}

  @Get("targets")
  @HttpCode(200)
  async listShareTargets(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.sharing.listShareTargets(workspace, userId);
  }

  @Get("bookmarks/:id")
  @HttpCode(200)
  async listBookmarkShares(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") bookmarkId: string,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    const grants = await this.sharing.listBookmarkShares(
      workspace,
      userId,
      bookmarkId,
    );
    return { grants };
  }

  @Post("bookmarks/:id/grants")
  @HttpCode(201)
  async grantBookmarkShare(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") bookmarkId: string,
    @Body() body: GrantShareData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.sharing.grantBookmarkShare(workspace, userId, bookmarkId, body);
  }

  @Delete("bookmarks/:id/grants/:grantId")
  @HttpCode(204)
  async revokeBookmarkShare(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") bookmarkId: string,
    @Param("grantId") grantId: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.sharing.revokeBookmarkShare(workspace, userId, bookmarkId, grantId);
  }

  @Get("folders/:id")
  @HttpCode(200)
  async listFolderShares(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") folderId: string,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    const grants = await this.sharing.listFolderShares(workspace, userId, folderId);
    return { grants };
  }

  @Post("folders/:id/grants")
  @HttpCode(201)
  async grantFolderShare(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") folderId: string,
    @Body() body: GrantShareData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.sharing.grantFolderShare(workspace, userId, folderId, body);
  }

  @Delete("folders/:id/grants/:grantId")
  @HttpCode(204)
  async revokeFolderShare(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") folderId: string,
    @Param("grantId") grantId: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.sharing.revokeFolderShare(workspace, userId, folderId, grantId);
  }
}
