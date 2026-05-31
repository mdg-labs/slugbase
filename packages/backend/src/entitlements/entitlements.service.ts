import { ForbiddenException, Injectable } from "@nestjs/common";

import type { WorkspacePlan, WorkspaceRecord } from "../workspaces/workspace.types.js";

export type EntitlementCapability =
  | "team-sharing"
  | "unlimited-bookmarks"
  | "custom-slug-rules"
  | "workspace-members";

/** Free workspace bookmark cap (spec §23.4, def §2). */
export const FREE_BOOKMARK_CAP = 50;

const PLAN_CAPABILITIES: Record<WorkspacePlan, Set<EntitlementCapability>> = {
  free: new Set(),
  personal: new Set([
    "team-sharing",
    "unlimited-bookmarks",
    "custom-slug-rules",
    "workspace-members",
  ]),
};

@Injectable()
export class EntitlementsService {
  /**
   * Returns true when the workspace's plan grants the requested capability.
   * Synchronous — reads from the workspace object already in memory.
   */
  can(workspace: Pick<WorkspaceRecord, "plan">, capability: EntitlementCapability): boolean {
    return PLAN_CAPABILITIES[workspace.plan].has(capability);
  }

  /**
   * Asserts the workspace has the requested capability.
   * Throws ForbiddenException with a reason message if not entitled.
   */
  assertCan(
    workspace: Pick<WorkspaceRecord, "plan">,
    capability: EntitlementCapability,
  ): void {
    if (!this.can(workspace, capability)) {
      throw new ForbiddenException(
        `Plan "${workspace.plan}" does not include capability "${capability}". Upgrade to Personal or higher.`,
      );
    }
  }
}
