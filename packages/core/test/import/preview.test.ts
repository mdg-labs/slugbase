import type { ImportRequest } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { previewImport, readImportBookmark, type ImportPreviewAsk, type ImportPreviewStore } from "../../src/index.ts";

// The preview of a SlugBase JSON import (doc 02 section 13.1, doc 01 section 7.5, doc 10 T13): what an import of the file would do, from the counter and the caller's canonical URLs, and nothing written.

interface Calls {
  count: number;
  lookups: (readonly string[])[];
}

function store(options: { count?: number | undefined; existing?: readonly string[] } = {}): { store: ImportPreviewStore; calls: Calls } {
  const calls: Calls = { count: 0, lookups: [] };
  const existing = new Set(options.existing ?? []);
  return {
    calls,
    store: {
      bookmarkCount: () => {
        calls.count += 1;
        return Promise.resolve("count" in options ? options.count : 0);
      },
      existingCanonicalUrls: (canonicals) => {
        calls.lookups.push(canonicals);
        return Promise.resolve(new Set(canonicals.filter((canonical) => existing.has(canonical))));
      },
    },
  };
}

const ask = (file: ImportRequest, overrides: Partial<ImportPreviewAsk> = {}): ImportPreviewAsk => ({ file, skipDuplicates: true, ceiling: "unlimited", ...overrides });
const urls = (...values: string[]) => values.map((url) => ({ url }));

async function preview(file: ImportRequest, overrides: Partial<ImportPreviewAsk> = {}, options: Parameters<typeof store>[0] = {}) {
  const { store: fake, calls } = store(options);
  const outcome = await previewImport({ store: fake }, ask(file, overrides));
  if (outcome.kind !== "previewed") {
    throw new Error("the workspace was unavailable");
  }
  return { result: outcome.result, calls };
}

describe("readImportBookmark", () => {
  it("normalises the URL, cuts the title and the description by code points, and falls back to the host for a blank title", () => {
    const long = "😀".repeat(2000);
    expect(readImportBookmark({ url: "  HTTPS://Example.com:443/a/?utm_source=x#frag ", title: long, description: long }, 4)).toEqual({
      position: 4,
      url: "https://example.com/a/?utm_source=x#frag",
      canonical: "https://example.com/a",
      title: "😀".repeat(300),
      description: "😀".repeat(1000),
    });
    expect(readImportBookmark({ url: "https://example.com/", title: " \u0000 " }, 1)).toMatchObject({ title: "example.com", description: null });
    expect(readImportBookmark({ url: "https://example.com/", title: null, description: null }, 1)).toMatchObject({ title: "example.com", description: null });
  });

  it("refuses a URL that is not http or https as url_not_allowed, and one that is empty, over-long or malformed as url_invalid, with the URL and title made plain", () => {
    expect(readImportBookmark({ url: "javascript:alert(1)", title: "T\u0000" }, 2)).toEqual({ position: 2, title: "T", url: "javascript:alert(1)", reason: "url_not_allowed" });
    expect(readImportBookmark({ url: "data:text/html,<b>x</b>" }, 1)).toMatchObject({ reason: "url_not_allowed" });
    expect(readImportBookmark({ url: "https://exa\u0000mple.com/" }, 1)).toEqual({ position: 1, title: "", url: "https://example.com/", reason: "url_invalid" });
    expect(readImportBookmark({ url: "" }, 1)).toMatchObject({ reason: "url_invalid" });
    const huge = readImportBookmark({ url: `https://${"a".repeat(10_000)}` }, 1);
    expect(huge).toMatchObject({ reason: "url_invalid" });
    expect((huge as { url: string }).url).toHaveLength(2048);
  });
});

describe("previewImport", () => {
  it("is unavailable when the workspace's counter cannot be read, and looks nothing else up", async () => {
    const { store: fake, calls } = store({ count: undefined });

    await expect(previewImport({ store: fake }, ask(urls("https://example.com/")))).resolves.toEqual({ kind: "unavailable" });
    expect(calls.lookups).toEqual([]);
  });

  it("reads an envelope and a plain array alike", async () => {
    const plain = await preview(urls("https://example.com/a", "https://example.com/b"));
    const envelope = await preview({ format: "slugbase-export", version: 1, bookmarks: urls("https://example.com/a", "https://example.com/b") });

    expect(plain.result).toEqual(envelope.result);
    expect(plain.result.created).toBe(2);
  });

  it("looks up the distinct canonical URLs of the valid bookmarks once, and reports the duplicates against the caller and within the file in the order of the file", async () => {
    const { result, calls } = await preview(
      urls("https://example.com/mine", "https://example.com/new?a=1&b=2", "bogus", "https://EXAMPLE.com/new/?b=2&a=1&utm_medium=x", "https://example.com/other"),
      {},
      { existing: ["https://example.com/mine"] },
    );

    expect(calls.lookups).toEqual([["https://example.com/mine", "https://example.com/new?a=1&b=2", "https://example.com/other"]]);
    expect(result.created).toBe(2);
    expect(result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [1, "duplicate"],
      [4, "duplicate"],
    ]);
    expect(result.failed.map((entry) => [entry.position, entry.reason])).toEqual([[3, "url_not_allowed"]]);
  });

  it("imports duplicates when skipDuplicates is false, and does not look them up", async () => {
    const { result, calls } = await preview(urls("https://example.com/a", "https://example.com/a"), { skipDuplicates: false }, { existing: ["https://example.com/a"] });

    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(calls.lookups).toEqual([]);
  });

  it("creates at most the ceiling less the counter, in the order of the file, and reports the rest as bookmark_limit_reached", async () => {
    const { result } = await preview(urls("https://example.com/1", "https://example.com/2", "https://example.com/3", "bogus", "https://example.com/4"), { ceiling: 5 }, { count: 3 });

    expect(result.created).toBe(2);
    expect(result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [3, "bookmark_limit_reached"],
      [5, "bookmark_limit_reached"],
    ]);
    expect(result.failed.map((entry) => entry.position)).toEqual([4]);
  });

  it("creates nothing at or over the ceiling, whatever the counter says", async () => {
    for (const count of [5, 9]) {
      const { result } = await preview(urls("https://example.com/1"), { ceiling: 5 }, { count });
      expect(result.created).toBe(0);
      expect(result.skipped).toEqual([{ position: 1, title: "example.com", url: "https://example.com/1", reason: "bookmark_limit_reached" }]);
    }
    expect((await preview(urls("https://example.com/1"), { ceiling: 0 })).result.created).toBe(0);
  });

  it("has no limit under an unlimited ceiling", async () => {
    const file = Array.from({ length: 5000 }, (_, index) => ({ url: `https://example.com/${String(index)}` }));
    expect((await preview(file, { ceiling: "unlimited" }, { count: 1_000_000 })).result.created).toBe(5000);
  });

  it("judges a duplicate before the room, so a duplicate is never reported as past the limit", async () => {
    const { result } = await preview(urls("https://example.com/a", "https://example.com/a", "https://example.com/b"), { ceiling: 1 });

    expect(result.created).toBe(1);
    expect(result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [2, "duplicate"],
      [3, "bookmark_limit_reached"],
    ]);
  });

  it("ignores the plan-archived flag of the file and the shared list", async () => {
    const { result } = await preview(
      { format: "slugbase-export", version: 1, bookmarks: [{ url: "https://example.com/a", planArchived: true }, { url: "https://example.com/b", planArchived: false }], shared: [] },
      { ceiling: 2 },
    );

    expect(result.created).toBe(2);
  });

  it("detects the bookmarks, and the distinct folder and tag names without regard to case, from the document's lists and the bookmarks alike", async () => {
    const { result } = await preview({
      format: "slugbase-export",
      version: 1,
      folders: [{ name: "Reading" }, { name: "Work", icon: "briefcase", color: 3 }],
      tags: ["News", "later"],
      bookmarks: [
        { url: "https://example.com/a", folders: ["reading", " READING ", "Home"], tags: ["NEWS", "x\u0000y"] },
        { url: "https://example.com/b", folders: ["", "\u0000"], tags: ["xy"] },
      ],
    });

    expect(result.detected).toEqual({ bookmarks: 2, folders: 3, tags: 3 });
  });

  it("reports what the later parts will fill as nothing", async () => {
    const { result } = await preview([{ url: "https://example.com/a", slug: "a", folders: ["F"], tags: ["T"] }]);

    expect(result).toMatchObject({ slugsDropped: 0, droppedSlugs: [], foldersCreated: 0, tagsCreated: 0 });
  });

  it("echoes a title and a URL cut to their limits, plain text, and nothing of the description", async () => {
    const { result } = await preview(
      [
        { url: "https://example.com/a", title: "\u0000" + "😀".repeat(400), description: "secret" },
        { url: "https://example.com/a", title: "second" },
      ],
    );

    expect(result.skipped).toEqual([{ position: 2, title: "second", url: "https://example.com/a", reason: "duplicate" }]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
