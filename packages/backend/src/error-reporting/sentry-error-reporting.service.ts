import { Injectable, Logger } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
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
 * Sentry.init() runs in instrument.ts (first import in main.ts).
 * Consent and PII rules are enforced before events leave the process.
 */
@Injectable()
export class SentryErrorReportingService implements ErrorReportingService {
  private readonly logger = new Logger(SentryErrorReportingService.name);

  constructor(private readonly config: ConfigService) {}

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
    return shouldCaptureError(this.isConfigured(), context);
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