import { useRouteLoaderData } from "react-router";

import type { WorkspacePlan } from "./sharing.types.js";
import { canUseTeamSharing } from "./use-entitlements.js";

export type AppLayoutLoaderData = {
  user: { id: string };
  workspace: {
    id: string;
    name: string;
    plan: WorkspacePlan;
  };
};

export function useWorkspaceEntitlements() {
  const rawData: unknown = useRouteLoaderData("routes/app-layout");
  const data = rawData as AppLayoutLoaderData | undefined;
  if (!data?.workspace) {
    throw new Error("useWorkspaceEntitlements requires workspace loader data");
  }

  const plan = data.workspace.plan;

  return {
    workspace: data.workspace,
    currentUserId: data.user.id,
    canShare: canUseTeamSharing(plan),
  };
}
