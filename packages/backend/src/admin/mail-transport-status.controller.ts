import { Controller, Get, HttpCode, Inject, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { MailService } from "@slugbase/shared-types";
import type { MailTransportStatus } from "@slugbase/shared-types";

import { MAIL } from "../mail/mail.tokens.js";
import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";

/**
 * Exposes GET /workspace/settings/mail/status.
 *
 * Read-only availability signal for Members settings invite UI (spec §11.1, §10.1).
 * Returns no SMTP credentials or host details.
 */
@Controller("workspace/settings/mail")
@UseGuards(TenantGuard)
export class MailTransportStatusController {
  constructor(
    @Inject(MAIL) private readonly mail: MailService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @Get("status")
  @HttpCode(200)
  async getStatus(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<MailTransportStatus> {
    await this.requireAdmin(workspace.id, req);
    const mailTransportAvailable = await this.mail.ensureAvailable();
    return { mailTransportAvailable };
  }

  private async requireAdmin(workspaceId: string, req: Request & Record<string, unknown>): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, "ADMIN");
  }
}
