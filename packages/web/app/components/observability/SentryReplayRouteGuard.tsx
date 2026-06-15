import * as Sentry from "@sentry/react-router";
import { useEffect } from "react";
import { useLocation } from "react-router";

import { isSensitiveReplayRoute } from "../../lib/sentry-replay-routes.js";

type ReplayIntegration = {
  stop?: () => Promise<void>;
};

function getReplayIntegration(): ReplayIntegration | undefined {
  return Sentry.getClient()?.getIntegrationByName("Replay") as
    | ReplayIntegration
    | undefined;
}

/** Stops Session Replay when navigating to auth/settings routes (SEC-026). */
export function SentryReplayRouteGuard(): null {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!import.meta.env.VITE_SENTRY_DSN) {
      return;
    }
    if (isSensitiveReplayRoute(pathname)) {
      void getReplayIntegration()?.stop?.();
    }
  }, [pathname]);

  return null;
}
