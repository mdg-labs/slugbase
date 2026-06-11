import { HttpException, HttpStatus } from "@nestjs/common";

import type { ConfigService } from "../../config/config.service.js";

const RATE_LIMIT_MESSAGE =
  "Too many verification emails requested - please wait before trying again";

/** Rolling window start (ms) for counting unused verification tokens. */
export function verificationEmailRateLimitSinceMs(config: ConfigService): number {
  const ttlSeconds = config.get("RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS");
  return Date.now() - ttlSeconds * 1000;
}

/** Throws 429 when the user has reached the configured verification-email cap. */
export function assertVerificationEmailRateLimit(
  recentCount: number,
  config: ConfigService,
): void {
  const max = config.get("RATE_LIMIT_EMAIL_VERIFICATION_MAX");
  if (recentCount >= max) {
    throw new HttpException(RATE_LIMIT_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
  }
}
