import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { EntitlementGate } from "../../../../entitlements/index.ts";
import { FormerContentSection } from "../../../../shell/former-content-section.tsx";
import { WorkspaceMembersPage } from "../../../../shell/workspace-members-page.tsx";
import { canAdminister, useWorkspace } from "../../../../shell/workspace.ts";
import { InvitationsSection } from "./-invitations-section.tsx";

/**
 * The members page, and under it the invitations an admin or owner manages, behind the `members.invite` entitlement
 * (the upgrade slot stands in for them where the workspace lacks it), and the content former members left behind, which
 * every admin or owner of the workspace sees; a member sees the 403 page the members page shows and neither.
 */
function MembersRoute(): ReactElement {
  const workspace = useWorkspace();
  return (
    <div className="flex flex-col gap-8">
      <WorkspaceMembersPage />
      {workspace.data !== undefined && canAdminister(workspace.data.role) ? (
        <EntitlementGate name="members.invite">
          <InvitationsSection />
        </EntitlementGate>
      ) : null}
      {workspace.data !== undefined && canAdminister(workspace.data.role) ? <FormerContentSection /> : null}
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/workspace/members")({
  component: MembersRoute,
});
