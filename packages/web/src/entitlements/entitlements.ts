import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient } from "../api/client.ts";

export type Entitlements = ComponentTypes["schemas"]["Entitlements"];
type EntitlementSet = Entitlements["entitlements"];

/** The entitlements that switch a feature on or off, as opposed to the limits. */
export type FeatureEntitlement = { [Key in keyof EntitlementSet]: EntitlementSet[Key] extends boolean ? Key : never }[keyof EntitlementSet];

export const ENTITLEMENTS_QUERY_KEY = ["entitlements"] as const;

/**
 * What the workspace grants and how much of it is used (doc 04 section 10.4). The key carries the workspace, so
 * the answer of one workspace is never read for another, and it is asked for once per workspace: switching
 * invalidates the cache like everything else, and a refused entitlement invalidates it by its prefix. It is read
 * again whenever the window regains focus, so a grant made elsewhere (another tab, a plan upgraded in checkout)
 * opens the gates without a reload.
 */
export function entitlementsQuery(api: ApiClient, workspaceId: string) {
  return queryOptions({
    queryKey: [...ENTITLEMENTS_QUERY_KEY, workspaceId],
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: "always",
    queryFn: async (): Promise<Entitlements> => {
      const { data, error } = await api.GET("/api/v1/entitlements");
      if (data === undefined) {
        throw new Error("The entitlements request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/**
 * Whether the feature is granted. An answer that is not in yet, or could not be had, grants it: the server
 * enforces every entitlement itself, so the page never hides what the server would allow.
 */
export function isGranted(entitlements: Entitlements | undefined, feature: FeatureEntitlement): boolean {
  return entitlements?.entitlements[feature] ?? true;
}

/** Whether the account owns as many workspaces as its entitlement allows. Unknown limits are not reached. */
export function isWorkspaceLimitReached(entitlements: Entitlements | undefined): boolean {
  if (entitlements === undefined) {
    return false;
  }
  const limit = entitlements.entitlements["workspaces.ownMax"];
  return limit !== "unlimited" && entitlements.usage["workspaces.owned"] >= limit;
}

/** Whether the error is the API refusing an operation for an entitlement the workspace lacks (`403 entitlement_required`). */
export function isEntitlementRequired(error: unknown): boolean {
  return error instanceof ApiProblemError && error.status === 403 && error.code === "entitlement_required";
}
