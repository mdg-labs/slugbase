import { Injectable } from "@nestjs/common";
import type {
  ErrorCaptureContext,
  ErrorReportingService,
} from "@slugbase/shared-types";

/**
 * No-op error reporting — used when SENTRY_DSN is not configured (spec §11.7).
 */
@Injectable()
export class NoopErrorReportingService implements ErrorReportingService {
  isConfigured(): boolean {
    return false;
  }

  captureException(_error: unknown, _context?: ErrorCaptureContext): void {
    // intentionally empty
  }

  captureMessage(_message: string, _context?: ErrorCaptureContext): void {
    // intentionally empty
  }
}
