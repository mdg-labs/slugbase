import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { CHALLENGE, TURNSTILE_HTTP } from "./challenge.tokens.js";
import { NoopChallengeService } from "./noop-challenge.service.js";
import { TurnstileChallengeService } from "./turnstile-challenge.service.js";

/**
 * Provides the CHALLENGE interface token bound to the config-selected implementation.
 * Legacy Turnstile env (removed from CE schema) still selects TurnstileChallengeService until TASK-027 Altcha ships.
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
        turnstile: TurnstileChallengeService,
        noop: NoopChallengeService,
      ) {
        const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
        return turnstileSecret ? turnstile : noop;
      },
      inject: [TurnstileChallengeService, NoopChallengeService],
    },
  ],
  exports: [CHALLENGE, TurnstileChallengeService, NoopChallengeService],
})
export class ChallengeModule {}
