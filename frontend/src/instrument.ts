/**
 * Sentry instrumentation - must run before any other imports.
 * When VITE_SENTRY_DSN is unset, Sentry is disabled (no network calls).
 */
import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (dsn) {
  Sentry.init({
    dsn,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string) || import.meta.env.MODE || 'development',
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    replaysSessionSampleRate: import.meta.env.PROD ? 0.1 : 0,
    sendDefaultPii: false,
  });
}
