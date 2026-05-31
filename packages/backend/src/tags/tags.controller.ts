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
import type { CreateTagData, ListTagsQuery, UpdateTagData } from "./tag.types.js";
import { TagsService } from "./tags.service.js";

@Controller("tags")
@UseGuards(TenantGuard)
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @Post()
  @HttpCode(201)
  async createTag(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: CreateTagData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.tags.createTag(workspace, userId, body);
  }

  @Get()
  @HttpCode(200)
  async listTags(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Query() query: ListTagsQuery,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.tags.listTags(workspace, userId, query);
  }

  @Get(":id")
  @HttpCode(200)
  async getTag(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.tags.getTag(workspace, userId, id);
  }

  @Patch(":id")
  @HttpCode(200)
  async updateTag(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: UpdateTagData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.tags.updateTag(workspace, userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteTag(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.tags.deleteTag(workspace, userId, id);
  }

  @Put(":id/bookmarks")
  @HttpCode(200)
  async setTagBookmarks(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { bookmarkIds: string[] },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.tags.setTagBookmarks(workspace, userId, id, body.bookmarkIds);
  }

  @Post(":id/bookmarks")
  @HttpCode(200)
  async addBookmarkToTag(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { bookmarkId: string },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.tags.addBookmarkToTag(workspace, userId, id, body.bookmarkId);
  }
}
