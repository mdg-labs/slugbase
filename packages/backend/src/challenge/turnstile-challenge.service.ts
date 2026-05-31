import { Inject, Injectable, Logger } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";
import { isChallengeDevSkipEnabled } from "./challenge-dev-skip.js";
import {
  ChallengeVerificationError,
  type ChallengeService,
  type ChallengeVerifyRequest,
} from "./challenge.interface.js";
import { TURNSTILE_HTTP } from "./challenge.tokens.js";

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileHttpExecutor = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface TurnstileSiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

/**
 * Cloudflare Turnstile challenge implementation (spec §11.8).
 * Used when TURNSTILE_SECRET_KEY is configured (hosted deployments).
 */
@Injectable()
export class TurnstileChallengeService implements ChallengeService {
  private readonly logger = new Logger(TurnstileChallengeService.name);
  private readonly secretKey: string | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(TURNSTILE_HTTP) private readonly http: TurnstileHttpExecutor,
  ) {
    this.secretKey = config.get("TURNSTILE_SECRET_KEY");
  }

  isAvailable(): boolean {
    return this.secretKey !== undefined;
  }

  isDevSkipEnabled(): boolean {
    return isChallengeDevSkipEnabled(this.config);
  }

  async verify(request: ChallengeVerifyRequest): Promise<void> {
    if (this.isDevSkipEnabled()) {
      this.logger.debug("Challenge dev-skip enabled — verification skipped");
      return;
    }

    if (!request.token.trim()) {
      throw new ChallengeVerificationError("Missing challenge token");
    }

    const secretKey = this.secretKey;
    if (!secretKey) {
      throw new ChallengeVerificationError("Challenge provider not configured");
    }

    const body = new URLSearchParams({
      secret: secretKey,
      response: request.token,
    });
    if (request.remoteIp) {
      body.set("remoteip", request.remoteIp);
    }

    let response: Response;
    try {
      response = await this.http(TURNSTILE_SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      this.logger.warn("Turnstile siteverify request failed", {
        cause: error instanceof Error ? error.message : "unknown",
      });
      throw new ChallengeVerificationError("Challenge provider unavailable");
    }

    if (!response.ok) {
      this.logger.warn("Turnstile siteverify returned non-success status", {
        status: response.status,
      });
      throw new ChallengeVerificationError("Challenge provider rejected request");
    }

    let payload: TurnstileSiteverifyResponse;
    try {
      payload = (await response.json()) as TurnstileSiteverifyResponse;
    } catch {
      throw new ChallengeVerificationError("Invalid challenge provider response");
    }

    if (!payload.success) {
      this.logger.debug("Turnstile verification failed", {
        errorCodes: payload["error-codes"] ?? [],
      });
      throw new ChallengeVerificationError();
    }
  }

}
