import * as Sentry from "@sentry/react";

let initialized = false;

/**
 * Initializes browser error reporting when VITE_SENTRY_DSN is set.
 * Call sites must pass consentGranted before capturing user-facing errors.
 */
export function initErrorReportingClient(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn || initialized) {
    return;
  }

  const environment =
    (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ||
    import.meta.env.MODE;
  const release =
    (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined;

  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.username;
      }
      return event;
    },
  });
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
