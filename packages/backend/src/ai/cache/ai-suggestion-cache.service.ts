import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type {
  AiService,
  AiSuggestionRequest,
  AiSuggestions,
} from "@slugbase/shared-types";

import { DbService } from "../../db/db.service.js";
import { AI_SUGGESTION_CACHE_TTL_MS } from "./ai-suggestion-cache.constants.js";
import { AiSuggestionCacheRepository } from "./ai-suggestion-cache.repository.js";
import type { AiSuggestionCacheContext } from "./ai-suggestion-cache.types.js";
import { buildCacheKey } from "./ai-suggestion-cache.types.js";
import { canonicalizeUrl } from "./canonical-url.js";

@Injectable()
export class AiSuggestionCacheService {
  private readonly repository: AiSuggestionCacheRepository;

  constructor(@Inject(DbService) db: DbService) {
    this.repository = new AiSuggestionCacheRepository(db.getOrm());
  }

  /**
   * Returns cached suggestions when present and within TTL; otherwise null (miss).
   */
  async get(
    context: AiSuggestionCacheContext,
    request: AiSuggestionRequest,
    nowMs = Date.now(),
  ): Promise<AiSuggestions | null> {
    const key = this.buildKey(context, request);
    const row = await this.repository.findByKey(key);
    if (!row) {
      return null;
    }

    if (this.repository.createdAtMs(row) + AI_SUGGESTION_CACHE_TTL_MS <= nowMs) {
      await this.repository.deleteByKey(key);
      return null;
    }

    return this.repository.toSuggestions(row);
  }

  /** Stores suggestions under the cache key, refreshing TTL. */
  async set(
    context: AiSuggestionCacheContext,
    request: AiSuggestionRequest,
    suggestions: AiSuggestions,
    nowMs = Date.now(),
  ): Promise<void> {
    const key = this.buildKey(context, request);
    await this.repository.upsert(key, suggestions, nowMs);
  }

  /**
   * Returns cached suggestions on hit; on miss delegates to {@link AiService.suggest}
   * and stores the result before returning.
   */
  async suggestWithCache(
    context: AiSuggestionCacheContext,
    request: AiSuggestionRequest,
    ai: AiService,
    nowMs = Date.now(),
  ): Promise<AiSuggestions> {
    const cached = await this.get(context, request, nowMs);
    if (cached) {
      return cached;
    }

    const suggestions = await ai.suggest(request);
    await this.set(context, request, suggestions, nowMs);
    return suggestions;
  }

  private buildKey(
    context: AiSuggestionCacheContext,
    request: Pick<AiSuggestionRequest, "url" | "outputLanguage">,
  ) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeUrl(request.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid URL";
      throw new BadRequestException(message);
    }

    return buildCacheKey(context, request, canonicalUrl);
  }
}
