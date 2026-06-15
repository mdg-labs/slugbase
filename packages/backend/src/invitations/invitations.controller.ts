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
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";

import { SkipCsrf } from "../auth/csrf/skip-csrf.decorator.js";
import { IpThrottlerGuard } from "../auth/rate-limit/ip-throttler.guard.js";
import { ConfigService } from "../config/config.service.js";
import { SESSION_COOKIE } from "../sessions/session-constants.js";
import { SESSION_USER_ID_KEY, SessionGuard } from "../sessions/session.guard.js";
import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import type { AcceptInvitationDto, CreateInvitationDto, InvitationMetadata, PendingInvitationView } from "./invitations.service.js";
import { InvitationsService } from "./invitations.service.js";
import type { WorkspaceInvitationRecord } from "./invitation.types.js";

@Controller()
export class InvitationsController {
  constructor(
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /**
   * Creates a workspace invitation and sends an email with a magic link.
   * Requires an authenticated session with OWNER or ADMIN role in the workspace.
   * Entitlement check: free plan workspaces return 403 (spec §12.2, §4.2).
   */
  @Post("workspaces/:id/invitations")
  @HttpCode(201)
  @UseGuards(SessionGuard)
  async createInvitation(
    @Param("id") workspaceId: string,
    @Body() body: CreateInvitationDto,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceInvitationRecord> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspaceId, userId, "ADMIN");
    return this.invitations.createInvitation(workspaceId, userId, body);
  }

  @Get("workspace/invitations")
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async listPendingInvitations(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<PendingInvitationView[]> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.invitations.listPendingInvitations(workspace.id, userId);
  }

  @Post("workspace/invitations/:id/resend")
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async resendInvitation(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") invitationId: string,
  ): Promise<PendingInvitationView> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.invitations.resendInvitation(workspace.id, invitationId, userId);
  }

  @Delete("workspace/invitations/:id")
  @HttpCode(204)
  @UseGuards(TenantGuard)
  async revokeInvitation(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") invitationId: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.invitations.revokeInvitation(workspace.id, invitationId, userId);
  }

  /**
   * Returns invitation metadata (workspace name, inviter name, role).
   * Public - no session required. Does NOT accept the invitation.
   * Returns 404 if token is invalid; 410 if expired or already accepted.
   */
  @Get("invitations/:token")
  @HttpCode(200)
  @SkipCsrf()
  async getInvitationMetadata(
    @Param("token") token: string,
  ): Promise<InvitationMetadata> {
    return this.invitations.getInvitationMetadata(token);
  }

  /**
   * Accepts a workspace invitation.
   * Public - no session required (@SkipCsrf, no SessionGuard).
   * If no account exists for the invited email, name + password are required in the body.
   * Creates a session on success and sets the session cookie.
   */
  @Post("invitations/:token/accept")
  @HttpCode(200)
  @SkipCsrf()
  @UseGuards(IpThrottlerGuard)
  @SkipThrottle({ "user-hour": true })
  async acceptInvitation(
    @Param("token") token: string,
    @Body() body: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ userId: string; workspaceId: string }> {
    const result = await this.invitations.acceptInvitation(token, body);

    res.cookie(SESSION_COOKIE, result.cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: this.config.cookieSecure(),
    });

    return { userId: result.userId, workspaceId: result.workspaceId };
  }
}
