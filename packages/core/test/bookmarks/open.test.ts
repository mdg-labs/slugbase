import { describe, expect, it } from "vitest";
import { openBookmark, type BookmarkRecord } from "../../src/index.ts";

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
  version: 1,
  createdAt: new Date("2026-10-23T05:00:00.000Z"),
  updatedAt: new Date("2026-10-23T05:00:00.000Z"),
};

function opening(bookmark: BookmarkRecord | undefined) {
  const recorded: string[] = [];
  return {
    recorded,
    dependencies: {
      store: { find: () => Promise.resolve(bookmark) },
      usage: { record: (bookmarkId: string) => void recorded.push(bookmarkId) },
    },
  };
}

describe("openBookmark", () => {
  it("answers the destination of the caller's bookmark and counts one open of it", async () => {
    const { recorded, dependencies } = opening(STORED);

    const outcome = await openBookmark(dependencies, { bookmarkId: BOOKMARK, accountId: ACCOUNT });

    expect(outcome).toEqual({ kind: "opened", url: "https://example.com/docs" });
    expect(recorded).toEqual([BOOKMARK]);
  });

  it("is not_found, counting nothing, for a bookmark the store does not find", async () => {
    const { recorded, dependencies } = opening(undefined);

    expect(await openBookmark(dependencies, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual({ kind: "not_found" });
    expect(recorded).toEqual([]);
  });

  it("is the same not_found, counting nothing, for a bookmark another member owns or that has no owner", async () => {
    const other = opening({ ...STORED, ownerId: "0192f3a0-bbbb-7000-8000-00000000000b" });
    const ownerless = opening({ ...STORED, ownerId: null });

    expect(await openBookmark(other.dependencies, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual({ kind: "not_found" });
    expect(await openBookmark(ownerless.dependencies, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual({ kind: "not_found" });
    expect(other.recorded).toEqual([]);
    expect(ownerless.recorded).toEqual([]);
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "//example.com/path", "ftp://example.com/file", ""])(
    "checks the stored URL again and refuses %j without counting the open",
    async (url) => {
      const { recorded, dependencies } = opening({ ...STORED, url });

      expect(await openBookmark(dependencies, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual({ kind: "url_refused" });
      expect(recorded).toEqual([]);
    },
  );

  it("never counts an open the caller was not answered", async () => {
    const { recorded, dependencies } = opening(STORED);
    const failing = {
      ...dependencies,
      store: { find: () => Promise.reject(new Error("the database is away")) },
    };

    await expect(openBookmark(failing, { bookmarkId: BOOKMARK, accountId: ACCOUNT })).rejects.toThrow("the database is away");
    expect(recorded).toEqual([]);
  });
});
