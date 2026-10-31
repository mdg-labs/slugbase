// The package builds with neither DOM nor Node typings, which is where `URL` is declared; the runtime has it.
interface ParsedUrl {
  readonly hostname: string;
}
declare const URL: {
  new (input: string): ParsedUrl;
  canParse(input: string): boolean;
};

export type FakeAiErrorCode = "ai_failed" | "ai_timeout" | "ai_invalid_response";

/**
 * The error a `FakeAi` throws. It carries the same `name`, `code` and fixed message as `AiSuggestError`
 * in `@slugbase/core`; this package imports no workspace package, so match on `code`.
 */
export class FakeAiError extends Error {
  readonly code: FakeAiErrorCode;

  constructor(code: FakeAiErrorCode) {
    super(
      code === "ai_timeout"
        ? "The AI provider did not answer in time"
        : code === "ai_invalid_response"
          ? "The AI provider's answer was not usable"
          : "The AI provider request failed",
    );
    this.name = "AiSuggestError";
    this.code = code;
  }
}

/** The shape of `AiSuggestRequest` in `@slugbase/core`, which this package cannot import. */
export interface FakeAiRequest {
  readonly url: string;
  readonly language: string;
  readonly metadata?: { readonly title?: string; readonly description?: string };
  readonly tags: readonly string[];
}

/** The shape of `AiSuggestion` in `@slugbase/core`. */
export interface FakeAiSuggestion {
  readonly title: string;
  readonly slug: string;
  readonly tags: readonly string[];
  readonly confidence: number;
}

const MAX_TAGS = 5;

function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug === "" ? "bookmark" : slug;
}

/**
 * An AI port a test steers (doc 08 section 3.1): by default it answers the same way for the same request, with the page
 * title (or the host) as the title, the host as the slug, the first of the member's tags and a confidence of 0.5.
 * `respondWith` replaces the answer for every later request and `failWith` makes every later request reject with a
 * `FakeAiError` of that code, as the real adapter rejects with an `AiSuggestError`; `reset` goes back to the default.
 * Every request is kept.
 */
export class FakeAi {
  readonly available = true;
  readonly #requests: FakeAiRequest[] = [];
  #answer: FakeAiSuggestion | undefined;
  #failure: FakeAiErrorCode | undefined;

  /** Every request received so far, in order. */
  get requests(): readonly FakeAiRequest[] {
    return [...this.#requests];
  }

  respondWith(suggestion: FakeAiSuggestion): void {
    this.#answer = suggestion;
    this.#failure = undefined;
  }

  failWith(code: FakeAiErrorCode): void {
    this.#failure = code;
  }

  reset(): void {
    this.#answer = undefined;
    this.#failure = undefined;
    this.#requests.length = 0;
  }

  suggest(request: FakeAiRequest): Promise<FakeAiSuggestion> {
    this.#requests.push({ ...request, tags: [...request.tags] });
    if (this.#failure !== undefined) {
      return Promise.reject(new FakeAiError(this.#failure));
    }
    if (this.#answer !== undefined) {
      return Promise.resolve(this.#answer);
    }
    const host = URL.canParse(request.url) ? new URL(request.url).hostname : request.url;
    return Promise.resolve({
      title: request.metadata?.title ?? host,
      slug: slugOf(host),
      tags: request.tags.slice(0, MAX_TAGS),
      confidence: 0.5,
    });
  }
}
