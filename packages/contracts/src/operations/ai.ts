import { z } from "zod";
import { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_SLUG_PATTERN, BOOKMARK_TITLE_MAX_LENGTH, BOOKMARK_URL_MAX_LENGTH } from "./bookmarks.ts";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { TAG_NAME_MAX_LENGTH } from "./tags.ts";
import { withoutNul } from "./text.ts";

// The ai tag of doc 04 section 10.8 (doc 02 section 14, doc 05 section 2.8, doc 10 T1, T11 and T13): a suggestion of the title, slug and tags of a bookmark for the modal
// that is open. It acts in the workspace the request is bound to and names none (D11). It is available when the instance has an AI provider configured, the workspace holds
// the `ai.suggestions` entitlement (decided on the server before the handler, so the interface hiding the feature is never the control), the workspace has the toggle on and
// the member has not opted out. Only the address, the metadata the request sends, the language and the names of the member's own tags go to the provider. The answer is data
// the server has checked and the member decides about: no suggestion is ever applied by the server. It takes from the `ai` bucket and needs the write scope, because it writes the cache.

/** The most tags a suggestion holds (doc 02 section 14). */
export const AI_SUGGESTION_TAGS_MAX = 5;

/** The longest language tag the request carries, in characters. */
export const AI_LOCALE_MAX_LENGTH = 35;

/** The grammar of the language tag: a language of two or three letters followed by up to four sub-tags, such as `en`, `de` or `pt-BR`. */
export const AI_LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

export const AiSuggestionRequestSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .describe(
        "The address of the page to suggest details for: an http or https URL of at most 2 048 characters, judged as a bookmark's URL is, and sent to the provider in its canonical form. Any other scheme is refused with 422 url_not_allowed",
      ),
    locale: z
      .string()
      .max(AI_LOCALE_MAX_LENGTH)
      .regex(AI_LOCALE_PATTERN)
      .describe("The language the suggestion is written in, a language tag such as en or de-AT of at most 35 characters. The cache is kept for each language, in lower case"),
    metadata: z
      .strictObject({
        title: withoutNul(z.string().trim().max(BOOKMARK_TITLE_MAX_LENGTH)).optional().describe("The page's title as the metadata operation read it, at most 300 characters"),
        description: withoutNul(z.string().trim().max(BOOKMARK_DESCRIPTION_MAX_LENGTH)).optional().describe("The page's description as the metadata operation read it, at most 1 000 characters"),
      })
      .optional()
      .describe(
        "What the page says about itself, as the metadata operation answers it, sent to the provider as data. It is not part of the cache key: a suggestion cached for the address and language is served whatever metadata a later request sends",
      ),
  })
  .meta({ id: "AiSuggestionRequest" });

export const AiSuggestionSchema = z
  .strictObject({
    title: z.string().min(1).max(BOOKMARK_TITLE_MAX_LENGTH).describe("The suggested title, plain text of 1 to 300 characters"),
    slug: z
      .string()
      .regex(BOOKMARK_SLUG_PATTERN)
      .nullable()
      .describe(
        "The suggested slug, in the grammar of a slug; null when the provider's slug was outside the grammar or is one the caller already uses on a bookmark in the workspace. The server never applies it",
      ),
    tags: z
      .array(z.string().min(1).max(TAG_NAME_MAX_LENGTH))
      .max(AI_SUGGESTION_TAGS_MAX)
      .describe("At most 5 suggested tag names, without repeats; the names of the caller's own tags that fit come first, in the spelling the caller uses. The server never applies them"),
    confidence: z.number().min(0).max(1).describe("How sure the provider is, from 0 to 1"),
  })
  .meta({ id: "AiSuggestion" });

export const suggestBookmarkDetails = defineOperation({
  method: "post",
  path: "/api/v1/ai/suggestions",
  operationId: "suggestBookmarkDetails",
  tag: "ai",
  summary: "Suggest a title, a slug and tags for a page",
  auth: "member",
  rate: "ai",
  scope: "write",
  entitlement: "ai.suggestions",
  request: { body: AiSuggestionRequestSchema },
  responses: {
    200: jsonResponse(
      "The suggestion, from the cache kept for the caller, the workspace, the address and the language for 30 days, or from the provider, which is asked for at most 5 seconds and is not asked while the cache holds the suggestion. The cache is never shared with another member or another workspace. A suggestion the provider could not give, or that did not pass the checks, is not an answer and is not cached. Nothing of any bookmark is changed",
      AiSuggestionSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token that may only read (token_scope), the workspace has the AI toggle off or the caller has opted out of AI suggestions (forbidden), or the workspace does not hold the ai.suggestions entitlement (entitlement_required). The provider is not asked",
    ),
    404: problemResponse("The request acts in no workspace: the account has none, the workspace is being deleted, or the caller left the workspace while the provider was asked"),
    422: problemResponse(
      "The body did not pass validation (a missing, empty, over-long or malformed URL, a language that is not a language tag, a title or description that holds a NUL character or is over-long, or a field the operation does not declare), or the URL is not an http or https URL (url_not_allowed). The provider is not asked",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    502: problemResponse("The provider failed, did not answer within 5 seconds or answered what cannot be used (upstream_failed). Nothing is cached"),
    503: problemResponse("No AI provider is configured on this instance (ai_unavailable), the service is temporarily unavailable, or no entitlement source is configured"),
  },
});
