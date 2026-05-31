import { Global, Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { ConfigService } from "../config/config.service.js";
import { CryptoModule } from "../crypto/crypto.module.js";
import { AI, OPENAI_HTTP } from "./ai.tokens.js";
import { NoopAiService } from "./noop-ai.service.js";
import { OpenAiAiService } from "./openai-ai.service.js";

/**
 * Provides the AI interface token bound to the config-selected implementation.
 * If OPENAI_API_KEY is set → OpenAiAiService; otherwise → NoopAiService.
 * Self-hosted BYO credentials use {@link OpenAiAiService.reconfigureFromEncrypted}.
 * No deployment-mode branching — interface selection only (spec §15, rule 03).
 */
@Global()
@Module({
  imports: [ConfigModule, CryptoModule],
  providers: [
    NoopAiService,
    OpenAiAiService,
    {
      provide: OPENAI_HTTP,
      useValue: (input: string, init?: RequestInit) => fetch(input, init),
    },
    {
      provide: AI,
      useFactory(
        config: ConfigService,
        openai: OpenAiAiService,
        noop: NoopAiService,
      ) {
        return config.get("OPENAI_API_KEY") ? openai : noop;
      },
      inject: [ConfigService, OpenAiAiService, NoopAiService],
    },
  ],
  exports: [AI, OpenAiAiService, NoopAiService],
})
export class AiModule {}
