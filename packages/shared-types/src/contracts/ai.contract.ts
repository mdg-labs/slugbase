/**
 * AI suggestions interface contract (spec §11.2).
 *
 * The application depends only on this contract; implementations are selected
 * by configuration at module init. The no-op default allows the app to run
 * without an AI credential — suggestion flows degrade gracefully.
 */

/** Optional page metadata to enrich suggestions (spec §6.4). */
export interface AiPageMetadata {
  title?: string;
  description?: string;
  siteName?: string;
}

export interface AiSuggestionRequest {
  /** Canonical destination URL for the bookmark. */
  url: string;
  /** Desired output language (ISO 639-1, e.g. `en`, `de`) — spec §17. */
  outputLanguage: string;
  /** Optional fetched page metadata. */
  metadata?: AiPageMetadata;
}

export interface AiSuggestions {
  title: string;
  slug: string;
  tags: string[];
  /** Detected language of the destination content (ISO 639-1). */
  detectedLanguage: string;
  /** Model confidence in the suggestion set, 0–1 inclusive. */
  confidence: number;
}

export interface AiService {
  /**
   * Returns bookmark field suggestions for the given URL and output language.
   * Throws {@link AiUnavailableError} when {@link isAvailable} is false.
   */
  suggest(request: AiSuggestionRequest): Promise<AiSuggestions>;

  /**
   * Returns true when an AI credential is configured for the current context.
   * Application code checks this before exposing AI-dependent features.
   */
  isAvailable(): boolean;
}

export class AiUnavailableError extends Error {
  constructor() {
    super("AI suggestions are not available");
    this.name = "AiUnavailableError";
  }
}

export class AiSuggestError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AiSuggestError";
  }
}
