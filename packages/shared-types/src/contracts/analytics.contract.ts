/**
 * Product analytics interface contract (spec §11.6).
 *
 * Records consent-gated usage events when an operator-configured sink is present.
 * The no-op default allows self-hosted installs with zero external telemetry.
 */

export interface AnalyticsEventContext {
  /**
   * When explicitly `false`, the event is not recorded (hosted consent gate).
   * Omit for server-only diagnostics without end-user tracking context.
   */
  consentGranted?: boolean;
  /** Page or resource path associated with the event. */
  url?: string;
  /** Hostname reported to the analytics sink. */
  hostname?: string;
  /** Optional structured payload - must not contain secrets or PII. */
  data?: Record<string, string | number | boolean>;
}

export interface AnalyticsService {
  /**
   * Returns true when an analytics sink is configured (Umami host + website id).
   * Consent rules still apply per record call.
   */
  isConfigured(): boolean;

  /**
   * Record a named product event. Must not throw; unconfigured or consent-denied
   * calls are no-ops.
   */
  recordEvent(
    name: string,
    context?: AnalyticsEventContext,
  ): void;
}
