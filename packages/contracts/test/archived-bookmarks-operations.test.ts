import { describe, expect, it } from "vitest";
import { ArchivedBookmarkListSchema, ArchivedBookmarkSchema, BOOKMARK_LIST_DEFAULT_LIMIT, ListArchivedBookmarksQuerySchema, listArchivedBookmarks, operations } from "../src/index.ts";

// The plan-archived bookmarks of doc 04 section 10.6: the caller's own, in the workspace of the request, as a member with the read scope of a token.

const UUID = "0192f3a0-aaaa-7000-8000-00000000a0b1";
const BOOKMARK = {
  id: UUID,
  ownerId: UUID,
  url: "https://example.com/",
  host: "example.com",
  title: "Example",
  description: null,
  slug: null,
  forwarding: false,
  pinned: false,
  openCount: 0,
  lastOpenedAt: null,
  folders: [],
  tags: [],
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const ITEM = { ...BOOKMARK, planArchivedAt: "2026-02-01T10:00:00.000Z" };

describe("the archived bookmarks operation", () => {
  it("is GET /api/v1/bookmarks/archived, a member's read of the bookmarks tag, and is among the operations", () => {
    expect(listArchivedBookmarks).toMatchObject({ method: "get", path: "/api/v1/bookmarks/archived", operationId: "listArchivedBookmarks", tag: "bookmarks", auth: "member", rate: "read", scope: "read" });
    expect(operations).toContain(listArchivedBookmarks);
  });

  it("declares the answers a client has to handle", () => {
    expect(Object.keys(listArchivedBookmarks.responses).map(Number)).toEqual(expect.arrayContaining([200, 400, 401, 404, 422, 429, 503]));
  });
});

describe("the query", () => {
  it("takes a limit of 1 to 100, the list's default when left out, and a cursor, and no filter, scope or sort", () => {
    expect(ListArchivedBookmarksQuerySchema.parse({})).toEqual({ limit: BOOKMARK_LIST_DEFAULT_LIMIT });
    expect(ListArchivedBookmarksQuerySchema.parse({ limit: "100", cursor: "abc" })).toEqual({ limit: 100, cursor: "abc" });
    expect(ListArchivedBookmarksQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListArchivedBookmarksQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(ListArchivedBookmarksQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    for (const extra of [{ scope: "all" }, { sort: "recent" }, { q: "a" }, { folderId: UUID }, { tag: UUID }]) {
      expect(ListArchivedBookmarksQuerySchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe("the page", () => {
  it("carries the fields of a bookmark and the instant it was archived, which every item needs", () => {
    expect(ArchivedBookmarkSchema.safeParse(ITEM).success).toBe(true);
    expect(ArchivedBookmarkSchema.safeParse(BOOKMARK).success).toBe(false);
    expect(ArchivedBookmarkSchema.safeParse({ ...ITEM, planArchivedAt: "yesterday" }).success).toBe(false);
    expect(ArchivedBookmarkSchema.safeParse({ ...ITEM, planArchivedAt: null }).success).toBe(false);
  });

  it("has the cursor of the next page and a total that is null above the cap, where totalAtLeast says so", () => {
    expect(ArchivedBookmarkListSchema.safeParse({ items: [ITEM], nextCursor: null, total: 1 }).success).toBe(true);
    expect(ArchivedBookmarkListSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(true);
    expect(ArchivedBookmarkListSchema.safeParse({ items: [ITEM], nextCursor: "abc", total: null, totalAtLeast: 10_000 }).success).toBe(true);
    expect(ArchivedBookmarkListSchema.safeParse({ items: [ITEM], nextCursor: null, total: null, totalAtLeast: 5 }).success).toBe(false);
    expect(ArchivedBookmarkListSchema.safeParse({ items: [ITEM], total: 1 }).success).toBe(false);
  });
});
