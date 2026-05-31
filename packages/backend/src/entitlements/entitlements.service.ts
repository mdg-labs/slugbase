import { ForbiddenException, Inject, Injectable } from "@nestjs/common";

import { BillingProfileService } from "../billing/billing-profile.service.js";
import type { WorkspacePlan, WorkspaceRecord } from "../workspaces/workspace.types.js";

export type EntitlementCapability =
  | "team-sharing"
  | "team-admin"
  | "unlimited-bookmarks"
  | "custom-slug-rules"
  | "workspace-members"
  | "audit-log";

/** Free workspace bookmark cap (spec §23.4, def §2). */
export const FREE_BOOKMARK_CAP = 50;

const PERSONAL_CAPABILITIES: EntitlementCapability[] = [
  "unlimited-bookmarks",
  "custom-slug-rules",
];

const TEAM_CAPABILITIES: EntitlementCapability[] = [
  ...PERSONAL_CAPABILITIES,
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
];

const PLAN_CAPABILITIES: Record<WorkspacePlan, Set<EntitlementCapability>> = {
  free: new Set(),
  personal: new Set(PERSONAL_CAPABILITIES),
  team: new Set(TEAM_CAPABILITIES),
};

const TEAM_ONLY_CAPABILITIES = new Set<EntitlementCapability>([
  "team-sharing",
  "team-admin",
  "workspace-members",
  "audit-log",
]);

@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(BillingProfileService)
    private readonly billingProfile: BillingProfileService,
  ) {}

  /**
   * Returns true when the workspace's plan grants the requested capability.
   * Self-host (billing no-op) bypasses plan limits — all capabilities pass.
   */
  can(workspace: Pick<WorkspaceRecord, "plan">, capability: EntitlementCapability): boolean {
    if (!this.billingProfile.isPlanGatingEnabled()) {
      return true;
    }
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
    if (this.can(workspace, capability)) return;

    const upgradeHint = TEAM_ONLY_CAPABILITIES.has(capability)
      ? "Upgrade to Team."
      : "Upgrade to Personal or higher.";

    throw new ForbiddenException(
      `Plan "${workspace.plan}" does not include capability "${capability}". ${upgradeHint}`,
    );
  }

  /**
   * Returns true when the workspace may create another active bookmark.
   * Unlimited plans bypass the cap; Free is limited to FREE_BOOKMARK_CAP active bookmarks.
   */
  canCreateBookmark(
    workspace: Pick<WorkspaceRecord, "plan">,
    activeBookmarkCount: number,
  ): boolean {
    if (this.can(workspace, "unlimited-bookmarks")) return true;
    return activeBookmarkCount < FREE_BOOKMARK_CAP;
  }

  /**
   * Asserts bookmark creation is allowed for the workspace at the given active count.
   * Throws ForbiddenException with an actionable message when the Free cap is reached.
   */
  assertCanCreateBookmark(
    workspace: Pick<WorkspaceRecord, "plan">,
    activeBookmarkCount: number,
  ): void {
    if (this.canCreateBookmark(workspace, activeBookmarkCount)) return;

    throw new ForbiddenException(
      `This workspace has reached the Free plan limit of ${String(FREE_BOOKMARK_CAP)} bookmarks. Upgrade to Personal for unlimited bookmarks.`,
    );
  }
}
