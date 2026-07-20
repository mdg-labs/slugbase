import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { CHALLENGE } from "./challenge.tokens.js";
import { NoopChallengeService } from "./noop-challenge.service.js";

/**
 * CE challenge module — noop-only until cloud Altcha or future registration protection ships.
 * No deployment-mode branching - interface selection only (spec §11.8, §15).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    NoopChallengeService,
    {
      provide: CHALLENGE,
      useExisting: NoopChallengeService,
    },
  ],
  exports: [CHALLENGE, NoopChallengeService],
})
export class ChallengeModule {}
