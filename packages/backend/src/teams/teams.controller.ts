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
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { ActiveWorkspace } from "../workspaces/active-workspace.decorator.js";
import { TenantGuard, TENANT_USER_ID_KEY } from "../workspaces/tenant.guard.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import type { CreateTeamData, ListTeamsQuery, UpdateTeamData } from "./team.types.js";
import { TeamsService } from "./teams.service.js";

@Controller("teams")
@UseGuards(TenantGuard)
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @Post()
  @HttpCode(201)
  async createTeam(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Body() body: CreateTeamData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.teams.createTeam(workspace, userId, body);
  }

  @Get()
  @HttpCode(200)
  async listTeams(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Query() query: ListTeamsQuery,
  ) {
    return this.teams.listTeams(workspace, query);
  }

  @Get(":id")
  @HttpCode(200)
  async getTeam(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Param("id") id: string,
  ) {
    return this.teams.getTeam(workspace, id);
  }

  @Patch(":id")
  @HttpCode(200)
  async updateTeam(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: UpdateTeamData,
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.teams.updateTeam(workspace, userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteTeam(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
  ): Promise<void> {
    const userId = req[TENANT_USER_ID_KEY] as string;
    await this.teams.deleteTeam(workspace, userId, id);
  }

  @Put(":id/members")
  @HttpCode(200)
  async setTeamMembers(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { userIds: string[] },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.teams.setTeamMembers(workspace, userId, id, body.userIds);
  }

  @Post(":id/members")
  @HttpCode(200)
  async addTeamMember(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Body() body: { userId: string },
  ) {
    const userId = req[TENANT_USER_ID_KEY] as string;
    return this.teams.addTeamMember(workspace, userId, id, body.userId);
  }

  @Delete(":id/members/:userId")
  @HttpCode(200)
  async removeTeamMember(
    @ActiveWorkspace() workspace: WorkspaceRecord,
    @Req() req: Request & Record<string, unknown>,
    @Param("id") id: string,
    @Param("userId") memberUserId: string,
  ) {
    const requesterId = req[TENANT_USER_ID_KEY] as string;
    return this.teams.removeTeamMember(workspace, requesterId, id, memberUserId);
  }
}
