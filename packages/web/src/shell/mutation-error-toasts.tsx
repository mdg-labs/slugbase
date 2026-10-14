import { feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded } from "../api/client.ts";

/**
 * Shows an error toast for every mutation that fails (doc 03, cross-cutting rules). It names the
 * request id of an API problem and nothing else of the cause. A mutation that failed because the
 * session ended is left to the session handler, which takes the member to sign in.
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
        if (isSessionEnded(error)) {
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
