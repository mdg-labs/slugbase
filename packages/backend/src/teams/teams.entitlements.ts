import type { EntitlementsService } from "../entitlements/entitlements.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";

export function assertTeamAdminEntitlement(
  entitlements: EntitlementsService,
  workspace: Pick<WorkspaceRecord, "plan">,
): void {
  entitlements.assertCan(workspace, "team-admin");
}
