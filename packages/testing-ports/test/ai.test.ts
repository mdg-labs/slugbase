import { describe, expect, it } from "vitest";
import { FakeAi, FakeAiError } from "../src/index.ts";

const request = { url: "https://Docs.Example.com/guide", language: "en", metadata: { title: "The guide" }, tags: ["a", "b", "c", "d", "e", "f"] };

describe("FakeAi", () => {
  it("answers the same way for the same request: the page title, the host as the slug, the first five tags", async () => {
    const ai = new FakeAi();
    const first = await ai.suggest(request);
    expect(first).toEqual({ title: "The guide", slug: "docs-example-com", tags: ["a", "b", "c", "d", "e"], confidence: 0.5 });
    expect(await ai.suggest(request)).toEqual(first);
  });

  it("falls back to the host as the title, and to a fixed slug for a request that is no URL", async () => {
    const ai = new FakeAi();
    expect((await ai.suggest({ url: "https://example.org/", language: "de", tags: [] })).title).toBe("example.org");
    expect((await ai.suggest({ url: "---", language: "de", tags: [] })).slug).toBe("bookmark");
  });

  it("keeps a copy of every request", async () => {
    const ai = new FakeAi();
    const tags = ["x"];
    await ai.suggest({ url: "https://example.org/", language: "en", tags });
    tags.push("changed");
    expect(ai.requests.map((kept) => kept.tags)).toEqual([["x"]]);
  });

  it("answers what a test sets, fails with a FakeAiError, and goes back to the default", async () => {
    const ai = new FakeAi();
    const set = { title: "Set", slug: "set", tags: ["t"], confidence: 1 };
    ai.respondWith(set);
    expect(await ai.suggest(request)).toEqual(set);
    ai.failWith("ai_timeout");
    const error = await ai.suggest(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FakeAiError);
    expect(error).toMatchObject({ code: "ai_timeout", name: "AiSuggestError" });
    ai.respondWith(set);
    expect(await ai.suggest(request)).toEqual(set);
    ai.reset();
    expect(ai.requests).toEqual([]);
    expect((await ai.suggest(request)).confidence).toBe(0.5);
  });
});
