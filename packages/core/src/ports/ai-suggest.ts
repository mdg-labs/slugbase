import type { Port } from "./port.js";

export interface AiSuggestRequest {
  readonly url: string;
  readonly language: string;
  readonly metadata?: { readonly title?: string; readonly description?: string };
}

export interface AiSuggestion {
  readonly title: string;
  readonly slug: string;
  readonly tags: readonly string[];
  readonly confidence: number;
}

/** URL, metadata and language in; title, slug, tags and confidence out (doc 01 section 6). */
export interface AiSuggestPort extends Port {
  suggest(request: AiSuggestRequest): Promise<AiSuggestion>;
}
