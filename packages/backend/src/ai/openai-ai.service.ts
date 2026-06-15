import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  AiSuggestError,
  AiUnavailableError,
  type AiService,
  type AiSuggestionRequest,
  type AiSuggestions,
  type CryptoService,
} from "@slugbase/shared-types";

import { ConfigService } from "../config/config.service.js";
import { CRYPTO } from "../crypto/crypto.tokens.js";
import { OPENAI_HTTP } from "./ai.tokens.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export type OpenAiHttpExecutor = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface OpenAiJsonPayload {
  title?: unknown;
  slug?: unknown;
  tags?: unknown;
  detectedLanguage?: unknown;
  confidence?: unknown;
}

@Injectable()
export class OpenAiAiService implements AiService {
  private readonly logger = new Logger(OpenAiAiService.name);
  private apiKey: string | undefined;
  private model: string;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(CRYPTO) private readonly crypto: CryptoService,
    @Inject(OPENAI_HTTP) private readonly http: OpenAiHttpExecutor,
  ) {
    this.apiKey = config.get("OPENAI_API_KEY");
    this.model = config.get("OPENAI_MODEL");
  }

  async suggest(request: AiSuggestionRequest): Promise<AiSuggestions> {
    if (!this.isAvailable()) {
      throw new AiUnavailableError();
    }

    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new AiUnavailableError();
    }

    try {
      const response = await this.http(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: buildSystemPrompt(request.outputLanguage),
            },
            {
              role: "user",
              content: buildUserPrompt(request),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new AiSuggestError(
          `OpenAI request failed with status ${String(response.status)}`,
        );
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new AiSuggestError("OpenAI response missing message content");
      }

      return parseSuggestions(content);
    } catch (error) {
      if (error instanceof AiUnavailableError || error instanceof AiSuggestError) {
        throw error;
      }

      this.logger.error("Failed to fetch AI suggestions", {
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AiSuggestError("Failed to fetch AI suggestions", error);
    }
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Reconfigure using credentials stored encrypted via {@link CryptoService}
   * in instance/workspace settings (spec §11.2, §11.11, §15).
   */
  reconfigureFromEncrypted(encryptedApiKey: string, model?: string): void {
    this.apiKey = this.crypto.decrypt(encryptedApiKey);
    if (model) {
      this.model = model;
    }
  }

  /** Clears DB-applied credentials; env-configured keys are not touched. */
  clearCredentials(): void {
    this.apiKey = undefined;
  }
}

function buildSystemPrompt(outputLanguage: string): string {
  return [
    "You suggest bookmark fields for a URL-shortening bookmark manager.",
    `Write the title and tags in the user's requested output language (${outputLanguage}).`,
    "Return JSON only with keys: title (string), slug (string), tags (string[]), detectedLanguage (ISO 639-1 code), confidence (number 0-1).",
    "Slug rules: lowercase letters, digits, and hyphens only; 1-64 chars; must start with a letter or digit; no leading hyphen.",
    "Provide 0-5 concise tags.",
  ].join(" ");
}

function buildUserPrompt(request: AiSuggestionRequest): string {
  const metadataLines: string[] = [`URL: ${request.url}`];
  if (request.metadata?.title) {
    metadataLines.push(`Page title: ${request.metadata.title}`);
  }
  if (request.metadata?.description) {
    metadataLines.push(`Description: ${request.metadata.description}`);
  }
  if (request.metadata?.siteName) {
    metadataLines.push(`Site name: ${request.metadata.siteName}`);
  }
  return metadataLines.join("\n");
}

function parseSuggestions(rawJson: string): AiSuggestions {
  let parsed: OpenAiJsonPayload;
  try {
    parsed = JSON.parse(rawJson) as OpenAiJsonPayload;
  } catch (error) {
    throw new AiSuggestError("OpenAI returned invalid JSON", error);
  }

  const title = readString(parsed.title, "title");
  const slug = normalizeSlug(readString(parsed.slug, "slug"));
  const tags = readTags(parsed.tags);
  const detectedLanguage = readLanguage(parsed.detectedLanguage);
  const confidence = readConfidence(parsed.confidence);

  return { title, slug, tags, detectedLanguage, confidence };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AiSuggestError(`OpenAI response missing valid ${field}`);
  }
  return value.trim();
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 5);
}

function readLanguage(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{2}$/.test(value)) {
    return "en";
  }
  return value;
}

function readConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeSlug(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);

  if (normalized.length === 0 || !/^[a-z0-9]/.test(normalized)) {
    throw new AiSuggestError("OpenAI response missing valid slug");
  }

  return normalized;
}
