import {
  BadRequestException,
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
import { ChooseSlugBodySchema } from "@slugbase/shared-types";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { GoService } from "./go.service.js";
import type { GoResolveResult, EnrichedSlugPreferenceRecord } from "./slug.types.js";

@Controller("go")
@UseGuards(TenantGuard)
export class GoController {
  constructor(@Inject(GoService) private readonly go: GoService) {}

  @Get("preferences")
  @HttpCode(200)
  async listPreferences(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<{
    items: Array<Omit<EnrichedSlugPreferenceRecord, "createdAt"> & { createdAt: string }>;
  }> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    const items = await this.go.listPreferences(workspace, userId);
    return {
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoResolveResult | undefined> {
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
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = ChooseSlugBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Invalid request body");
    }

    const userId = req[TENANT_USER_ID_KEY] as string;
    const result = await this.go.chooseSlugTarget(
      workspace,
      userId,
      slug,
      parsed.data.bookmarkId,
      parsed.data.remember ?? false,
    );
    this.go.recordRedirectAccess(workspace, userId, result.bookmarkId);
    res.redirect(302, result.url);
  }
}
