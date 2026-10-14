import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppRouter } from "../router.ts";
import { MutationErrorToasts } from "./mutation-error-toasts.tsx";
import { SessionExpiryHandler, type SessionExpiry } from "./session-expiry.tsx";

/** The toast region and what raises toasts for the whole app: failed mutations and an ended session. */
export function AppFeedback({
  children,
  expiry,
  router,
}: {
  children: ReactNode;
  expiry: SessionExpiry;
  router: AppRouter;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <FeedbackToastProvider regionLabel={t("feedback.regionLabel")}>
      <MutationErrorToasts />
      <SessionExpiryHandler expiry={expiry} router={router} />
      {children}
    </FeedbackToastProvider>
  );
}
