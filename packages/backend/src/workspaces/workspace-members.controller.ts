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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "./active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "./tenant.guard.js";
import type {
  TransferOwnershipBody,
  UpdateMemberRoleBody,
  WorkspaceMemberView,
} from "./workspace-members.types.js";
import { WorkspaceMembersService } from "./workspace-members.service.js";
import type { WorkspaceRecord } from "./workspace.types.js";
import { WorkspacesService } from "./workspaces.service.js";

@Controller("members")
@UseGuards(TenantGuard)
export class WorkspaceMembersController {
  constructor(
    @Inject(WorkspaceMembersService)
    private readonly members: WorkspaceMembersService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  @HttpCode(200)
  async listMembers(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
  ): Promise<WorkspaceMemberView[]> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspace.id, userId, "ADMIN");
    return this.members.listMemberViews(workspace.id);
  }

  @Patch(":userId")
  @HttpCode(200)
  async updateMemberRole(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("userId") memberUserId: string,
    @Body() body: UpdateMemberRoleBody,
  ): Promise<WorkspaceMemberView> {
    const requesterId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspace.id, requesterId, "OWNER");

    const updated = await this.members.updateMemberRole(
      workspace.id,
      memberUserId,
      body.role,
      requesterId,
    );
    const views = await this.members.listMemberViews(workspace.id);
    const view = views.find((item) => item.userId === updated.userId);
    if (!view) {
      throw new Error("Member view missing after role update");
    }
    return view;
  }

  @Delete(":userId")
  @HttpCode(204)
  async removeMember(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("userId") memberUserId: string,
  ): Promise<void> {
    const requesterId = req[TENANT_USER_ID_KEY] as string;
    await this.workspaces.requireWorkspaceRole(workspace.id, requesterId, "ADMIN");
    await this.members.removeMember(workspace.id, memberUserId, requesterId);
  }

  @Post("transfer-ownership")
  @HttpCode(200)
  async transferOwnership(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: TransferOwnershipBody,
  ): Promise<WorkspaceMemberView[]> {
    const requesterId = req[TENANT_USER_ID_KEY] as string;
    return this.members.transferOwnership(
      workspace.id,
      body.targetUserId,
      requesterId,
    );
  }
}
