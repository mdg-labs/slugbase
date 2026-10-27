import type { ComponentTypes } from "@slugbase/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { Account } from "../account/me.ts";
import type { ApiClient } from "../api/client.ts";
import { BOOKMARKS_QUERY_KEY } from "../bookmarks/bookmarks.ts";

export type Dashboard = ComponentTypes["schemas"]["Dashboard"];
export type DashboardBookmark = ComponentTypes["schemas"]["DashboardBookmark"];
export type DashboardTag = ComponentTypes["schemas"]["DashboardTag"];

// Under the bookmarks' key: whatever refreshes the bookmarks after a change (a new, edited, pinned or deleted one) refreshes the home screen too.
export const DASHBOARD_QUERY_KEY = [...BOOKMARKS_QUERY_KEY, "dashboard"] as const;

/** What the home screen shows (doc 02 section 9.3), read in one call. */
export function dashboardQuery(api: ApiClient) {
  return queryOptions({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: async ({ signal }): Promise<Dashboard> => {
      const { data, error } = await api.GET("/api/v1/dashboard", { signal });
      if (data === undefined) {
        throw new Error("The dashboard request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/**
 * The dashboard with the stored checklist keys of a saved account laid over its own: the checklist shows a change the server confirmed
 * at once, and the read that follows (the keys are invalidated) only confirms it. The steps read from real state are left as they are.
 */
export function withSavedOnboarding(dashboard: Dashboard | undefined, saved: Account["onboarding"]): Dashboard | undefined {
  if (dashboard === undefined) {
    return undefined;
  }
  return {
    ...dashboard,
    onboarding: { ...dashboard.onboarding, browserSetupDone: saved.browserSetupDone, importDone: saved.importDone, dismissed: saved.checklistDismissed },
  };
}
