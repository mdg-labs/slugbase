import type { EntitlementsService } from "../entitlements/entitlements.service.js";
import type { WorkspaceRecord } from "../workspaces/workspace.types.js";

export function assertMemberInvitationsEntitlement(
  entitlements: EntitlementsService,
  workspace: Pick<WorkspaceRecord, "plan">,
): void {
  entitlements.assertCan(workspace, "workspace-members");
}
