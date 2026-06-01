import type { AnalyticsEventContext } from "@slugbase/shared-types";

/**
 * Whether an analytics event should be sent for the given configuration and context.
 */
export function shouldRecordAnalyticsEvent(
  isConfigured: boolean,
  context?: AnalyticsEventContext,
): boolean {
  if (!isConfigured) {
    return false;
  }
  if (context?.consentGranted === false) {
    return false;
  }
  return true;
}
