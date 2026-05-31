import { Injectable, Logger } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import type {
  ErrorCaptureContext,
  ErrorReportingService,
} from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";
import {
  allowsPii,
  resolveUserContext,
  scrubExtra,
  shouldCaptureError,
} from "./error-reporting-pii.js";

/**
 * Sentry-backed error reporting — active when SENTRY_DSN is configured.
 * Consent and PII rules are enforced before events leave the process.
 */
@Injectable()
export class SentryErrorReportingService implements ErrorReportingService {
  private readonly logger = new Logger(SentryErrorReportingService.name);
  private initialized = false;

  constructor(private readonly config: ConfigService) {}

  private ensureInitialized(): boolean {
    if (this.initialized) {
      return true;
    }
    const dsn = this.config.get("SENTRY_DSN");
    if (!dsn) {
      return false;
    }

    const environment =
      this.config.get("SENTRY_ENVIRONMENT") ?? this.config.get("nodeEnv");
    const release = this.config.get("SENTRY_RELEASE");

    Sentry.init({
      dsn,
      environment,
      ...(release ? { release } : {}),
      beforeSend(event) {
        return scrubSentryEvent(event);
      },
    });
    this.initialized = true;
    this.logger.log("Sentry error reporting initialized");
    return true;
  }

  isConfigured(): boolean {
    return Boolean(this.config.get("SENTRY_DSN"));
  }

  captureException(error: unknown, context?: ErrorCaptureContext): void {
    if (!this.shouldSend(context)) {
      return;
    }
    this.applyScope(context, () => {
      Sentry.captureException(error);
    });
  }

  captureMessage(message: string, context?: ErrorCaptureContext): void {
    if (!this.shouldSend(context)) {
      return;
    }
    this.applyScope(context, () => {
      Sentry.captureMessage(message);
    });
  }

  private shouldSend(context?: ErrorCaptureContext): boolean {
    return (
      this.ensureInitialized() &&
      shouldCaptureError(this.isConfigured(), context)
    );
  }

  private applyScope(context: ErrorCaptureContext | undefined, fn: () => void): void {
    Sentry.withScope((scope) => {
      if (context?.tags) {
        scope.setTags(context.tags);
      }
      const extra = scrubExtra(context?.extra);
      if (extra) {
        scope.setExtras(extra);
      }
      const user = resolveUserContext(context);
      if (user) {
        scope.setUser({
          ...(user.id ? { id: user.id } : {}),
          ...(user.email ? { email: user.email } : {}),
        });
      } else if (context && !allowsPii(context)) {
        scope.setUser({});
      }
      fn();
    });
  }
}

function scrubSentryEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.user) {
    delete event.user.email;
    delete event.user.ip_address;
    delete event.user.username;
  }
  if (event.request?.headers) {
    const headers = { ...event.request.headers };
    delete headers.authorization;
    delete headers.cookie;
    event.request.headers = headers;
  }
  return event;
}
