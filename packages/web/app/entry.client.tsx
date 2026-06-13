import * as Sentry from "@sentry/react-router";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const environment =
  (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ||
  import.meta.env.MODE;
const release =
  (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined;
const tracesSampleRate = Number(
  import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
);
const replaysSessionSampleRate = Number(
  import.meta.env.VITE_SENTRY_REPLAY_SAMPLE_RATE ?? "0.25",
);

const routerOnError = dsn ? Sentry.sentryOnError : undefined;

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    integrations: [
      Sentry.reactRouterTracingIntegration(),
      Sentry.replayIntegration(),
      Sentry.feedbackIntegration({ colorScheme: "system" }),
    ],
    enableLogs: true,
    tracesSampleRate,
    replaysSessionSampleRate,
    replaysOnErrorSampleRate: 1.0,
    tracesSampler: (_samplingContext) => {
      if (
        typeof window !== "undefined" &&
        (window.location.pathname === "/health" ||
          window.location.pathname === "/version")
      ) {
        return 0;
      }
      return tracesSampleRate;
    },
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.username;
      }
      return event;
    },
  });
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter onError={routerOnError} />
    </StrictMode>,
  );
});
