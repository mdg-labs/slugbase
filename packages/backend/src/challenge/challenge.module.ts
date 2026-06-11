import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { CHALLENGE, TURNSTILE_HTTP } from "./challenge.tokens.js";
import { NoopChallengeService } from "./noop-challenge.service.js";
import { TurnstileChallengeService } from "./turnstile-challenge.service.js";

/**
 * Provides the CHALLENGE interface token bound to the config-selected implementation.
 * If TURNSTILE_SECRET_KEY is set → TurnstileChallengeService; otherwise → NoopChallengeService.
 * No deployment-mode branching - interface selection only (spec §11.8, §15).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    NoopChallengeService,
    TurnstileChallengeService,
    {
      provide: TURNSTILE_HTTP,
      useValue: (input: string, init?: RequestInit) => fetch(input, init),
    },
    {
      provide: CHALLENGE,
      useFactory(
        config: ConfigService,
        turnstile: TurnstileChallengeService,
        noop: NoopChallengeService,
      ) {
        return config.get("TURNSTILE_SECRET_KEY") ? turnstile : noop;
      },
      inject: [ConfigService, TurnstileChallengeService, NoopChallengeService],
    },
  ],
  exports: [CHALLENGE, TurnstileChallengeService, NoopChallengeService],
})
export class ChallengeModule {}
