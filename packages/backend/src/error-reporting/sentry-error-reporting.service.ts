import { Injectable, Logger } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import type {
  ErrorCaptureContext,
  ErrorReportingService,
} from "@slugbase/shared-types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigService } from "../config/config.service.js";
import {
  allowsPii,
  resolveUserContext,
  scrubExtra,
  shouldCaptureError,
} from "./error-reporting-pii.js";

const RELEASE_PREFIX = "slugbase@";

/**
 * Reads the root package.json version and formats it as a Sentry release string.
 * Used as a fallback when SENTRY_RELEASE env is not explicitly set.
 * Returns undefined when the file cannot be read (e.g. inside a Docker container
 * where root package.json is not copied).
 */
function readRootPackageVersion(): string | undefined {
  try {
    const rootPkg = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(rootPkg, "utf-8")) as { version?: string };
    return pkg.version !== undefined
      ? `${RELEASE_PREFIX}${pkg.version}`
      : undefined;
  } catch {
    return undefined;
  }
}

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
    const release =
      this.config.get("SENTRY_RELEASE") ?? readRootPackageVersion();

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
