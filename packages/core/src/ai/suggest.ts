import { AI_SUGGESTION_TAGS_MAX } from "@slugbase/contracts";
import { BOOKMARK_TITLE_MAX_LENGTH } from "../bookmarks/create.ts";
import { normalizeBookmarkUrl, type BookmarkUrlRefusal } from "../bookmarks/url.ts";
import { parseSlug } from "../go/slug.ts";
import type { AiSuggestPort } from "../ports/ai-suggest.ts";
import { normalizeTagName } from "../tags/create.ts";

// AI suggestions for the bookmark modal (doc 02 section 14, doc 04 section 10.8, doc 10 T1, T11 and T13). The service answers a member whose workspace, entitlement and
// settings allow it: the entitlement is decided before the service is reached (stage 9), and the service decides the rest in this order, each step before any call
// to the provider. The port is configured; the workspace toggle is on and the member has not opted out. An error of the store that reads the toggle or the opt-out
// ends the request, so no call is made on a setting that could not be read. A suggestion cached for the member, the workspace, the canonical URL and the language is
// served without a call. Otherwise the provider is asked, with no transaction open, for at most `timeoutMs`, and its answer is data (T13): it is checked against the
// limits of the fields, and one that cannot be used, a failure, and a timeout alike are `failed` and never cached.
//
// What is cached is the answer after those checks, and what is returned is that answer made the member's own on every request, cached or not: a slug outside the
// grammar is dropped when it is cached, and a slug the member already uses on a bookmark is dropped when it is returned, so a slug the member took after the
// suggestion was cached is not offered; the tags are the member's existing spellings first, at most five. No suggestion is ever applied: the answer is for the
// member to accept, and the server writes no bookmark for it.

/** The most of the member's own tag names that are sent to the provider as context. */
export const AI_CONTEXT_TAGS_MAX = 200;

/** How long the provider may take, in milliseconds (doc 02 section 14). */
export const AI_SUGGEST_BUDGET_MS = 5_000;

/** The suggestion as it is cached and returned: checked against the limits of the fields. A slug that is outside the grammar, or one the member uses, is null. */
export interface AiSuggestionResult {
  readonly title: string;
  readonly slug: string | null;
  readonly tags: readonly string[];
  /** From 0 to 1. */
  readonly confidence: number;
}

/** What the cache is asked to hold for the member of the transaction. */
export interface AiSuggestionCacheEntry {
  readonly urlCanonical: string;
  readonly locale: string;
  readonly result: AiSuggestionResult;
  readonly provider: string;
  readonly model: string;
}

/** The store of one transaction of the member's workspace. */
export interface AiSuggestionStore {
  /** Whether the workspace toggle is on and whether the member has opted out; undefined when the workspace or the member cannot be read. */
  availability(): Promise<{ readonly workspaceEnabled: boolean; readonly memberOptedOut: boolean } | undefined>;
  /** The names of the member's own tags, at most `limit`. */
  tagNames(limit: number): Promise<readonly string[]>;
  /** The suggestion cached for the member, the workspace, the URL and the language when it has not expired; what it returns is data and is checked again. */
  cached(urlCanonical: string, locale: string): Promise<unknown>;
  /** Caches the entry for the member, replacing an earlier one; false, and nothing cached, when the member has left the workspace meanwhile. */
  cache(entry: AiSuggestionCacheEntry): Promise<boolean>;
  /** Whether the member has a bookmark with the slug in the workspace, a plan-archived one included. */
  slugTaken(slug: string): Promise<boolean>;
}

export interface AiSuggestionDependencies {
  readonly ai: AiSuggestPort;
  /** Runs `work` in a transaction of the member's workspace. Each call is a transaction of its own, so none is open while the provider answers. */
  readonly withStore: <T>(work: (store: AiSuggestionStore) => Promise<T>) => Promise<T>;
  /** What the cache records as the provider and the model that answered. */
  readonly provider: string;
  readonly model: string;
  /** The time the provider is given; five seconds when left out. */
  readonly timeoutMs?: number;
  /** Told of a provider that failed, with the error it failed with. */
  readonly onProviderFailure?: (error: unknown) => void;
}

export interface AiSuggestionAsk {
  readonly url: string;
  /** The language the suggestion is written in; the cache is keyed by it in lower case. */
  readonly locale: string;
  readonly metadata?: { readonly title?: string | undefined; readonly description?: string | undefined } | undefined;
}

export type AiSuggestionOutcome =
  | { readonly kind: "suggested"; readonly suggestion: AiSuggestionResult; readonly cached: boolean }
  /** The AI port is not configured; nothing was read or sent. */
  | { readonly kind: "unavailable" }
  /** The workspace toggle is off, or the member opted out; nothing was sent. */
  | { readonly kind: "disabled"; readonly reason: "workspace" | "member" }
  /** The workspace or the member cannot be reached, or the member left the workspace while the provider answered; nothing was cached. */
  | { readonly kind: "not_found" }
  /** The URL is refused as a bookmark's is; nothing was sent. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal }
  /** The provider failed, ran out of time or answered what cannot be used; nothing was cached. */
  | { readonly kind: "failed" };

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function plainTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0") || !value.isWellFormed()) {
    return undefined;
  }
  const title = value.trim();
  const length = codePointLength(title);
  return length >= 1 && length <= BOOKMARK_TITLE_MAX_LENGTH ? title : undefined;
}

function plainTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value as unknown[]) {
    if (tags.length === AI_SUGGESTION_TAGS_MAX) {
      break;
    }
    if (typeof candidate !== "string" || candidate.includes("\0")) {
      continue;
    }
    // A lone surrogate is not text: the cache's jsonb refuses it, so a tag that holds one, when it is read, makes the answer unusable as a whole. (A slug that holds one is outside the grammar and is dropped.)
    if (!candidate.isWellFormed()) {
      return undefined;
    }
    const normalized = normalizeTagName(candidate);
    if (!("name" in normalized) || seen.has(normalized.name.toLowerCase())) {
      continue;
    }
    seen.add(normalized.name.toLowerCase());
    tags.push(normalized.name);
  }
  return tags;
}

/**
 * The suggestion in the limits of the fields, or undefined when the title or the confidence cannot be used, the tags are not a list, or a tag that is read holds a lone surrogate. A slug
 * outside the grammar (one that holds a lone surrogate included) is dropped. Tags are read in order until five are kept: one that is not text or holds a NUL is dropped, one that otherwise
 * holds a lone surrogate fails the answer, and one outside the limits of a tag name is dropped. The answer of the port and the row of the cache are both passed through it: neither is trusted (T13).
 */
export function checkSuggestion(value: { readonly title?: unknown; readonly slug?: unknown; readonly tags?: unknown; readonly confidence?: unknown }): AiSuggestionResult | undefined {
  const title = plainTitle(value.title);
  const tags = plainTags(value.tags);
  const { confidence } = value;
  if (title === undefined || tags === undefined || typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return undefined;
  }
  const slug = typeof value.slug === "string" ? (parseSlug(value.slug) ?? null) : null;
  return { title, slug, tags, confidence: Math.min(1, Math.max(0, confidence)) };
}

/** The suggestion for the member: the slug dropped when the member uses it, the tags in the spelling of the member's own tags first, and at most five. */
async function forMember(store: Pick<AiSuggestionStore, "slugTaken">, result: AiSuggestionResult, memberTags: readonly string[]): Promise<AiSuggestionResult> {
  const slug = result.slug !== null && (await store.slugTaken(result.slug)) ? null : result.slug;
  const spelling = new Map(memberTags.map((name) => [name.toLowerCase(), name]));
  const existing: string[] = [];
  const created: string[] = [];
  const seen = new Set<string>();
  for (const tag of result.tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const own = spelling.get(key);
    if (own === undefined) {
      created.push(tag);
    } else {
      existing.push(own);
    }
  }
  return { title: result.title, slug, tags: [...existing, ...created].slice(0, AI_SUGGESTION_TAGS_MAX), confidence: result.confidence };
}

async function askProvider(
  { ai, timeoutMs = AI_SUGGEST_BUDGET_MS, onProviderFailure }: Pick<AiSuggestionDependencies, "ai" | "timeoutMs" | "onProviderFailure">,
  request: Parameters<AiSuggestPort["suggest"]>[0],
): Promise<AiSuggestionResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("the AI provider did not answer within the budget"));
    }, timeoutMs);
  });
  // The provider may answer, or fail, after the deadline has passed: that answer is dropped, and its failure is not an unhandled rejection.
  const answer = Promise.resolve().then(() => ai.suggest(request));
  answer.catch(() => undefined);
  try {
    return checkSuggestion(await Promise.race([answer, deadline]));
  } catch (error) {
    onProviderFailure?.(error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function suggestWithAi(dependencies: AiSuggestionDependencies, ask: AiSuggestionAsk): Promise<AiSuggestionOutcome> {
  const { ai, withStore, provider, model } = dependencies;
  if (!ai.available) {
    return { kind: "unavailable" };
  }
  const locale = ask.locale.trim().toLowerCase();
  const url = normalizeBookmarkUrl(ask.url);

  const first = await withStore(async (store) => {
    const availability = await store.availability();
    if (availability === undefined) {
      return { kind: "not_found" } as const;
    }
    if (!availability.workspaceEnabled) {
      return { kind: "disabled", reason: "workspace" } as const;
    }
    if (availability.memberOptedOut) {
      return { kind: "disabled", reason: "member" } as const;
    }
    if (!url.ok) {
      return { kind: "url_refused", reason: url.reason } as const;
    }
    const tags = await store.tagNames(AI_CONTEXT_TAGS_MAX);
    const hit = checkSuggestion((await store.cached(url.value.canonical, locale)) ?? {});
    if (hit !== undefined) {
      return { kind: "suggested", suggestion: await forMember(store, hit, tags), cached: true } as const;
    }
    return { kind: "miss", tags } as const;
  });
  if (first.kind !== "miss") {
    return first;
  }
  if (!url.ok) {
    throw new Error("a request with a refused URL reached the provider");
  }

  const urlCanonical = url.value.canonical;
  const answered = await askProvider(dependencies, {
    url: urlCanonical,
    language: locale,
    ...(ask.metadata === undefined ? {} : { metadata: { ...(ask.metadata.title === undefined ? {} : { title: ask.metadata.title }), ...(ask.metadata.description === undefined ? {} : { description: ask.metadata.description }) } }),
    tags: first.tags,
  });
  if (answered === undefined) {
    return { kind: "failed" };
  }
  const second = await withStore(async (store) => {
    if (!(await store.cache({ urlCanonical, locale, result: answered, provider, model }))) {
      return undefined;
    }
    return forMember(store, answered, first.tags);
  });
  return second === undefined ? { kind: "not_found" } : { kind: "suggested", suggestion: second, cached: false };
}
