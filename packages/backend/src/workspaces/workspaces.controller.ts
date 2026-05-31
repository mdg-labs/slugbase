import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { SessionService } from "../sessions/session.service.js";
import {
  SESSION_DATA_KEY,
  SESSION_ID_KEY,
  SESSION_USER_ID_KEY,
  SessionGuard,
} from "../sessions/session.guard.js";
import type { SessionData } from "../sessions/session.types.js";
import { ActiveWorkspace } from "./active-workspace.decorator.js";
import { TenantGuard } from "./tenant.guard.js";
import type { WorkspaceRecord } from "./workspace.types.js";
import { WorkspacesService } from "./workspaces.service.js";

@Controller("workspaces")
export class WorkspacesController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  /**
   * Activates a workspace as the tenant context for the current session.
   *
   * Verifies workspace membership before switching.  On success the session's
   * `activeWorkspaceId` is updated and the workspace metadata is returned.
   *
   * Spec §4.3 — switching the active workspace is an explicit, authenticated
   * operation; no subdomain/path tenancy in v1.
   */
  @Post(":id/activate")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async activateWorkspace(
    @Param("id") workspaceId: string,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceRecord> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    const sessionId = req[SESSION_ID_KEY] as string;
    const existingData = req[SESSION_DATA_KEY] as SessionData;

    let workspace: WorkspaceRecord;
    try {
      await this.workspaces.requireWorkspaceRole(workspaceId, userId, "MEMBER");
      workspace = await this.workspaces.getWorkspace(workspaceId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new ForbiddenException("Workspace not found or access denied");
      }
      throw err;
    }

    await this.sessions.updateSessionData(sessionId, {
      ...existingData,
      activeWorkspaceId: workspaceId,
    });

    return workspace;
  }

  /**
   * Returns the workspace currently active for the requesting session.
   *
   * Protected by TenantGuard — returns 403 if no active workspace is set
   * or the user is no longer a member.
   */
  @Get("active")
  @HttpCode(200)
  @UseGuards(TenantGuard)
  getActiveWorkspace(
    @ActiveWorkspace() workspace: WorkspaceRecord,
  ): WorkspaceRecord {
    return workspace;
  }
}
