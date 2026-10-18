import { feedbackToast } from "@slugbase/ui/patterns";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AppRouter } from "../router.ts";

const LOGIN_PATH = "/login";
/** The pages made for a visitor without a session; an answer there that says "no session" is the expected one. */
const ANONYMOUS_PATHS: readonly string[] = [LOGIN_PATH, "/register", "/verify-email"];

/** The link between the API client, which sees a session end, and the app, which takes the member back to sign in. */
export interface SessionExpiry {
  /** Reports that an API answer said the session has ended. */
  readonly notify: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSessionExpiry(): SessionExpiry {
  const listeners = new Set<() => void>();
  return {
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Sends the member to `/login?next=<current path>` with an info toast when the session ends (doc 03
 * section 13). The sign-in page replaces the current entry, so Back does not return to a page that
 * only fails again; on the sign-in page itself, and on the registration and verification pages,
 * which a visitor without a session is meant to see, nothing happens, so answers that arrive after
 * the first one cause neither a second toast nor a loop.
 */
export function SessionExpiryHandler({ expiry, router }: { expiry: SessionExpiry; router: AppRouter }): null {
  const { t } = useTranslation();
  useEffect(
    () =>
      expiry.subscribe(() => {
        const { pathname, href } = router.history.location;
        if (ANONYMOUS_PATHS.includes(pathname)) {
          return;
        }
        router.history.replace(`${LOGIN_PATH}?next=${encodeURIComponent(href)}`);
        feedbackToast.info(t("session.expired.title"), t("session.expired.description"));
      }),
    [expiry, router, t],
  );
  return null;
}
