/**
 * AI-based bookmark suggestions (title, slug, tags).
 * Uses OpenAI GPT-4o-mini with structured JSON output.
 * Data minimization: only sanitized URL and optional page title sent to AI.
 */

import OpenAI from 'openai';
import { validateSlug, MAX_LENGTHS } from '../utils/validation.js';

/** Params that may contain secrets - strip from URL before sending to AI */
const SECRET_PARAM_NAMES = new Set([
  'token', 'auth', 'key', 'session', 'signature', 'code', 'state',
  'access_token', 'refresh_token', 'api_key', 'apikey', 'secret',
  'password', 'passwd', 'credential', 'credentials',
]);

export interface AISuggestionResult {
  title: string;
  slug: string;
  tags: string[];
  language: string;
  confidence: number;
}

/**
 * Sanitize URL for AI: remove fragments, strip secret params, keep only utm_* query params.
 */
export function sanitizeUrlForAI(url: string): string {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';

    const keepParams = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_')) {
        keepParams.set(key, value);
      }
    });
    parsed.search = keepParams.toString();

    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Normalize slug: lowercase, hyphen-separated, alphanumeric only, max length.
 */
function normalizeSlug(slug: string): string {
  if (!slug || typeof slug !== 'string') return '';
  let s = slug
    .toLowerCase()
    .trim()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, MAX_LENGTHS.slug);
}

/**
 * Validate and normalize AI response against schema.
 */
function validateAndNormalizeResponse(raw: unknown): AISuggestionResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_LENGTHS.title) : '';
  if (!title) return null;

  let slug = typeof obj.slug === 'string' ? obj.slug : '';
  slug = normalizeSlug(slug);
  const slugValidation = validateSlug(slug);
  if (!slugValidation.valid) {
    slug = slug || 'bookmark';
  }

  const tagsRaw = Array.isArray(obj.tags) ? obj.tags : [];
  const tags = tagsRaw
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, MAX_LENGTHS.tagName))
    .slice(0, 10);

  const language = typeof obj.language === 'string' ? obj.language.slice(0, 10) : 'en';
  const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;

  return { title, slug, tags, language, confidence };
}

const AI_RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'bookmark_suggestions',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title' },
        slug: { type: 'string', description: 'URL-safe slug, lowercase, hyphen-separated' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '5-10 relevant tags',
        },
        language: { type: 'string', description: 'ISO 639-1 language code' },
        confidence: { type: 'number', description: 'Confidence 0-1' },
      },
      required: ['title', 'slug', 'tags', 'language', 'confidence'],
      additionalProperties: false,
    },
  },
} as const;

const SYSTEM_PROMPT = `You suggest bookmark metadata from a URL and optional page content.

Rules:
- When given page title and/or description, use them as the PRIMARY source. Do NOT guess from domain names alone.
- BRAND IN TITLE: When the URL domain suggests a brand (e.g. sentry.io -> Sentry, github.com -> GitHub), include that brand in the title. Prefer format "Brand - Description" or "Brand: Description". If og:site_name is provided, use it as the brand. Otherwise infer from the domain (e.g. main domain name before TLD). The title must identify the product/service, not just describe the category.
- Domain names can be ambiguous (e.g. "allquiet" could be a brand unrelated to literature). Always prefer page content over domain inference.
- Tags should reflect: product category (e.g. devops, alerting, monitoring, saas), use case (e.g. on-call, incident-management), technology type. Avoid thematic or cultural tags unless clearly supported by the page content.
- When you have NO page content and only a URL, set confidence lower (0.3–0.5) and prefer generic tags like "web-app", "tool", "website".
- OUTPUT LANGUAGE: Output title, slug, and tags in the user's preferred language (ISO 639-1). The language field must match this code. If no language is specified, use English.
- title: concise page title (max 500 chars), ideally from page content when available, always include brand when inferable
- slug: URL-safe, lowercase, hyphen-separated, alphanumeric only, max 255 chars. No secrets, tokens, or sensitive data.
- tags: 5-10 relevant tags (strings), in the user's language
- language: ISO 639-1 code matching the output language
- confidence: 0.0 to 1.0 (higher when page content was provided)`;

/**
 * List OpenAI models that support chat completions (for admin model dropdown).
 * Uses the Models API; filters to ids that typically support chat (gpt-*).
 * @param apiKey - decrypted OpenAI API key
 * @returns array of model ids, sorted (prefer newer first)
 */
export async function listOpenAIModels(apiKey: string): Promise<{ id: string }[]> {
  const client = new OpenAI({ apiKey });
  const models: { id: string }[] = [];
  try {
    const list = await client.models.list();
    const data = (list as { data?: { id: string }[] }).data ?? [];
    for (const m of data) {
      if (m?.id && (m.id.startsWith('gpt-') || m.id.startsWith('o1-'))) {
        models.push({ id: m.id });
      }
    }
    models.sort((a, b) => b.id.localeCompare(a.id));
    return models;
  } catch {
    return [];
  }
}

/**
 * Call AI provider (OpenAI) for bookmark suggestions.
 * @param sanitizedUrl - sanitized URL (domain + path, no secrets)
 * @param pageTitle - optional page title (from fetch or request)
 * @param pageDescription - optional page description (from meta tags)
 * @param apiKey - decrypted API key
 * @param model - model name (default gpt-4o-mini)
 * @param timeoutMs - request timeout (default 10000)
 * @param userLanguage - user's preferred language (ISO 639-1), output in this language
 * @param siteName - optional og:site_name from page (brand)
 */
export async function callAIProvider(
  sanitizedUrl: string,
  pageTitle: string | undefined,
  pageDescription: string | undefined,
  apiKey: string,
  model: string = 'gpt-4o-mini',
  timeoutMs: number = 10000,
  userLanguage: string = 'en',
  siteName?: string
): Promise<AISuggestionResult | null> {
  const client = new OpenAI({ apiKey });

  const userContent = [
    `URL: ${sanitizedUrl}`,
    pageTitle && `Page title: ${pageTitle}`,
    pageDescription && `Page description: ${pageDescription}`,
    siteName && `Site name (brand): ${siteName}`,
    `User's preferred language: ${userLanguage}. Output title, slug, and tags in this language.`,
  ]
    .filter(Boolean)
    .join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        response_format: AI_RESPONSE_SCHEMA,
        max_tokens: 500,
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as unknown;
    return validateAndNormalizeResponse(parsed);
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}
