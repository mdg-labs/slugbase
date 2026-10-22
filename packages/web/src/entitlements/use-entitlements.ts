import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { meQuery } from "../account/me.ts";
import { entitlementsQuery, isGranted, isWorkspaceLimitReached, type Entitlements, type FeatureEntitlement } from "./entitlements.ts";

/**
 * The entitlements of the workspace the session acts in; undefined while they load, when they could not be
 * loaded, and while the account acts in no workspace.
 */
export function useEntitlements(): Entitlements | undefined {
  const api = useRouter().options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const workspaceId = me.data?.activeWorkspaceId ?? undefined;
  const entitlements = useQuery({
    ...entitlementsQuery(api, workspaceId ?? ""),
    enabled: workspaceId !== undefined,
  });
  return workspaceId === undefined ? undefined : entitlements.data;
}

/** Whether the workspace grants the feature; true until the entitlements say otherwise. */
export function useIsGranted(feature: FeatureEntitlement): boolean {
  return isGranted(useEntitlements(), feature);
}

/** Whether the account owns as many workspaces as its entitlement allows. */
export function useWorkspaceLimitReached(): boolean {
  return isWorkspaceLimitReached(useEntitlements());
}
