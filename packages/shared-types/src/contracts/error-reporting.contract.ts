/**
 * Error-reporting interface contract (spec §11.7).
 *
 * Captures runtime errors for diagnostics when configured. The no-op default
 * allows self-hosted installs with zero external telemetry. Hosted usage is
 * operator-configured and consent-gated at call sites.
 */

export interface ErrorCaptureContext {
  /**
   * When explicitly `false`, capture is skipped (hosted consent gate).
   * Omit for server-only diagnostics without end-user tracking context.
   */
  consentGranted?: boolean;
  /**
   * When `true`, user-identifying fields may be attached. Defaults to withheld
   * unless consent is granted and PII is explicitly requested.
   */
  includePii?: boolean;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: {
    id?: string;
    email?: string;
  };
}

export interface ErrorReportingService {
  /**
   * Returns true when an error sink is configured (DSN present).
   * Consent and PII rules still apply per capture call.
   */
  isConfigured(): boolean;

  /**
   * Report an exception. Must not throw; unconfigured or consent-denied calls
   * are no-ops.
   */
  captureException(error: unknown, context?: ErrorCaptureContext): void;

  /**
   * Report a message. Must not throw; unconfigured or consent-denied calls
   * are no-ops.
   */
  captureMessage(message: string, context?: ErrorCaptureContext): void;
}
