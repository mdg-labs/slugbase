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
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type {
  CreateBookmarkData,
  ListBookmarksQuery,
  UpdateBookmarkData,
} from "./bookmark.types.js";
import { BookmarksService } from "./bookmarks.service.js";

@Controller("bookmarks")
@UseGuards(TenantGuard)
export class BookmarksController {
  constructor(
    @Inject(BookmarksService) private readonly bookmarks: BookmarksService,
  ) {}

  @Get()
  @HttpCode(200)
  async listBookmarks(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Query() query: ListBookmarksQuery,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bookmarks.listBookmarks(workspace, userId, query);
  }

  @Get("select-all-ids")
  @HttpCode(200)
  async selectAllBookmarkIds(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Query() query: ListBookmarksQuery,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bookmarks.selectAllBookmarkIds(workspace, userId, query);
  }

  @Post()
  @HttpCode(201)
  async createBookmark(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: CreateBookmarkData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bookmarks.createBookmark(workspace, userId, body);
  }

  @Get(":id")
  @HttpCode(200)
  async getBookmark(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bookmarks.getBookmark(workspace, userId, id);
  }

  @Patch(":id")
  @HttpCode(200)
  async updateBookmark(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: UpdateBookmarkData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bookmarks.updateBookmark(workspace, userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteBookmark(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.bookmarks.deleteBookmark(workspace, userId, id);
  }

  @Post(":id/pin")
  @HttpCode(200)
  async togglePin(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { pinned: boolean },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bookmarks.togglePin(workspace, userId, id, body.pinned);
  }

  @Post(":id/access")
  @HttpCode(204)
  recordAccess(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ): void {
    const userId = req[TENANT_USER_ID_KEY] as string;
    this.bookmarks.recordAccess(workspace, userId, id);
  }
}
