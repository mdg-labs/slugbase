/**
 * AI suggestions interface contract (spec §11.2).
 *
 * The application depends only on this contract; implementations are selected
 * by configuration at module init. The no-op default allows the app to run
 * without an AI credential — suggestion flows degrade gracefully.
 */

import { initContract } from "@ts-rest/core";
import { z } from "zod";

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

// ─── HTTP contract (ts-rest / OpenAPI) ───────────────────────────────────────

const c = initContract();

const AiPageMetadataSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    siteName: z.string().optional(),
  })
  .strict();

export const AiSuggestBodySchema = z
  .object({
    url: z.string().min(1).max(2048),
    outputLanguage: z.string().min(2).max(10),
    metadata: AiPageMetadataSchema.optional(),
  })
  .strict();

export const AiSuggestionsSchema = z
  .object({
    title: z.string(),
    slug: z.string(),
    tags: z.array(z.string()),
    detectedLanguage: z.string(),
    confidence: z.number(),
  })
  .strict();

const errorSchema = z.object({ message: z.string() }).strict();

export const aiContract = c.router({
  suggestBookmarkFields: {
    method: "POST",
    path: "/ai/suggest",
    body: AiSuggestBodySchema,
    responses: {
      200: AiSuggestionsSchema,
      400: errorSchema,
      403: errorSchema,
      503: errorSchema,
    },
    summary:
      "Return AI-generated bookmark field suggestions for a URL (spec §11.2, §6.4)",
  },
});
