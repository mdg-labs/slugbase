import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { workspaceHasActivePaidBilling } from "../billing/workspace-billing.util.js";
import { DbService } from "../db/db.service.js";
import { WorkspaceMemberRepository } from "./workspace-member.repository.js";
import { WorkspaceRepository } from "./workspace.repository.js";
import {
  ROLE_HIERARCHY,
  type CreateWorkspaceData,
  type UpdateWorkspaceData,
  type WorkspaceMemberRole,
  type WorkspacePlan,
  type WorkspaceRecord,
} from "./workspace.types.js";

@Injectable()
export class WorkspacesService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly memberRepo: WorkspaceMemberRepository;

  constructor(@Inject(DbService) private readonly db: DbService) {
    this.workspaceRepo = new WorkspaceRepository(db.getOrm());
    this.memberRepo = new WorkspaceMemberRepository(db.getOrm());
  }

  async createWorkspace(
    dto: CreateWorkspaceData,
    creatorId: string,
  ): Promise<WorkspaceRecord> {
    const existing = await this.workspaceRepo.findBySlug(dto.slug);
    if (existing) {
      throw new ConflictException(
        `A workspace with slug "${dto.slug}" already exists`,
      );
    }

    const workspace = await this.workspaceRepo.create(dto);
    await this.memberRepo.create({
      workspaceId: workspace.id,
      userId: creatorId,
      role: "OWNER",
    });
    return workspace;
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord> {
    const workspace = await this.workspaceRepo.findById(id);
    if (!workspace) {
      throw new NotFoundException(`Workspace not found`);
    }
    return workspace;
  }

  async listUserWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
    const memberships = await this.memberRepo.findAllByUser(userId);
    const ids = memberships.map((m) => m.workspaceId);
    return this.workspaceRepo.findByIds(ids);
  }

  /**
   * Resolves the default active workspace for a user session (spec §4.3).
   * Uses the earliest-created workspace the user belongs to.
   *
   * @throws {ForbiddenException} when the user has no workspace memberships
   */
  async resolveDefaultActiveWorkspaceId(userId: string): Promise<string> {
    const userWorkspaces = await this.listUserWorkspaces(userId);
    if (userWorkspaces.length === 0) {
      throw new ForbiddenException(
        "No workspace membership found — join a workspace or complete registration",
      );
    }

    const sorted = [...userWorkspaces].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const defaultWorkspace = sorted[0];
    if (!defaultWorkspace) {
      throw new ForbiddenException(
        "No workspace membership found — join a workspace or complete registration",
      );
    }
    return defaultWorkspace.id;
  }

  async updateWorkspace(
    id: string,
    patch: UpdateWorkspaceData,
    requesterId: string,
  ): Promise<WorkspaceRecord> {
    await this.requireWorkspaceRole(id, requesterId, "ADMIN");

    if (patch.slug !== undefined) {
      const existing = await this.workspaceRepo.findBySlug(patch.slug);
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `A workspace with slug "${patch.slug}" already exists`,
        );
      }
    }

    const updated = await this.workspaceRepo.update(id, patch);
    if (!updated) {
      throw new NotFoundException(`Workspace not found`);
    }
    return updated;
  }

  async deleteWorkspace(id: string, requesterId: string): Promise<void> {
    await this.requireWorkspaceRole(id, requesterId, "OWNER");
    const workspace = await this.getWorkspace(id);
    if (workspaceHasActivePaidBilling(workspace)) {
      throw new ForbiddenException(
        "Cannot delete a workspace with an active paid subscription. Cancel billing via the portal first.",
      );
    }

    const userMemberships = await this.memberRepo.findAllByUser(requesterId);
    const ownedWorkspaceIds = userMemberships
      .filter((m) => m.role === "OWNER")
      .map((m) => m.workspaceId);
    if (ownedWorkspaceIds.length <= 1) {
      throw new ForbiddenException(
        "Cannot delete your last workspace. Create another workspace before deleting this one.",
      );
    }

    await this.memberRepo.deleteAllByWorkspace(id);
    await this.workspaceRepo.delete(id);
  }

  /**
   * Returns owned workspace count and plan list for the given user.
   * Used for multi-workspace entitlement checks on workspace creation (spec §12.2).
   */
  async getOwnedWorkspaceInfo(userId: string): Promise<{ count: number; plans: WorkspacePlan[] }> {
    const memberships = await this.memberRepo.findAllByUser(userId);
    const ownedIds = memberships
      .filter((m) => m.role === "OWNER")
      .map((m) => m.workspaceId);
    if (ownedIds.length === 0) return { count: 0, plans: [] };
    const workspaces = await this.workspaceRepo.findByIds(ownedIds);
    return { count: workspaces.length, plans: workspaces.map((w) => w.plan) };
  }

  async requireWorkspaceRole(
    workspaceId: string,
    userId: string,
    minimumRole: WorkspaceMemberRole,
  ): Promise<void> {
    const member = await this.memberRepo.findByWorkspaceAndUser(
      workspaceId,
      userId,
    );
    if (!member) {
      throw new ForbiddenException("Not a member of this workspace");
    }
    if (ROLE_HIERARCHY[member.role] < ROLE_HIERARCHY[minimumRole]) {
      throw new ForbiddenException("Insufficient role for this operation");
    }
  }
}
