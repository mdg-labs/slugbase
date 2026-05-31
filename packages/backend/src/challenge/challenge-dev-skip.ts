import type { ConfigService } from "../config/config.service.js";

/**
 * Shared dev-skip policy for challenge implementations (spec §11.8).
 * Skips verification in non-production when CHALLENGE_DEV_SKIP is unset (defaults true),
 * or when explicitly enabled via CHALLENGE_DEV_SKIP=true.
 */
export function isChallengeDevSkipEnabled(config: ConfigService): boolean {
  const explicit = config.get("CHALLENGE_DEV_SKIP");
  if (explicit !== undefined) {
    return explicit;
  }
  return !config.get("isProduction");
}
