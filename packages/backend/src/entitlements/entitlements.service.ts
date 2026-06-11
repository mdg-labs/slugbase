import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { EntitlementCapability } from "@slugbase/shared-types";

import { BillingProfileService } from "../billing/billing-profile.service.js";
import { getPlanDefinition } from "../billing/plans/plan-catalog.js";
import { TEAM_ONLY_CAPABILITIES } from "../billing/plans/entitlement-sets.js";
import { resolveEntitlementsForPlan } from "../billing/plans/resolve-plan-entitlements.js";
import type { WorkspacePlan, WorkspaceRecord } from "../workspaces/workspace.types.js";

export type { EntitlementCapability } from "@slugbase/shared-types";
export { FREE_BOOKMARK_CAP } from "../billing/plans/entitlement-sets.js";

@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(BillingProfileService)
    private readonly billingProfile: BillingProfileService,
  ) {}

  /**
   * Returns true when the workspace's plan grants the requested capability.
   * Self-host (billing no-op) bypasses plan limits - all capabilities pass.
   */
  can(workspace: Pick<WorkspaceRecord, "plan">, capability: EntitlementCapability): boolean {
    if (!this.billingProfile.isPlanGatingEnabled()) {
      return true;
    }
    return resolveEntitlementsForPlan(workspace.plan).capabilities.has(capability);
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
      `Plan "${getPlanDefinition(workspace.plan).displayName}" does not include capability "${capability}". ${upgradeHint}`,
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
    const cap = resolveEntitlementsForPlan(workspace.plan).bookmarkCap;
    if (cap === null) return true;
    return activeBookmarkCount < cap;
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
      `This workspace has reached the Free plan limit of ${String(resolveEntitlementsForPlan("free").bookmarkCap)} bookmarks. Upgrade to Personal for unlimited bookmarks.`,
    );
  }

  /**
   * Returns true when the account may create/own another workspace (spec §12.2).
   * Self-host bypasses limits; Free accounts are capped at one owned workspace unless
   * they hold a paid entitlement on any owned workspace.
   */
  canCreateWorkspace(ownedWorkspaceCount: number, ownedPlans: WorkspacePlan[]): boolean {
    if (!this.billingProfile.isPlanGatingEnabled()) {
      return true;
    }
    if (this.canOwnMultipleWorkspaces(ownedPlans)) {
      return true;
    }
    const cap = resolveEntitlementsForPlan("free").workspacesPerAccount;
    if (cap === null) return true;
    return ownedWorkspaceCount < cap;
  }

  /**
   * Returns true when the acting account has a paid entitlement allowing multiple workspaces.
   * Checks whether any owned workspace is on a paid plan.
   */
  canOwnMultipleWorkspaces(ownedPlans: WorkspacePlan[]): boolean {
    if (!this.billingProfile.isPlanGatingEnabled()) {
      return true;
    }
    return ownedPlans.some((plan) => resolveEntitlementsForPlan(plan).capabilities.has("multiple-workspaces"));
  }
}
