import { describe, expect, it } from "vitest";
import { GO_SUGGEST_PREFIX_MAX_LENGTH, suggestSlugs, type GoSuggestionRecord } from "../../src/index.ts";

// The slug suggestions of the palette's go mode (doc 02 section 9.2, doc 04 section 10.8, doc 10 T12). The store decides which bookmarks the member can read and
// which forward; these tests give the service what a store would answer and look at what it asks.

const ME = "0192f3a0-bbbb-7000-8000-00000000000a";
const ANN = "0192f3a0-bbbb-7000-8000-00000000000b";

function record(slug: string, extra: Partial<GoSuggestionRecord> = {}): GoSuggestionRecord {
  return { bookmarkId: `0192f3a0-aaaa-7000-8000-${slug.padStart(12, "0")}`, slug, title: `Title ${slug}`, host: "example.com", ownerId: ME, ownerName: "Me", access: "owner", ...extra };
}

function storeOf(records: readonly GoSuggestionRecord[]) {
  const asked: { prefix: string; accountId: string; limit: number }[] = [];
  return {
    asked,
    store: {
      suggest: (request: { prefix: string; accountId: string; limit: number }) => {
        asked.push(request);
        return Promise.resolve(records);
      },
    },
  };
}

describe("suggestSlugs", () => {
  it("names the slug, the bookmark, its title and host, and no owner or sharing for the member's own bookmark", async () => {
    const { store } = storeOf([record("mail")]);

    expect(await suggestSlugs({ store }, { accountId: ME, prefix: "ma" })).toEqual([{ slug: "mail", bookmarkId: record("mail").bookmarkId, title: "Title mail", host: "example.com", owner: null, sharedVia: null }]);
  });

  it("names the owner and how a bookmark of another member is shared, and no owner for one whose owner has left", async () => {
    const { store } = storeOf([record("a", { ownerId: ANN, ownerName: "Ann", access: "team" }), record("b", { ownerId: null, ownerName: null, access: "folder" }), record("c", { ownerId: ANN, ownerName: "Ann", access: "direct" })]);

    const suggestions = await suggestSlugs({ store }, { accountId: ME, prefix: "a" });

    expect(suggestions.map(({ owner, sharedVia }) => [owner, sharedVia])).toEqual([
      [{ accountId: ANN, displayName: "Ann" }, "team"],
      [null, "folder"],
      [{ accountId: ANN, displayName: "Ann" }, "direct"],
    ]);
  });

  it("asks the store for the prefix trimmed and in lower case, for the account in lower case, and for at most ten", async () => {
    const { asked, store } = storeOf([]);

    await suggestSlugs({ store }, { accountId: ME.toUpperCase(), prefix: "  MaIl-  " });

    expect(asked).toEqual([{ prefix: "mail-", accountId: ME, limit: 10 }]);
  });

  it("hands `%`, `_` and `\\` to the store as the text they are, for it to escape", async () => {
    const { asked, store } = storeOf([]);

    for (const prefix of ["%", "_", "\\", "m%"]) {
      await suggestSlugs({ store }, { accountId: ME, prefix });
    }

    expect(asked.map((request) => request.prefix)).toEqual(["%", "_", "\\", "m%"]);
  });

  it("answers an empty prefix, one longer than a slug and one with a control character without asking the store", async () => {
    const { asked, store } = storeOf([record("mail")]);

    for (const prefix of ["", "   ", "\t\n", "m".repeat(GO_SUGGEST_PREFIX_MAX_LENGTH + 1), "ma\u0000il", "ma\u0007"]) {
      expect(await suggestSlugs({ store }, { accountId: ME, prefix }), JSON.stringify(prefix)).toEqual([]);
    }
    expect(asked).toEqual([]);
    expect(await suggestSlugs({ store }, { accountId: ME, prefix: "m".repeat(GO_SUGGEST_PREFIX_MAX_LENGTH) })).toHaveLength(1);
  });

  it("never names more than ten, whatever the store answers", async () => {
    const { store } = storeOf(Array.from({ length: 12 }, (_, n) => record(`s${String(n)}`)));

    expect(await suggestSlugs({ store }, { accountId: ME, prefix: "s" })).toHaveLength(10);
  });
});
