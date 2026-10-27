import { describe, expect, it } from "vitest";
import { SEARCH_QUERY_MAX_LENGTH, normalizeSearchQuery, search, type BookmarkHit, type FolderHit, type SearchStore, type TagHit } from "../../src/index.ts";

// The search service (doc 02 section 9.1): it cleans the query up, decides the groups and how many results of each, and leaves matching and ranking to the store.

const ME = "0192F3A0-BBBB-7000-8000-00000000000A";

const BOOKMARK: BookmarkHit = { id: "b1", title: "Mail", url: "https://mail.example.com/", host: "mail.example.com", slug: "mail", forwarding: true, pinned: false };
const FOLDER: FolderHit = { id: "f1", name: "Mail", icon: "folder", color: 1 };
const TAG: TagHit = { id: "t1", name: "mail" };

function recordingStore() {
  const asked: { type: string; request: Record<string, unknown> }[] = [];
  const store: SearchStore = {
    bookmarks: (request) => {
      asked.push({ type: "bookmark", request });
      return Promise.resolve([BOOKMARK]);
    },
    folders: (request) => {
      asked.push({ type: "folder", request });
      return Promise.resolve([FOLDER]);
    },
    tags: (request) => {
      asked.push({ type: "tag", request });
      return Promise.resolve([TAG]);
    },
  };
  return { store, asked };
}

describe("the query", () => {
  it("is trimmed, its runs of white space become one space and its control characters, the NUL among them, become white space", () => {
    expect(normalizeSearchQuery("  a   b\t\nc  ")).toBe("a b c");
    expect(normalizeSearchQuery("a\u0000b")).toBe("a b");
    expect(normalizeSearchQuery("\u0000\u0007")).toBe("");
    expect(normalizeSearchQuery("a​b c")).toBe("a b c");
  });

  it("keeps query syntax as the text it is", () => {
    expect(normalizeSearchQuery("a & b | !c :* 100% a_b \\ ' \"")).toBe("a & b | !c :* 100% a_b \\ ' \"");
  });

  it("is Unicode-normalised, and cut to its first hundred characters", () => {
    expect(normalizeSearchQuery("ｆｕｌｌ")).toBe("full");
    expect(normalizeSearchQuery("x".repeat(250))).toBe("x".repeat(SEARCH_QUERY_MAX_LENGTH));
    expect(Array.from(normalizeSearchQuery("😀".repeat(150)))).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
    expect(normalizeSearchQuery(`${"a".repeat(99)} b`)).toBe("a".repeat(99));
  });
});

describe("the search", () => {
  it("asks the three groups for 8, 4 and 4 results by default, as the account in lower case", async () => {
    const { store, asked } = recordingStore();

    const results = await search({ store }, { accountId: ME, query: "  mail " });

    expect(results).toEqual({ bookmarks: [BOOKMARK], folders: [FOLDER], tags: [TAG] });
    expect(asked).toEqual([
      { type: "bookmark", request: { text: "mail", limit: 8 } },
      { type: "folder", request: { accountId: ME.toLowerCase(), text: "mail", limit: 4 } },
      { type: "tag", request: { accountId: ME.toLowerCase(), text: "mail", limit: 4 } },
    ]);
  });

  it("applies a limit to each type, at most twenty", async () => {
    const { store, asked } = recordingStore();

    await search({ store }, { accountId: ME, query: "mail", limit: 12 });
    await search({ store }, { accountId: ME, query: "mail", limit: 500 });
    await search({ store }, { accountId: ME, query: "mail", limit: 0 });

    expect(asked.map((entry) => entry.request["limit"])).toEqual([12, 12, 12, 20, 20, 20, 1, 1, 1]);
  });

  it("asks only the types it is given, and answers an empty list for the others", async () => {
    const { store, asked } = recordingStore();

    const results = await search({ store }, { accountId: ME, query: "mail", types: ["tag"] });

    expect(results).toEqual({ bookmarks: [], folders: [], tags: [TAG] });
    expect(asked.map((entry) => entry.type)).toEqual(["tag"]);
  });

  it("asks nothing for a query with nothing to search for", async () => {
    const { store, asked } = recordingStore();

    expect(await search({ store }, { accountId: ME, query: " \u0000 " })).toEqual({ bookmarks: [], folders: [], tags: [] });
    expect(asked).toEqual([]);
  });

  it("passes the store the cleaned text, never the raw query", async () => {
    const { store, asked } = recordingStore();

    await search({ store }, { accountId: ME, query: "a\u0000b   & c" });

    expect(asked[0]?.request["text"]).toBe("a b & c");
  });
});
