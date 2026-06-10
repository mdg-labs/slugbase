import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { EntitlementsService } from "../entitlements/entitlements.service.js";
import { SessionService } from "../sessions/session.service.js";
import {
  SESSION_DATA_KEY,
  SESSION_ID_KEY,
  SESSION_USER_ID_KEY,
  SessionGuard,
} from "../sessions/session.guard.js";
import type { SessionData } from "../sessions/session.types.js";
import { ActiveWorkspace } from "./active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "./tenant.guard.js";
import type { CreateWorkspaceData, UpdateWorkspaceData, WorkspaceListItemResponse, WorkspaceRecord } from "./workspace.types.js";
import { WorkspacesService } from "./workspaces.service.js";

@Controller("workspaces")
export class WorkspacesController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Returns all workspaces the authenticated user belongs to (spec §4.3).
   * Used by the workspace switcher to populate the list.
   */
  @Get()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async listWorkspaces(
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceListItemResponse[]> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    return this.workspaces.listWorkspaceItemsForUser(userId);
  }

  /**
   * Creates a new workspace for the authenticated user (spec §12.2).
   *
   * Enforces multi-workspace entitlement: Free accounts may only own one
   * workspace unless they have a paid plan on an existing workspace.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(SessionGuard)
  async createWorkspace(
    @Body() body: CreateWorkspaceData,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceRecord> {
    const userId = req[SESSION_USER_ID_KEY] as string;

    const owned = await this.workspaces.getOwnedWorkspaceInfo(userId);
    if (!this.entitlements.canCreateWorkspace(owned.count, owned.plans)) {
      throw new ForbiddenException(
        "Your plan does not allow creating additional workspaces. Upgrade to Personal or higher.",
      );
    }

    return this.workspaces.createWorkspace(body, userId);
  }

  /**
   * Updates the active workspace's name or slug (spec §4.3).
   *
   * Aligned with web client which calls PATCH /workspaces/active.
   * Requires ADMIN or OWNER role (enforced by WorkspacesService.updateWorkspace).
   */
  @Patch("active")
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async updateActiveWorkspace(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: UpdateWorkspaceData,
  ): Promise<WorkspaceRecord> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.workspaces.updateWorkspace(workspace.id, body, userId);
  }

  /**
   * Deletes the active workspace (spec §4.3).
   *
   * Safeguards: must be OWNER, no active paid billing, and cannot delete last workspace.
   * Aligned with web client which calls DELETE /workspaces/active.
   */
  @Delete("active")
  @HttpCode(204)
  @UseGuards(TenantGuard)
  async deleteActiveWorkspace(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.workspaces.deleteWorkspace(workspace.id, userId);
  }

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

  /**
   * Updates a workspace by explicit ID.
   * Requires ADMIN or OWNER role.
   */
  @Patch(":id")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async updateWorkspace(
    @Param("id") workspaceId: string,
    @Body() body: UpdateWorkspaceData,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceRecord> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    return this.workspaces.updateWorkspace(workspaceId, body, userId);
  }

  /**
   * Deletes a workspace by explicit ID.
   * Requires OWNER role; cannot delete last workspace.
   */
  @Delete(":id")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async deleteWorkspace(
    @Param("id") workspaceId: string,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<void> {
    const userId = req[SESSION_USER_ID_KEY] as string;
    return this.workspaces.deleteWorkspace(workspaceId, userId);
  }
}
