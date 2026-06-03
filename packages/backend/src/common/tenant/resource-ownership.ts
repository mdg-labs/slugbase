import { ForbiddenException } from "@nestjs/common";

/**
 * Asserts that a resource belongs to the given active workspace.
 *
 * This is the primary cross-workspace isolation gate for all service-layer
 * mutations. Call this before any create/update/delete that operates on a
 * workspace-scoped resource, passing the active workspace ID from the session
 * and the `workspaceId` stamped on the loaded resource.
 *
 * Complements the query-level scoping in `WorkspaceScopedRepository` with an
 * explicit service-layer check that is easy to audit in code review.
 *
 * Spec §5.9; security baseline rule §03.
 *
 * @throws {ForbiddenException} when `resourceWorkspaceId !== activeWorkspaceId`
 */
export function assertResourceOwnership(
  activeWorkspaceId: string,
  resourceWorkspaceId: string,
): void {
  if (activeWorkspaceId !== resourceWorkspaceId) {
    throw new ForbiddenException(
      "Resource does not belong to the active workspace",
    );
  }
}
