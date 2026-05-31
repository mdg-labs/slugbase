import type { ErrorCaptureContext } from "@slugbase/shared-types";

/** Field names redacted from error context unless PII is explicitly allowed. */
const PII_FIELD_NAMES = new Set([
  "password",
  "passwordHash",
  "sessionToken",
  "authorization",
  "cookie",
  "email",
  "userEmail",
]);

/**
 * Whether a capture should be sent for the given configuration and context.
 */
export function shouldCaptureError(
  isConfigured: boolean,
  context?: ErrorCaptureContext,
): boolean {
  if (!isConfigured) {
    return false;
  }
  if (context?.consentGranted === false) {
    return false;
  }
  return true;
}

/**
 * Whether user-identifying data may be attached for this capture.
 */
export function allowsPii(context?: ErrorCaptureContext): boolean {
  if (!context) {
    return false;
  }
  return context.consentGranted === true && context.includePii === true;
}

/**
 * Returns user context for the sink, or undefined when PII is not allowed.
 */
export function resolveUserContext(
  context?: ErrorCaptureContext,
): ErrorCaptureContext["user"] | undefined {
  if (!allowsPii(context) || !context?.user) {
    return undefined;
  }
  return context.user;
}

/**
 * Strips known PII keys from arbitrary extra payloads.
 */
export function scrubExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) {
    return undefined;
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (PII_FIELD_NAMES.has(key)) {
      continue;
    }
    scrubbed[key] = value;
  }
  return Object.keys(scrubbed).length > 0 ? scrubbed : undefined;
}
