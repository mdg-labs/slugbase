import { FakeAi } from "@slugbase/testing-ports";
import { describe, expect, it } from "vitest";
import { suggestWithAi, type AiSuggestPort, type AiSuggestionCacheEntry, type AiSuggestionStore } from "../../src/index.ts";

// The service behind POST /api/v1/ai/suggestions (doc 02 section 14, doc 10 T1, T11 and T13), over an in-memory store. The failure scenario: a member whose workspace
// toggle is off, who opted out, or whose settings cannot be read gets a refusal and the provider is never asked; a cache hit is served without asking it; and a suggestion
// is never cached unless it passed the checks.

const URL_ONE = "https://example.test/docs";

interface World {
  readonly ai: FakeAi;
  readonly port: AiSuggestPort;
  readonly cache: Map<string, unknown>;
  readonly cached: AiSuggestionCacheEntry[];
  readonly reads: string[];
  /** The transactions open now, and the most that were open at any moment the provider was asked. */
  readonly open: { now: number; whileAsked: number };
  readonly dependencies: Parameters<typeof suggestWithAi>[0];
}

function world(
  options: {
    readonly workspaceEnabled?: boolean;
    readonly memberOptedOut?: boolean;
    readonly availability?: "unreadable" | "fails";
    readonly tags?: readonly string[];
    readonly takenSlugs?: readonly string[];
    readonly timeoutMs?: number;
    readonly memberLeft?: boolean;
    readonly port?: (fake: FakeAi) => AiSuggestPort;
  } = {},
): World {
  const ai = new FakeAi();
  const cache = new Map<string, unknown>();
  const cached: AiSuggestionCacheEntry[] = [];
  const reads: string[] = [];
  const open = { now: 0, whileAsked: 0 };
  const store: AiSuggestionStore = {
    availability() {
      reads.push("availability");
      if (options.availability === "fails") {
        return Promise.reject(new Error("the settings cannot be read"));
      }
      return Promise.resolve(options.availability === "unreadable" ? undefined : { workspaceEnabled: options.workspaceEnabled ?? true, memberOptedOut: options.memberOptedOut ?? false });
    },
    tagNames: (limit) => Promise.resolve((options.tags ?? []).slice(0, limit)),
    cached(urlCanonical, locale) {
      reads.push("cached");
      return Promise.resolve(cache.get(`${urlCanonical}|${locale}`));
    },
    cache(entry) {
      if (options.memberLeft === true) {
        return Promise.resolve(false);
      }
      cached.push(entry);
      cache.set(`${entry.urlCanonical}|${entry.locale}`, entry.result);
      return Promise.resolve(true);
    },
    slugTaken: (slug) => Promise.resolve((options.takenSlugs ?? []).includes(slug)),
  };
  const asked: AiSuggestPort = options.port?.(ai) ?? ai;
  const port: AiSuggestPort = {
    available: asked.available,
    suggest(request) {
      open.whileAsked = Math.max(open.whileAsked, open.now);
      return asked.suggest(request);
    },
  };
  return {
    ai,
    port,
    cache,
    cached,
    reads,
    open,
    dependencies: {
      ai: port,
      withStore: async (work) => {
        open.now += 1;
        try {
          return await work(store);
        } finally {
          open.now -= 1;
        }
      }, provider: "Example AI",
      model: "model-1",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  };
}

const ASK = { url: URL_ONE, locale: "en" };

describe("who may be answered", () => {
  it("refuses an unconfigured port without reading anything or asking the provider", async () => {
    const { ai, reads, dependencies } = world({ port: () => ({ available: false, suggest: () => Promise.reject(new Error("must not be asked")) }) });
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "unavailable" });
    expect(reads).toEqual([]);
    expect(ai.requests).toEqual([]);
  });

  it("refuses a workspace whose toggle is off and does not ask the provider, even for a suggestion that is cached", async () => {
    const { ai, cache, dependencies } = world({ workspaceEnabled: false });
    cache.set(`${URL_ONE}|en`, { title: "Cached", slug: null, tags: [], confidence: 0.5 });
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "disabled", reason: "workspace" });
    expect(ai.requests).toEqual([]);
  });

  it("refuses a member who opted out and does not ask the provider, even for a suggestion that is cached", async () => {
    const { ai, cache, dependencies } = world({ memberOptedOut: true });
    cache.set(`${URL_ONE}|en`, { title: "Cached", slug: null, tags: [], confidence: 0.5 });
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "disabled", reason: "member" });
    expect(ai.requests).toEqual([]);
  });

  it("ends the request when the settings cannot be read, without asking the provider", async () => {
    const { ai, dependencies } = world({ availability: "fails" });
    await expect(suggestWithAi(dependencies, ASK)).rejects.toThrow("the settings cannot be read");
    expect(ai.requests).toEqual([]);
  });

  it("answers not found for a workspace or member that cannot be read, without asking the provider", async () => {
    const { ai, dependencies } = world({ availability: "unreadable" });
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "not_found" });
    expect(ai.requests).toEqual([]);
  });

  it("refuses an address that is not http or https without asking the provider", async () => {
    const { ai, cached, dependencies } = world();
    expect(await suggestWithAi(dependencies, { url: "javascript:alert(1)", locale: "en" })).toEqual({ kind: "url_refused", reason: "not_http" });
    expect(ai.requests).toEqual([]);
    expect(cached).toEqual([]);
  });
});

describe("the provider and the cache", () => {
  it("asks the provider with the canonical URL, the language in lower case, the metadata and the member's own tag names, and caches the answer for 30 days' key", async () => {
    const { ai, cached, dependencies } = world({ tags: ["Reading", "work"] });
    ai.respondWith({ title: "The docs", slug: "docs", tags: ["Reading"], confidence: 0.9 });

    const outcome = await suggestWithAi(dependencies, { url: "HTTPS://Example.test/docs/?utm_source=feed#top", locale: " DE-at ", metadata: { title: "Docs", description: "All of them" } });

    expect(outcome).toEqual({ kind: "suggested", cached: false, suggestion: { title: "The docs", slug: "docs", tags: ["Reading"], confidence: 0.9 } });
    expect(ai.requests).toEqual([{ url: URL_ONE, language: "de-at", metadata: { title: "Docs", description: "All of them" }, tags: ["Reading", "work"] }]);
    expect(cached).toEqual([{ urlCanonical: URL_ONE, locale: "de-at", result: { title: "The docs", slug: "docs", tags: ["Reading"], confidence: 0.9 }, provider: "Example AI", model: "model-1" }]);
  });

  it("holds no transaction while the provider is asked", async () => {
    const { ai, open, dependencies } = world();

    await suggestWithAi(dependencies, ASK);

    expect(ai.requests).toHaveLength(1);
    expect(open.whileAsked).toBe(0);
    expect(open.now).toBe(0);
  });

  it("serves a cached suggestion without asking the provider, whatever metadata the later request sends", async () => {
    const { ai, dependencies } = world();
    await suggestWithAi(dependencies, { ...ASK, metadata: { title: "First" } });
    expect(ai.requests).toHaveLength(1);

    const second = await suggestWithAi(dependencies, { ...ASK, metadata: { title: "Another" } });

    expect(second).toMatchObject({ kind: "suggested", cached: true });
    expect(ai.requests).toHaveLength(1);
  });

  it("keeps a cache for each language", async () => {
    const { ai, dependencies } = world();
    await suggestWithAi(dependencies, ASK);
    await suggestWithAi(dependencies, { ...ASK, locale: "de" });
    expect(ai.requests.map((request) => request.language)).toEqual(["en", "de"]);
  });

  it.each(["ai_failed", "ai_timeout", "ai_invalid_response"] as const)("answers failed for a provider that fails with %s and caches nothing", async (code) => {
    const { ai, cached, dependencies } = world();
    ai.failWith(code);
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "failed" });
    expect(cached).toEqual([]);
  });

  it("answers failed for a provider that does not answer within the budget, caches nothing, and drops a late answer and a late failure", async () => {
    const late: { reject?: (error: Error) => void } = {};
    const { cached, dependencies } = world({
      timeoutMs: 20,
      port: () => ({ available: true, suggest: () => new Promise((_resolve, reject) => { late.reject = reject; }) }),
    });
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "failed" });
    late.reject?.(new Error("too late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cached).toEqual([]);
  });

  it("answers failed for an answer that cannot be used (an empty title, a NUL, a confidence that is not a number) and caches nothing", async () => {
    for (const answer of [
      { title: "  ", slug: "docs", tags: [], confidence: 0.5 },
      { title: "Bad\u0000title", slug: "docs", tags: [], confidence: 0.5 },
      { title: "x".repeat(301), slug: "docs", tags: [], confidence: 0.5 },
      { title: "Docs", slug: "docs", tags: [], confidence: Number.NaN },
    ]) {
      const { ai, cached, dependencies } = world();
      ai.respondWith(answer);
      expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "failed" });
      expect(cached).toEqual([]);
    }
  });

  it("answers failed for a title or a tag that holds a lone surrogate, which the cache cannot store, and caches nothing", async () => {
    for (const answer of [
      { title: "A\ud83dB", slug: "docs", tags: [], confidence: 0.5 },
      { title: "Docs", slug: "docs", tags: ["t\ude00u"], confidence: 0.5 },
      { title: "Docs", slug: "docs", tags: ["fine", "ok", "x\ud83d"], confidence: 0.5 },
    ]) {
      const { ai, cached, dependencies } = world();
      ai.respondWith(answer);
      expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "failed" });
      expect(cached).toEqual([]);
    }
  });

  it("keeps a title and tags that hold a surrogate pair", async () => {
    const { ai, dependencies } = world();
    ai.respondWith({ title: "Docs \u{1F4DA}", slug: "docs", tags: ["\u{1F4D6}"], confidence: 0.5 });
    expect(await suggestWithAi(dependencies, ASK)).toMatchObject({ kind: "suggested", suggestion: { title: "Docs \u{1F4DA}", tags: ["\u{1F4D6}"] } });
  });

  it("answers not found, and returns nothing, for a member who left the workspace while the provider answered", async () => {
    const { ai, cached, dependencies } = world({ memberLeft: true });
    expect(await suggestWithAi(dependencies, ASK)).toEqual({ kind: "not_found" });
    expect(ai.requests).toHaveLength(1);
    expect(cached).toEqual([]);
  });

  it("treats a cached row that does not pass the checks as a miss and replaces it", async () => {
    const { ai, cache, cached, dependencies } = world();
    cache.set(`${URL_ONE}|en`, { title: 42, slug: "docs", tags: [], confidence: 0.5 });
    expect(await suggestWithAi(dependencies, ASK)).toMatchObject({ kind: "suggested", cached: false });
    expect(ai.requests).toHaveLength(1);
    expect(cached).toHaveLength(1);
  });

  it("clamps the confidence to 0 to 1", async () => {
    const { ai, dependencies } = world();
    ai.respondWith({ title: "Docs", slug: "docs", tags: [], confidence: 7 });
    expect(await suggestWithAi(dependencies, ASK)).toMatchObject({ suggestion: { confidence: 1 } });
  });
});

describe("what is returned", () => {
  it("drops a slug outside the grammar when it is cached, and keeps the rest of the suggestion", async () => {
    const { ai, cached, dependencies } = world();
    ai.respondWith({ title: "Docs", slug: "-not a slug-", tags: [], confidence: 0.4 });
    expect(await suggestWithAi(dependencies, ASK)).toMatchObject({ suggestion: { title: "Docs", slug: null } });
    expect(cached[0]?.result.slug).toBeNull();
  });

  it("drops a slug the member already uses, also from a cached suggestion for a slug the member took after it was cached", async () => {
    const taken: string[] = [];
    const { ai, dependencies } = world({ takenSlugs: taken });
    ai.respondWith({ title: "Docs", slug: "docs", tags: [], confidence: 0.4 });
    expect(await suggestWithAi(dependencies, ASK)).toMatchObject({ suggestion: { slug: "docs" } });

    taken.push("docs");
    expect(await suggestWithAi(dependencies, ASK)).toMatchObject({ cached: true, suggestion: { slug: null } });
    expect(ai.requests).toHaveLength(1);
  });

  it("returns the member's own spelling of a tag first, then the new ones, at most five, without repeats", async () => {
    const { ai, dependencies } = world({ tags: ["Reading", "Work"] });
    ai.respondWith({ title: "Docs", slug: "docs", tags: ["alpha", "work", "beta", "WORK", "gamma", "reading", "delta", "epsilon"], confidence: 0.4 });
    const outcome = await suggestWithAi(dependencies, ASK);
    expect(outcome).toMatchObject({ kind: "suggested" });
    expect(outcome.kind === "suggested" ? outcome.suggestion.tags : []).toEqual(["Work", "Reading", "alpha", "beta", "gamma"]);
  });

  it("drops a tag that is not a tag name (empty, over-long, with a NUL or not a string)", async () => {
    const { ai, dependencies } = world();
    ai.respondWith({ title: "Docs", slug: "docs", tags: ["fine", "  ", "x".repeat(41), "a\u0000b", 7, "also fine"] as unknown as string[], confidence: 0.4 });
    const outcome = await suggestWithAi(dependencies, ASK);
    expect(outcome.kind === "suggested" ? outcome.suggestion.tags : []).toEqual(["fine", "also fine"]);
  });
});
