import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import type { MailService, MailSettings } from "@slugbase/shared-types";

import { MAIL } from "../mail/mail.tokens.js";
import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { MailSettingsService } from "./mail-settings.service.js";
import type { UpdateMailSettingsBody, SendTestMailBody } from "@slugbase/shared-types";

/**
 * Exposes GET/PATCH /workspace/settings/mail and POST /workspace/settings/mail/test.
 *
 * All endpoints require an active workspace session and ADMIN role (spec §11.5, §15).
 * CSRF is enforced globally on all mutations (PATCH, POST) - no explicit decorator needed.
 */
@Controller("workspace/settings/mail")
@UseGuards(TenantGuard)
export class MailSettingsController {
  constructor(
    @Inject(MailSettingsService) private readonly mailSettings: MailSettingsService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(MAIL) private readonly mail: MailService,
  ) {}

  @Get()
  @HttpCode(200)
  async getSettings(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<MailSettings> {
    await this.requireAdmin(workspace.id, req);
    return this.mailSettings.getSettings();
  }

  @Patch()
  @HttpCode(200)
  async updateSettings(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: UpdateMailSettingsBody,
  ): Promise<MailSettings> {
    await this.requireAdmin(workspace.id, req);
    return this.mailSettings.updateSettings(body);
  }

  @Post("test")
  @HttpCode(204)
  async sendTest(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: SendTestMailBody,
  ): Promise<void> {
    await this.requireAdmin(workspace.id, req);

    if (!this.mail.isAvailable()) {
      throw new ServiceUnavailableException(
        "Mail transport is not configured. Update SMTP settings first.",
      );
    }

    await this.mail.sendTest(body.to);
  }

  private async requireAdmin(workspaceId: string, req: Request & Record<string, unknown>): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, "ADMIN");
  }
}
