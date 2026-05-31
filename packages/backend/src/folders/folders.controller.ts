import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { CreateFolderData, ListFoldersQuery, UpdateFolderData } from "./folder.types.js";
import { FoldersService } from "./folders.service.js";

@Controller("folders")
@UseGuards(TenantGuard)
export class FoldersController {
  constructor(@Inject(FoldersService) private readonly folders: FoldersService) {}

  @Post()
  @HttpCode(201)
  async createFolder(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: CreateFolderData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.folders.createFolder(workspace, userId, body);
  }

  @Get()
  @HttpCode(200)
  async listFolders(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Query() query: ListFoldersQuery,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.folders.listFolders(workspace, userId, query);
  }

  @Get(":id")
  @HttpCode(200)
  async getFolder(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.folders.getFolder(workspace, userId, id);
  }

  @Patch(":id")
  @HttpCode(200)
  async updateFolder(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: UpdateFolderData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.folders.updateFolder(workspace, userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteFolder(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.folders.deleteFolder(workspace, userId, id);
  }

  @Put(":id/bookmarks")
  @HttpCode(200)
  async setFolderBookmarks(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { bookmarkIds: string[] },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.folders.setFolderBookmarks(workspace, userId, id, body.bookmarkIds);
  }

  @Post(":id/bookmarks")
  @HttpCode(200)
  async addBookmarkToFolder(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { bookmarkId: string },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.folders.addBookmarkToFolder(workspace, userId, id, body.bookmarkId);
  }
}
