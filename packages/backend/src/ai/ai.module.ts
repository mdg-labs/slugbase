import { Global, Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module.js";
import { ConfigModule } from "../config/config.module.js";
import { CryptoModule } from "../crypto/crypto.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { AiController } from "./ai.controller.js";
import { AiRuntimeService } from "./ai-runtime.service.js";
import { AiSuggestionCacheModule } from "./cache/ai-suggestion-cache.module.js";
import { AI, OPENAI_HTTP } from "./ai.tokens.js";
import { NoopAiService } from "./noop-ai.service.js";
import { OpenAiAiService } from "./openai-ai.service.js";

/**
 * Provides the AI interface token via {@link OpenAiAiService}. Deployment env
 * credentials are loaded in the service constructor; DB-backed credentials are
 * applied by {@link AiRuntimeService} on bootstrap and after settings PATCH.
 * Env `OPENAI_API_KEY` takes precedence over DB at startup (spec §11.2, §15).
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    AiSuggestionCacheModule,
    AccountsModule,
    EntitlementsModule,
    SessionsModule,
    WorkspacesModule,
  ],
  controllers: [AiController],
  providers: [
    NoopAiService,
    OpenAiAiService,
    AiRuntimeService,
    {
      provide: OPENAI_HTTP,
      useValue: (input: string, init?: RequestInit) => fetch(input, init),
    },
    {
      provide: AI,
      useExisting: OpenAiAiService,
    },
  ],
  exports: [
    AI,
    OpenAiAiService,
    NoopAiService,
    AiRuntimeService,
    AiSuggestionCacheModule,
  ],
})
export class AiModule {}
