import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { DbService } from "../db/db.service.js";
import { WorkspaceMemberRepository } from "./workspace-member.repository.js";
import {
  ROLE_HIERARCHY,
  type WorkspaceMemberRecord,
  type WorkspaceMemberRole,
} from "./workspace.types.js";

@Injectable()
export class WorkspaceMembersService {
  private readonly repo: WorkspaceMemberRepository;

  constructor(@Inject(DbService) private readonly db: DbService) {
    this.repo = new WorkspaceMemberRepository(db.getOrm(), db.dialect);
  }

  async addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
    requesterId: string,
  ): Promise<WorkspaceMemberRecord> {
    await this.requireRequesterRole(workspaceId, requesterId, "ADMIN");

    if (role === "OWNER") {
      await this.requireRequesterRole(workspaceId, requesterId, "OWNER");
    }

    const existing = await this.repo.findByWorkspaceAndUser(workspaceId, userId);
    if (existing) {
      throw new ConflictException("User is already a member of this workspace");
    }

    return this.repo.create({ workspaceId, userId, role });
  }

  async removeMember(
    workspaceId: string,
    userId: string,
    requesterId: string,
  ): Promise<void> {
    const target = await this.repo.findByWorkspaceAndUser(workspaceId, userId);
    if (!target) {
      throw new NotFoundException("Member not found");
    }

    const requester = await this.repo.findByWorkspaceAndUser(
      workspaceId,
      requesterId,
    );
    if (!requester) {
      throw new ForbiddenException("Not a member of this workspace");
    }

    if (ROLE_HIERARCHY[requester.role] <= ROLE_HIERARCHY[target.role] && requesterId !== userId) {
      throw new ForbiddenException(
        "Cannot remove a member with equal or higher role",
      );
    }

    if (target.role === "OWNER") {
      const ownerCount = await this.repo.countOwners(workspaceId);
      if (ownerCount <= 1) {
        throw new UnprocessableEntityException(
          "Cannot remove the last owner of a workspace",
        );
      }
    }

    await this.repo.delete(workspaceId, userId);
  }

  async getMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord> {
    const member = await this.repo.findByWorkspaceAndUser(workspaceId, userId);
    if (!member) {
      throw new NotFoundException("Member not found");
    }
    return member;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    return this.repo.findAllByWorkspace(workspaceId);
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    newRole: WorkspaceMemberRole,
    requesterId: string,
  ): Promise<WorkspaceMemberRecord> {
    await this.requireRequesterRole(workspaceId, requesterId, "OWNER");

    const target = await this.repo.findByWorkspaceAndUser(workspaceId, userId);
    if (!target) {
      throw new NotFoundException("Member not found");
    }

    if (target.role === "OWNER" && newRole !== "OWNER") {
      const ownerCount = await this.repo.countOwners(workspaceId);
      if (ownerCount <= 1) {
        throw new UnprocessableEntityException(
          "Cannot demote the last owner of a workspace",
        );
      }
    }

    const updated = await this.repo.update(workspaceId, userId, { role: newRole });
    if (!updated) {
      throw new NotFoundException("Member not found after update");
    }
    return updated;
  }

  private async requireRequesterRole(
    workspaceId: string,
    requesterId: string,
    minimumRole: WorkspaceMemberRole,
  ): Promise<void> {
    const requester = await this.repo.findByWorkspaceAndUser(
      workspaceId,
      requesterId,
    );
    if (!requester) {
      throw new ForbiddenException("Not a member of this workspace");
    }
    if (ROLE_HIERARCHY[requester.role] < ROLE_HIERARCHY[minimumRole]) {
      throw new ForbiddenException("Insufficient role for this operation");
    }
  }
}
