import * as Sentry from "@sentry/node";

import type { AdminEnv } from "../config/env.schema.js";

let initialized = false;

export function initAdminSentry(config: AdminEnv): void {
  if (initialized || !config.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
  });
  initialized = true;
}

export function captureAdminJobFailure(
  error: unknown,
  jobName: string,
): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag("admin.job", jobName);
    Sentry.captureException(error);
  });
}
