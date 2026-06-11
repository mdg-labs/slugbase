import * as Sentry from "@sentry/react-router";

let initialized = false;

/**
 * Initializes browser error reporting when VITE_SENTRY_DSN is set.
 * Call sites must pass consentGranted before capturing user-facing errors.
 * Init is handled directly in entry.client.tsx via Sentry.init();
 * this function tracks readiness for captureClientException.
 */
export function initErrorReportingClient(): void {
  if (initialized) {
    return;
  }
  initialized = true;
}

export function captureClientException(
  error: unknown,
  context?: { consentGranted?: boolean; includePii?: boolean },
): void {
  if (!initialized) {
    return;
  }
  if (context?.consentGranted === false) {
    return;
  }
  Sentry.withScope((scope) => {
    if (context?.includePii !== true) {
      scope.setUser({});
    }
    Sentry.captureException(error);
  });
}