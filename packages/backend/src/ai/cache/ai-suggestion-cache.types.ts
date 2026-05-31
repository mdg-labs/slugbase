import type { AiSuggestionRequest } from "@slugbase/shared-types";

/** Tenant + actor scope for cache keying (spec §11.2, §16). */
export interface AiSuggestionCacheContext {
  workspaceId: string;
  userId: string;
}

export interface AiSuggestionCacheKey {
  workspaceId: string;
  userId: string;
  canonicalUrl: string;
  outputLanguage: string;
}

export function buildCacheKey(
  context: AiSuggestionCacheContext,
  request: Pick<AiSuggestionRequest, "url" | "outputLanguage">,
  canonicalUrl: string,
): AiSuggestionCacheKey {
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    canonicalUrl,
    outputLanguage: request.outputLanguage,
  };
}
