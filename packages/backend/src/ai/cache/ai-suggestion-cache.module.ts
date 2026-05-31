import { Module } from "@nestjs/common";

import { DbModule } from "../../db/db.module.js";
import { AiSuggestionCacheService } from "./ai-suggestion-cache.service.js";

@Module({
  imports: [DbModule],
  providers: [AiSuggestionCacheService],
  exports: [AiSuggestionCacheService],
})
export class AiSuggestionCacheModule {}
