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
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { GoService } from "./go.service.js";
import type { SlugPreferenceRecord } from "./slug.types.js";

@Controller("go")
@UseGuards(TenantGuard)
export class GoController {
  constructor(@Inject(GoService) private readonly go: GoService) {}

  @Get("preferences")
  @HttpCode(200)
  async listPreferences(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<{ items: SlugPreferenceRecord[] }> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    const items = await this.go.listPreferences(workspace, userId);
    return {
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt,
      })),
    };
  }

  @Delete("preferences/:id")
  @HttpCode(204)
  async removePreference(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.go.removePreference(workspace, userId, id);
  }

  @Get(":slug")
  async resolveSlug(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("slug") slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    const result = await this.go.resolveSlug(workspace, userId, slug);

    if (result.kind === "redirect") {
      this.go.recordRedirectAccess(workspace, userId, result.bookmarkId);
      res.redirect(302, result.url);
      return;
    }

    res.status(200).json(result);
  }

  @Post(":slug/choose")
  async chooseSlugTarget(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("slug") slug: string,
    @Res() res: Response,
    @Body() body: { bookmarkId: string; remember?: boolean },
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    const result = await this.go.chooseSlugTarget(
      workspace,
      userId,
      slug,
      body.bookmarkId,
      body.remember ?? false,
    );
    this.go.recordRedirectAccess(workspace, userId, result.bookmarkId);
    res.redirect(302, result.url);
  }
}
