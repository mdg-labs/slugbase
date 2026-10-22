import { feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ExtensionsProvider, Slot, useExtensions } from "../extensions/index.ts";
import type { AppRouter } from "../router.ts";
import { ENTITLEMENTS_QUERY_KEY, isEntitlementRequired } from "./entitlements.ts";

/**
 * Shows a toast for every request the API refuses with `403 entitlement_required`, with the
 * `entitlement.upgradeAction` slot in it, and reads the entitlements again so the gates follow what the server
 * decided. The toast region sits above the router and the extensions, so the slot is given both.
 */
export function EntitlementRequiredToasts({ router }: { router: AppRouter }): null {
  const queryClient = useQueryClient();
  const extensions = useExtensions();
  const { t } = useTranslation();
  useEffect(() => {
    function refused(error: unknown): void {
      if (!isEntitlementRequired(error)) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY });
      feedbackToast.error(
        t("entitlements.required.title"),
        <span className="flex flex-col items-start gap-1">
          <span>{t("entitlements.required.description")}</span>
          <RouterContextProvider router={router}>
            <ExtensionsProvider extensions={extensions}>
              <Slot name="entitlement.upgradeAction" />
            </ExtensionsProvider>
          </RouterContextProvider>
        </span>,
      );
    }
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        refused(event.action.error);
      }
    });
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        refused(event.action.error);
      }
    });
    return () => {
      unsubscribeMutations();
      unsubscribeQueries();
    };
  }, [queryClient, extensions, router, t]);
  return null;
}
