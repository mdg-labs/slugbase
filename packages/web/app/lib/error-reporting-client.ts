import * as Sentry from "@sentry/react-router";

export function captureClientException(
  error: unknown,
  context?: { consentGranted?: boolean; includePii?: boolean },
): void {
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
