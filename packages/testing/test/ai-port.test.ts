import { AiSuggestError, type AiSuggestErrorCode, type AiSuggestPort } from "@slugbase/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { FakeAi, FakeAiError, type FakeAiErrorCode } from "../src/index.ts";

// Doc 08 section 3.1: the in-memory ports are checked against the ports they stand in for here, in
// @slugbase/testing, because @slugbase/testing-ports imports no workspace package.
describe("FakeAi against AiSuggestPort", () => {
  it("is assignable to the port, so a change to the port that the fake does not follow fails the typecheck", () => {
    expectTypeOf<FakeAi>().toExtend<AiSuggestPort>();
    const port: AiSuggestPort = new FakeAi();
    expect(port.available).toBe(true);
  });

  it("throws errors that carry the code, name and message of the port's errors", () => {
    expectTypeOf<FakeAiErrorCode>().toEqualTypeOf<AiSuggestErrorCode>();
    for (const code of ["ai_failed", "ai_timeout", "ai_invalid_response"] as const) {
      const real = new AiSuggestError(code);
      const fake = new FakeAiError(code);
      expect([fake.code, fake.name, fake.message]).toEqual([real.code, real.name, real.message]);
    }
  });

  it("answers the same way for the same request: the page title, the host as the slug, the first five tags", async () => {
    const ai = new FakeAi();
    const request = {
      url: "https://Docs.Example.com/guide",
      language: "en",
      metadata: { title: "The guide" },
      tags: ["a", "b", "c", "d", "e", "f"],
    };
    const first = await ai.suggest(request);
    expect(first).toEqual({ title: "The guide", slug: "docs-example-com", tags: ["a", "b", "c", "d", "e"], confidence: 0.5 });
    expect(await ai.suggest(request)).toEqual(first);
  });

  it("falls back to the host as the title when the page has none", async () => {
    expect((await new FakeAi().suggest({ url: "https://example.org/", language: "de", tags: [] })).title).toBe("example.org");
  });

  it("keeps a copy of every request, so a test reads what would have been sent", async () => {
    const ai = new FakeAi();
    const tags = ["x"];
    await ai.suggest({ url: "https://example.org/", language: "en", tags });
    tags.push("changed");
    expect(ai.requests.map((request) => request.tags)).toEqual([["x"]]);
  });

  it("answers what a test sets, fails with the code of the real adapter, and goes back to the default", async () => {
    const ai = new FakeAi();
    const set = { title: "Set", slug: "set", tags: ["t"], confidence: 1 };
    ai.respondWith(set);
    expect(await ai.suggest({ url: "https://example.org/", language: "en", tags: [] })).toEqual(set);
    ai.failWith("ai_timeout");
    const error = await ai.suggest({ url: "https://example.org/", language: "en", tags: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FakeAiError);
    expect(error).toMatchObject({ code: "ai_timeout" });
    ai.reset();
    expect(ai.requests).toEqual([]);
    expect((await ai.suggest({ url: "https://example.org/", language: "en", tags: [] })).confidence).toBe(0.5);
  });
});
