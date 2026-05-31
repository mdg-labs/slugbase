import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import { WorkspaceDataGuard } from "../workspaces/workspace-data.guard.js";
import { WorkspaceMembersService } from "../workspaces/workspace-members.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { TeamRepository } from "./team.repository.js";
import type {
  CreateTeamData,
  ListTeamsQuery,
  PaginatedTeams,
  ParsedListTeamsQuery,
  TeamRecord,
  UpdateTeamData,
} from "./team.types.js";
import {
  parseTeamSort,
  sanitizeTeamDescription,
  sanitizeTeamName,
} from "./team.validation.js";

@Injectable()
export class TeamsService {
  private readonly teamRepo: TeamRepository;

  constructor(
    @Inject(DbService) db: DbService,
    @Inject(WorkspaceDataGuard) private readonly wsDataGuard: WorkspaceDataGuard,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(WorkspaceMembersService)
    private readonly workspaceMembers: WorkspaceMembersService,
  ) {
    this.teamRepo = new TeamRepository(db.getOrm(), db.dialect);
  }

  async createTeam(
    workspace: WorkspaceRecord,
    requesterId: string,
    dto: CreateTeamData,
  ): Promise<TeamRecord> {
    await this.requireTeamAdmin(workspace.id, requesterId);

    const name = sanitizeTeamName(dto.name.trim());
    if (!name) throw new BadRequestException("name is required");

    const description = sanitizeTeamDescription(dto.description);
    if (dto.memberIds?.length) {
      await this.assertWorkspaceMembers(workspace.id, dto.memberIds);
    }

    const team = await this.teamRepo.create(workspace.id, {
      name,
      description,
      memberIds: dto.memberIds,
    });
    return this.wsDataGuard.verifyOwnership(workspace.id, team);
  }

  async getTeam(
    workspace: WorkspaceRecord,
    teamId: string,
  ): Promise<TeamRecord> {
    const team = await this.requireTeam(workspace, teamId);
    return this.wsDataGuard.verifyOwnership(workspace.id, team);
  }

  async listTeams(
    workspace: WorkspaceRecord,
    query: ListTeamsQuery,
  ): Promise<PaginatedTeams> {
    let sort;
    try {
      sort = parseTeamSort(query.sort);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid list query",
      );
    }

    const parsed: ParsedListTeamsQuery = {
      q: query.q,
      sort,
      page: query.page,
      pageSize: query.pageSize,
    };
    const result = await this.teamRepo.list(workspace.id, parsed);
    return {
      ...result,
      items: result.items.map((item) =>
        this.wsDataGuard.verifyOwnership(workspace.id, item),
      ),
    };
  }

  async updateTeam(
    workspace: WorkspaceRecord,
    requesterId: string,
    teamId: string,
    patch: UpdateTeamData,
  ): Promise<TeamRecord> {
    await this.requireTeamAdmin(workspace.id, requesterId);
    const existing = await this.requireTeam(workspace, teamId);

    const nextName =
      patch.name !== undefined
        ? sanitizeTeamName(patch.name.trim())
        : existing.name;
    if (!nextName) throw new BadRequestException("name is required");

    const nextDescription =
      patch.description !== undefined
        ? sanitizeTeamDescription(patch.description)
        : existing.description;

    const updated = await this.teamRepo.update(workspace.id, teamId, {
      name: nextName,
      description: nextDescription,
    });

    if (!updated) throw new NotFoundException("Team not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, updated);
  }

  async deleteTeam(
    workspace: WorkspaceRecord,
    requesterId: string,
    teamId: string,
  ): Promise<void> {
    await this.requireTeamAdmin(workspace.id, requesterId);
    await this.requireTeam(workspace, teamId);
    await this.teamRepo.delete(workspace.id, teamId);
  }

  async setTeamMembers(
    workspace: WorkspaceRecord,
    requesterId: string,
    teamId: string,
    userIds: string[],
  ): Promise<TeamRecord> {
    await this.requireTeamAdmin(workspace.id, requesterId);
    await this.requireTeam(workspace, teamId);
    await this.assertWorkspaceMembers(workspace.id, userIds);
    await this.teamRepo.replaceTeamMembers(workspace.id, teamId, userIds);

    const team = await this.teamRepo.findById(workspace.id, teamId);
    if (!team) throw new NotFoundException("Team not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, team);
  }

  async addTeamMember(
    workspace: WorkspaceRecord,
    requesterId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamRecord> {
    await this.requireTeamAdmin(workspace.id, requesterId);
    await this.requireTeam(workspace, teamId);
    await this.assertWorkspaceMembers(workspace.id, [userId]);
    await this.teamRepo.addTeamMember(workspace.id, teamId, userId);

    const team = await this.teamRepo.findById(workspace.id, teamId);
    if (!team) throw new NotFoundException("Team not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, team);
  }

  async removeTeamMember(
    workspace: WorkspaceRecord,
    requesterId: string,
    teamId: string,
    userId: string,
  ): Promise<TeamRecord> {
    await this.requireTeamAdmin(workspace.id, requesterId);
    await this.requireTeam(workspace, teamId);
    await this.teamRepo.removeTeamMember(workspace.id, teamId, userId);

    const team = await this.teamRepo.findById(workspace.id, teamId);
    if (!team) throw new NotFoundException("Team not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, team);
  }

  private async requireTeamAdmin(
    workspaceId: string,
    requesterId: string,
  ): Promise<void> {
    await this.workspaces.requireWorkspaceRole(workspaceId, requesterId, "ADMIN");
  }

  private async requireTeam(
    workspace: WorkspaceRecord,
    teamId: string,
  ): Promise<TeamRecord> {
    const team = await this.teamRepo.findById(workspace.id, teamId);
    if (!team) throw new NotFoundException("Team not found");
    return this.wsDataGuard.verifyOwnership(workspace.id, team);
  }

  private async assertWorkspaceMembers(
    workspaceId: string,
    userIds: string[],
  ): Promise<void> {
    for (const userId of userIds) {
      try {
        await this.workspaceMembers.getMember(workspaceId, userId);
      } catch (err) {
        if (err instanceof NotFoundException) {
          throw new BadRequestException(
            `User is not a workspace member: ${userId}`,
          );
        }
        throw err;
      }
    }
  }
}
