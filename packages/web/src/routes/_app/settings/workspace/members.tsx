import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { EntitlementGate } from "../../../../entitlements/index.ts";
import { WorkspaceMembersPage } from "../../../../shell/workspace-members-page.tsx";
import { canAdminister, workspaceQuery } from "../../../../shell/workspace.ts";
import { InvitationsSection } from "./-invitations-section.tsx";

/**
 * The members page, and under it the invitations an admin or owner manages, behind the `members.invite` entitlement
 * (the upgrade slot stands in for them where the workspace lacks it); a member sees the 403 page the members page shows
 * and no invitations.
 */
function MembersRoute(): ReactElement {
  const router = useRouter();
  const workspace = useQuery(workspaceQuery(router.options.context.api));
  return (
    <div className="flex flex-col gap-8">
      <WorkspaceMembersPage />
      {workspace.data !== undefined && canAdminister(workspace.data.role) ? (
        <EntitlementGate name="members.invite">
          <InvitationsSection />
        </EntitlementGate>
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/workspace/members")({
  component: MembersRoute,
});
