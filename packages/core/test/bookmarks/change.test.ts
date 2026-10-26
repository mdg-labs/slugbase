import { describe, expect, it } from "vitest";
import {
  deleteBookmark,
  updateBookmark,
  type BookmarkRecord,
  type BookmarkUpdateAsk,
  type BookmarkUpdateRequest,
  type BookmarkUpdateResult,
} from "../../src/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-00000000000A";
const BOOKMARK = "0192f3a0-aaaa-7000-8000-000000000001";

const STORED: BookmarkRecord = {
  id: BOOKMARK,
  ownerId: ACCOUNT.toLowerCase(),
  url: "https://example.com/docs",
  host: "example.com",
  title: "Docs",
  description: null,
  slug: null,
  forwarding: false,
  pinned: false,
  openCount: 0,
  lastOpenedAt: null,
  folders: [],
  tags: [],
  version: 1,
  createdAt: new Date("2026-10-23T05:00:00.000Z"),
  updatedAt: new Date("2026-10-23T05:00:00.000Z"),
};

function updating(answer: BookmarkUpdateResult = { kind: "updated", bookmark: STORED }) {
  const requests: BookmarkUpdateRequest[] = [];
  let issued = 0;
  return {
    requests,
    dependencies: {
      newId: () => `0192f3a0-eeee-7000-8000-${String((issued += 1)).padStart(12, "0")}`,
      store: {
        update(request: BookmarkUpdateRequest) {
          requests.push(request);
          return Promise.resolve(answer);
        },
      },
    },
  };
}

const ASKING: BookmarkUpdateAsk = { bookmarkId: BOOKMARK, accountId: ACCOUNT, patch: {}, expectedVersions: undefined };

describe("updateBookmark", () => {
  it("hands the store the owner in lower case, the normalised URL with its canonical form and host, and only the fields the patch names", async () => {
    const { requests, dependencies } = updating();

    const outcome = await updateBookmark(dependencies, {
      ...ASKING,
      patch: { url: "HTTPS://Example.com:443/new/?b=2&a=1&utm_source=feed#top", title: "New", description: "The docs", pinned: true },
      expectedVersions: [3],
    });

    expect(outcome.kind).toBe("updated");
    expect(requests).toEqual([
      {
        bookmarkId: BOOKMARK,
        ownerId: ACCOUNT.toLowerCase(),
        changes: {
          url: { url: "https://example.com/new/?b=2&a=1&utm_source=feed#top", canonical: "https://example.com/new?a=1&b=2", host: "example.com" },
          title: "New",
          description: "The docs",
          pinned: true,
        },
        expectedVersions: [3],
      },
    ]);
  });

  it("leaves a field the patch leaves out out of the changes, and passes no precondition when the caller made none", async () => {
    const { requests, dependencies } = updating();

    await updateBookmark(dependencies, { ...ASKING, patch: { title: "Only the title" } });
    await updateBookmark(dependencies, ASKING);

    expect(requests[0]).toEqual({ bookmarkId: BOOKMARK, ownerId: ACCOUNT.toLowerCase(), changes: { title: "Only the title" }, expectedVersions: undefined });
    expect(requests[1]?.changes).toEqual({});
  });

  it("hands the store the folders the bookmark is to be in, in lower case and without repeats, and an empty list as the wish to be in none", async () => {
    const { requests, dependencies } = updating();
    const folder = "0192f3a0-dddd-7000-8000-00000000000A";

    await updateBookmark(dependencies, { ...ASKING, patch: { folderIds: [folder, folder.toLowerCase()] } });
    await updateBookmark(dependencies, { ...ASKING, patch: { folderIds: [] } });
    await updateBookmark(dependencies, { ...ASKING, patch: { title: "Only the title" } });

    expect(requests.map((request) => request.changes.folderIds)).toEqual([["0192f3a0-dddd-7000-8000-00000000000a"], [], undefined]);
  });

  it("hands the store the tags the bookmark is to carry: the identifiers in lower case without repeats, and the names trimmed, once for each name whatever its case, each with a fresh identifier", async () => {
    const { requests, dependencies } = updating();
    const tag = "0192f3a0-ffff-7000-8000-00000000000A";

    await updateBookmark(dependencies, { ...ASKING, patch: { tagIds: [tag, tag.toLowerCase()], tagNames: ["  Reading ", "reading", "Later"] } });
    await updateBookmark(dependencies, { ...ASKING, patch: { tagIds: [] } });
    await updateBookmark(dependencies, { ...ASKING, patch: { tagNames: [] } });
    await updateBookmark(dependencies, { ...ASKING, patch: { title: "Only the title" } });

    expect(requests.map((request) => request.changes.tags)).toEqual([
      {
        ids: ["0192f3a0-ffff-7000-8000-00000000000a"],
        names: [
          { name: "Reading", newId: "0192f3a0-eeee-7000-8000-000000000001" },
          { name: "Later", newId: "0192f3a0-eeee-7000-8000-000000000002" },
        ],
      },
      { ids: [], names: [] },
      { ids: [], names: [] },
      undefined,
    ]);
  });

  it("rejects a tag name that is empty or over 40 characters, which the contract has already refused, before the store is asked", async () => {
    const { requests, dependencies } = updating();

    await expect(updateBookmark(dependencies, { ...ASKING, patch: { tagNames: ["  "] } })).rejects.toThrow(RangeError);
    await expect(updateBookmark(dependencies, { ...ASKING, patch: { tagNames: ["t".repeat(41)] } })).rejects.toThrow(RangeError);
    await expect(updateBookmark(dependencies, { ...ASKING, patch: { tagNames: ["😀".repeat(40)] } })).resolves.toMatchObject({ kind: "updated" });
    expect(requests).toHaveLength(1);
  });

  it("clears the description for null and for an empty one, and keeps a description that has text", async () => {
    const { requests, dependencies } = updating();

    await updateBookmark(dependencies, { ...ASKING, patch: { description: null } });
    await updateBookmark(dependencies, { ...ASKING, patch: { description: "" } });
    await updateBookmark(dependencies, { ...ASKING, patch: { description: "Text" } });

    expect(requests.map((request) => request.changes.description)).toEqual([null, null, "Text"]);
  });

  it("refuses a URL that is not http or https, and an empty, over-long or malformed one, before the store is asked", async () => {
    const { requests, dependencies } = updating();

    const outcomes = await Promise.all(
      ["javascript:alert(1)", "data:text/html,x", "//example.com/", "", `https://example.com/${"a".repeat(2048)}`, "https://"].map((url) => updateBookmark(dependencies, { ...ASKING, patch: { url, title: "Ignored" } })),
    );

    expect(outcomes).toEqual([
      { kind: "url_refused", reason: "not_http" },
      { kind: "url_refused", reason: "not_http" },
      { kind: "url_refused", reason: "not_http" },
      { kind: "url_refused", reason: "empty" },
      { kind: "url_refused", reason: "too_long" },
      { kind: "url_refused", reason: "malformed" },
    ]);
    expect(requests).toEqual([]);
  });

  it("rejects a title or a description outside its length, which the contract has already refused, before the store is asked", async () => {
    const { requests, dependencies } = updating();

    await expect(updateBookmark(dependencies, { ...ASKING, patch: { title: "" } })).rejects.toThrow(RangeError);
    await expect(updateBookmark(dependencies, { ...ASKING, patch: { title: "t".repeat(301) } })).rejects.toThrow(RangeError);
    await expect(updateBookmark(dependencies, { ...ASKING, patch: { description: "d".repeat(1001) } })).rejects.toThrow(RangeError);
    await expect(updateBookmark(dependencies, { ...ASKING, patch: { title: "😀".repeat(300), description: "d".repeat(1000) } })).resolves.toMatchObject({ kind: "updated" });
    expect(requests).toHaveLength(1);
  });

  it.each([[{ kind: "stale" }], [{ kind: "not_found" }], [{ kind: "folder_not_found" }], [{ kind: "tag_not_found" }], [{ kind: "unchanged", bookmark: STORED }]] as const)("answers what the store answers: %j", async (answer) => {
    const { dependencies } = updating(answer);

    expect(await updateBookmark(dependencies, { ...ASKING, patch: { title: "X" } })).toEqual(answer);
  });
});

describe("deleteBookmark", () => {
  it("asks the store to delete the bookmark of the account in lower case, and answers what it answers", async () => {
    const asked: { bookmarkId: string; ownerId: string }[] = [];
    const store = {
      remove(request: { bookmarkId: string; ownerId: string }) {
        asked.push(request);
        return Promise.resolve(asked.length === 1);
      },
    };

    expect(await deleteBookmark({ store }, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toBe(true);
    expect(await deleteBookmark({ store }, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toBe(false);
    expect(asked).toEqual([
      { bookmarkId: BOOKMARK, ownerId: ACCOUNT.toLowerCase() },
      { bookmarkId: BOOKMARK, ownerId: ACCOUNT.toLowerCase() },
    ]);
  });
});
