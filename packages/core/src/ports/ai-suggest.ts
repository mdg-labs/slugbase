import type { Port } from "./port.ts";

export interface AiSuggestRequest {
  readonly url: string;
  readonly language: string;
  readonly metadata?: { readonly title?: string; readonly description?: string };
  /** The names of the member's own tags, which a suggestion prefers; no other account or workspace data goes to the provider. */
  readonly tags: readonly string[];
}

export interface AiSuggestion {
  readonly title: string;
  readonly slug: string;
  readonly tags: readonly string[];
  readonly confidence: number;
}

export type AiSuggestErrorCode = "ai_failed" | "ai_timeout" | "ai_invalid_response";

/**
 * A suggestion the adapter could not produce. The messages are fixed texts: they never carry the
 * provider's answer, the request or a credential (T7). A failure of the egress port is the `cause`.
 */
export class AiSuggestError extends Error {
  readonly code: AiSuggestErrorCode;

  constructor(code: AiSuggestErrorCode, options?: { readonly cause?: unknown }) {
    super(
      code === "ai_timeout"
        ? "The AI provider did not answer in time"
        : code === "ai_invalid_response"
          ? "The AI provider's answer was not usable"
          : "The AI provider request failed",
      options,
    );
    this.name = "AiSuggestError";
    this.code = code;
  }
}

/**
 * URL, metadata, language and the member's tag names in; title, slug, tags and confidence out (doc 01 section 6).
 * The answer is validated data (T13); a failure rejects with an `AiSuggestError`.
 */
export interface AiSuggestPort extends Port {
  suggest(request: AiSuggestRequest): Promise<AiSuggestion>;
}
