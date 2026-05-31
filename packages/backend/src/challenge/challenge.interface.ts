/**
 * Bot / abuse protection challenge interface (spec §11.8).
 *
 * The application depends only on this contract; implementations are selected
 * by configuration at module init. The no-op default allows self-hosted installs
 * to run without Turnstile — verification passes when challenge is disabled.
 */

export interface ChallengeVerifyRequest {
  /** Client-side challenge token (e.g. Turnstile response). */
  token: string;
  /** Optional client IP forwarded to the provider for risk scoring. */
  remoteIp?: string;
}

export interface ChallengeService {
  /**
   * Returns true when a challenge provider is configured (e.g. Turnstile secret present).
   * When false, challenge verification is disabled for this deployment.
   */
  isAvailable(): boolean;

  /**
   * Returns true when verification is skipped (development / explicit dev-skip flag).
   */
  isDevSkipEnabled(): boolean;

  /**
   * Verify a challenge token from an unauthenticated surface (contact form, registration).
   * Resolves when verification passes; rejects {@link ChallengeVerificationError} on failure.
   */
  verify(request: ChallengeVerifyRequest): Promise<void>;
}

export class ChallengeVerificationError extends Error {
  constructor(message = "Challenge verification failed") {
    super(message);
    this.name = "ChallengeVerificationError";
  }
}
