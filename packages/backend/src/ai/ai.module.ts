import { Global, Module } from "@nestjs/common";

import { AdminModule } from "../admin/admin.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { ConfigModule } from "../config/config.module.js";
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
 * Provides the AI interface token via {@link OpenAiAiService}. Credentials and
 * model come from OPENAI_API_KEY / OPENAI_MODEL deployment env only (spec §11.2, §15).
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    AdminModule,
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
