import { feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { isSessionEnded } from "../api/client.ts";

/**
 * Signs the member out: ends the session on the server, then takes them to the sign-in page and drops
 * every cached answer. While the server has not confirmed, nothing changes and the member is told so; a
 * session that had already ended is left to the session handler, which takes the member to sign in.
 * A second call while one is under way does nothing. A page that carries on as a signed-out visitor passes
 * `onSignedOut`: after the server confirmed and the cache was dropped it is called instead of the move to the sign-in page.
 */
export function useSignOut(onSignedOut?: () => void): () => void {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const running = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    try {
      const { error } = await router.options.context.api.POST("/api/v1/auth/logout");
      if (error !== undefined) {
        throw new Error("The sign-out did not answer with a problem document", { cause: error });
      }
    } catch (caught) {
      if (!isSessionEnded(caught)) {
        feedbackToast.error(t("signOut.failed.title"), t("signOut.failed.description"));
      }
      return;
    }
    if (onSignedOut === undefined) {
      router.history.replace("/login");
      queryClient.clear();
    } else {
      queryClient.clear();
      onSignedOut();
    }
  }, [onSignedOut, queryClient, router, t]);

  return useCallback(() => {
    if (running.current) {
      return;
    }
    running.current = true;
    void run().finally(() => {
      running.current = false;
    });
  }, [run]);
}
