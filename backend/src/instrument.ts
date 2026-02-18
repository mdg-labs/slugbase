/**
 * Sentry instrumentation - must run after load-env.ts so SENTRY_DSN is available.
 * When SENTRY_DSN is unset, Sentry is disabled (no network calls).
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Avoid sending PII; scrub sensitive data in beforeSend if needed
    sendDefaultPii: false,
  });
}
