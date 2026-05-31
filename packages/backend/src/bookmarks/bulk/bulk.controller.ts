import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../../workspaces/workspace.types.js";
import type {
  BulkMoveToFolderBody,
  BulkPinBody,
  BulkSelectionBody,
  BulkTagsBody,
} from "./bulk.types.js";
import { BulkBookmarksService } from "./bulk.service.js";

@Controller("bookmarks/bulk")
@UseGuards(TenantGuard)
export class BulkBookmarksController {
  constructor(
    @Inject(BulkBookmarksService) private readonly bulk: BulkBookmarksService,
  ) {}

  @Post("delete")
  @HttpCode(200)
  async bulkDelete(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: BulkSelectionBody,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bulk.bulkDelete(workspace, userId, body);
  }

  @Post("pin")
  @HttpCode(200)
  async bulkPin(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: BulkPinBody,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bulk.bulkPin(workspace, userId, body);
  }

  @Post("move-to-folder")
  @HttpCode(200)
  async bulkMoveToFolder(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: BulkMoveToFolderBody,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bulk.bulkMoveToFolder(workspace, userId, body);
  }

  @Post("add-tags")
  @HttpCode(200)
  async bulkAddTags(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: BulkTagsBody,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bulk.bulkAddTags(workspace, userId, body);
  }

  @Post("add-tags/preview")
  @HttpCode(200)
  async previewBulkAddTags(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: BulkTagsBody,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bulk.previewBulkAddTags(workspace, userId, body);
  }

  @Post("remove-tags")
  @HttpCode(200)
  async bulkRemoveTags(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: BulkTagsBody,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.bulk.bulkRemoveTags(workspace, userId, body);
  }
}
