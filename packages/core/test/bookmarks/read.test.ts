import { describe, expect, it } from "vitest";
import { readBookmark, type BookmarkRecord } from "../../src/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-00000000000A";
const OTHER = "0192f3a0-bbbb-7000-8000-00000000000b";
const BOOKMARK = "0192f3a0-aaaa-7000-8000-000000000001";

const OWN: BookmarkRecord = {
  id: BOOKMARK,
  ownerId: ACCOUNT.toLowerCase(),
  url: "https://example.com/docs",
  host: "example.com",
  title: "Docs",
  description: null,
  slug: null,
  forwarding: false,
  pinned: true,
  openCount: 0,
  lastOpenedAt: null,
  owner: null,
  sharedVia: null,
  folders: [],
  tags: [],
  version: 1,
  createdAt: new Date("2026-10-23T05:00:00.000Z"),
  updatedAt: new Date("2026-10-23T05:00:00.000Z"),
};

const SHARED: BookmarkRecord = { ...OWN, ownerId: OTHER, owner: { accountId: OTHER, displayName: "Olga Owner" }, sharedVia: "direct", pinned: false };

const reading = (bookmark: BookmarkRecord | undefined) => ({ store: { find: () => Promise.resolve(bookmark) } });

describe("readBookmark", () => {
  it("answers the caller's own bookmark and one that is shared with them, which names its owner and how it is shared", async () => {
    expect(await readBookmark(reading(OWN), { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual(OWN);
    expect(await readBookmark(reading(SHARED), { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual(SHARED);
  });

  it("answers a bookmark of a departed owner that is shared with the caller, without an owner", async () => {
    const departed: BookmarkRecord = { ...SHARED, ownerId: null, owner: null, sharedVia: "folder" };

    expect(await readBookmark(reading(departed), { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toEqual(departed);
  });

  it("answers nothing when the store finds none, and nothing for a record that is neither the caller's own nor shared with them", async () => {
    expect(await readBookmark(reading(undefined), { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toBeUndefined();
    expect(await readBookmark(reading({ ...OWN, ownerId: OTHER }), { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toBeUndefined();
    expect(await readBookmark(reading({ ...OWN, ownerId: null }), { bookmarkId: BOOKMARK, accountId: ACCOUNT })).toBeUndefined();
  });
});
