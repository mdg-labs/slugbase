import { feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";
import { isEntitlementRequired } from "../entitlements/entitlements.ts";

/**
 * Shows an error toast for every mutation that fails (doc 03, cross-cutting rules). It names the
 * request id of an API problem and nothing else of the cause. A mutation that failed because the
 * session ended is left to the session handler, which takes the member to sign in, and one the API refused with
 * `403 entitlement_required` has its own toast with the upgrade action. A request the
 * member gave up by closing the re-authentication prompt is no failure to report, and a mutation whose
 * `meta.fieldErrors` is set shows a `422` in its own form.
 */
export function MutationErrorToasts(): null {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") {
          return;
        }
        const error: unknown = event.action.error;
        if (isSessionEnded(error) || isReauthCancelled(error)) {
          return;
        }
        if (isEntitlementRequired(error)) {
          return;
        }
        if (event.mutation.meta?.["fieldErrors"] === true && error instanceof ApiProblemError && error.status === 422) {
          return;
        }
        const reason = globalThis.navigator.onLine
          ? t("feedback.mutationFailed.description")
          : t("feedback.mutationFailed.offline");
        const description =
          error instanceof ApiProblemError
            ? `${reason} ${t("feedback.mutationFailed.requestId", { requestId: error.requestId })}`
            : reason;
        feedbackToast.error(t("feedback.mutationFailed.title"), description);
      }),
    [queryClient, t],
  );
  return null;
}
