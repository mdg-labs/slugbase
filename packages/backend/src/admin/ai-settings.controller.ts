import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import type { AiSettings } from "@slugbase/shared-types";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { AiSettingsService } from "./ai-settings.service.js";
import type { UpdateAiSettingsBody } from "@slugbase/shared-types";

/**
 * Exposes GET/PATCH /workspace/settings/ai.
 *
 * All endpoints require an active workspace session and ADMIN role (spec §11.2, §15).
 * CSRF is enforced globally on mutations - no explicit decorator needed.
 */
@Controller("workspace/settings/ai")
@UseGuards(TenantGuard)
export class AiSettingsController {
  constructor(
    @Inject(AiSettingsService) private readonly aiSettings: AiSettingsService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  @HttpCode(200)
  async getSettings(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<AiSettings> {
    await this.requireAdmin(workspace.id, req);
    return this.aiSettings.getSettings();
  }

  @Patch()
  @HttpCode(200)
  async updateSettings(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: UpdateAiSettingsBody,
  ): Promise<AiSettings> {
    await this.requireAdmin(workspace.id, req);
    return this.aiSettings.updateSettings(body);
  }

  private async requireAdmin(workspaceId: string, req: Request & Record<string, unknown>): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, "ADMIN");
  }
}
