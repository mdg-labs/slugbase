import { ForbiddenException, Injectable } from "@nestjs/common";

import type { WorkspaceOwned } from "../../db/workspace-scoped.repository.js";

/**
 * Injectable service-level guard that enforces workspace data isolation.
 *
 * Inject this class into any service that loads workspace-scoped resources from
 * the DB and call `verifyOwnership` before returning the resource to the caller.
 * This provides a defence-in-depth check against cross-workspace data leakage,
 * complementing the query-level scoping enforced by `WorkspaceScopedRepository`.
 *
 * Unlike a NestJS `CanActivate` route guard (which runs before handler execution),
 * this guard operates at the service layer — after the DB fetch — so it can
 * inspect the actual `workspaceId` stamped on the returned record.
 *
 * Spec §5.9; security baseline rule §03.
 */
@Injectable()
export class WorkspaceDataGuard {
  /**
   * Verifies that a resource belongs to the active workspace.
   *
   * Returns the resource unchanged when ownership is confirmed, making it
   * convenient to use inline (pass-through pattern).
   *
   * @throws {ForbiddenException} when `resource.workspaceId !== activeWorkspaceId`
   */
  verifyOwnership<T extends WorkspaceOwned>(
    activeWorkspaceId: string,
    resource: T,
  ): T {
    if (resource.workspaceId !== activeWorkspaceId) {
      throw new ForbiddenException(
        "Resource does not belong to the active workspace",
      );
    }
    return resource;
  }
}
