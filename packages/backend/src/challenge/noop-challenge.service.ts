import { Inject, Injectable, Logger } from "@nestjs/common";

import { ConfigService } from "../config/config.service.js";
import { isChallengeDevSkipEnabled } from "./challenge-dev-skip.js";
import type { ChallengeService, ChallengeVerifyRequest } from "./challenge.interface.js";

/**
 * No-op challenge implementation - used when TURNSTILE_SECRET_KEY is not configured.
 * Verification always passes (challenge disabled); dev-skip is still reported for callers.
 * Self-hosted default (spec §11.8).
 */
@Injectable()
export class NoopChallengeService implements ChallengeService {
  private readonly logger = new Logger(NoopChallengeService.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  isAvailable(): boolean {
    return false;
  }

  isDevSkipEnabled(): boolean {
    return isChallengeDevSkipEnabled(this.config);
  }

  verify(request: ChallengeVerifyRequest): Promise<void> {
    this.logger.debug("Challenge provider not configured - verification skipped", {
      hasToken: request.token.length > 0,
    });
    return Promise.resolve();
  }
}
