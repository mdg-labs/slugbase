import { describe, expect, it } from "vitest";
import {
  BOOKMARK_DESCRIPTION_MAX_LENGTH,
  BOOKMARK_TITLE_MAX_LENGTH,
  createBookmark,
  readBookmark,
  type BookmarkCreationAsk,
  type BookmarkCreationRequest,
  type BookmarkRecord,
  type BookmarkStoreResult,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const OTHER_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000002";

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

function recordOf(request: BookmarkCreationRequest): BookmarkRecord {
  const { id, ownerId, url, host, title, description, pinned } = request.bookmark;
  const now = new Date("2026-10-23T05:00:00.000Z");
  return { id, ownerId, url, host, title, description, slug: null, forwarding: false, pinned, openCount: 0, lastOpenedAt: null, version: 1, createdAt: now, updatedAt: now };
}

function world(answer: (request: BookmarkCreationRequest) => BookmarkStoreResult = (request) => ({ kind: "created", bookmark: recordOf(request) })) {
  const requests: BookmarkCreationRequest[] = [];
  return {
    requests,
    dependencies: {
      newId: ids(),
      store: {
        create(request: BookmarkCreationRequest) {
          requests.push(request);
          return Promise.resolve(answer(request));
        },
      },
    },
  };
}

const ASKING: BookmarkCreationAsk = {
  workspaceId: WORKSPACE,
  accountId: ACCOUNT,
  url: "HTTPS://Example.com:443/docs/?b=2&a=1&utm_source=feed#intro",
  title: "Docs",
  description: undefined,
  pinned: undefined,
  ceiling: "unlimited",
};

describe("createBookmark", () => {
  it("hands the store the normalised URL, its canonical form and host, and the account as owner, and announces bookmark.created", async () => {
    const { requests, dependencies } = world();

    const outcome = await createBookmark(dependencies, { ...ASKING, description: "The docs", pinned: true });

    expect(outcome.kind).toBe("created");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.bookmark).toEqual({
      id: "0192f3a0-aaaa-7000-8000-000000000001",
      ownerId: ACCOUNT,
      url: "https://example.com/docs/?b=2&a=1&utm_source=feed#intro",
      urlCanonical: "https://example.com/docs?a=1&b=2",
      host: "example.com",
      title: "Docs",
      description: "The docs",
      pinned: true,
    });
    expect(request?.ceiling).toBe("unlimited");
    expect(request?.events).toEqual([
      {
        eventId: "0192f3a0-aaaa-7000-8000-000000000002",
        name: "bookmark.created",
        payload: { workspaceId: WORKSPACE, bookmarkId: "0192f3a0-aaaa-7000-8000-000000000001", accountId: ACCOUNT },
      },
    ]);
  });

  it("stores no description for an empty one and leaves a bookmark unpinned unless asked", async () => {
    const { requests, dependencies } = world();

    await createBookmark(dependencies, { ...ASKING, description: "" });
    await createBookmark(dependencies, { ...ASKING, description: undefined, pinned: false });

    expect(requests.map((request) => [request.bookmark.description, request.bookmark.pinned])).toEqual([
      [null, false],
      [null, false],
    ]);
  });

  it.each([
    ["javascript:alert(1)", "not_http"],
    ["data:text/html,hello", "not_http"],
    ["file:///etc/passwd", "not_http"],
    ["vbscript:msgbox(1)", "not_http"],
    ["//example.com/a", "not_http"],
    ["", "empty"],
    ["https://example.com/" + "a".repeat(2048), "too_long"],
    ["https://", "malformed"],
  ] as const)("refuses the URL %j as %s and asks the store for nothing", async (url, reason) => {
    const { requests, dependencies } = world();

    expect(await createBookmark(dependencies, { ...ASKING, url })).toEqual({ kind: "url_refused", reason });
    expect(requests).toEqual([]);
  });

  it("refuses a title or a description outside its length before the store is asked, counting characters and not UTF-16 units", async () => {
    const { requests, dependencies } = world();

    await expect(createBookmark(dependencies, { ...ASKING, title: "" })).rejects.toThrow(RangeError);
    await expect(createBookmark(dependencies, { ...ASKING, title: "t".repeat(BOOKMARK_TITLE_MAX_LENGTH + 1) })).rejects.toThrow(RangeError);
    await expect(createBookmark(dependencies, { ...ASKING, description: "d".repeat(BOOKMARK_DESCRIPTION_MAX_LENGTH + 1) })).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);

    expect((await createBookmark(dependencies, { ...ASKING, title: "😀".repeat(BOOKMARK_TITLE_MAX_LENGTH), description: "😀".repeat(BOOKMARK_DESCRIPTION_MAX_LENGTH) })).kind).toBe("created");
    expect(requests).toHaveLength(1);
  });

  it("reports the ceiling and the count the store judged it against when the workspace is full", async () => {
    const { dependencies } = world(() => ({ kind: "limit_reached", used: 2 }));

    expect(await createBookmark(dependencies, { ...ASKING, ceiling: 2 })).toEqual({ kind: "limit_reached", limit: 2, used: 2 });
  });

  it("passes the ceiling on as it is and reports an unreachable workspace", async () => {
    const { requests, dependencies } = world(() => ({ kind: "unavailable" }));

    expect(await createBookmark(dependencies, { ...ASKING, ceiling: 0 })).toEqual({ kind: "unavailable" });
    expect(requests[0]?.ceiling).toBe(0);
  });

  it("does not take a refusal under an unlimited ceiling for a limit", async () => {
    const { dependencies } = world(() => ({ kind: "limit_reached", used: 5 }));

    await expect(createBookmark(dependencies, ASKING)).rejects.toThrow("unlimited");
  });

  it("lets the failure of the store reject, so the caller's transaction does not commit", async () => {
    const { dependencies } = world(() => {
      throw new Error("the database refused");
    });

    await expect(createBookmark(dependencies, ASKING)).rejects.toThrow("the database refused");
  });
});

describe("readBookmark", () => {
  const record = (ownerId: string | null): BookmarkRecord => ({ ...recordOf({ bookmark: { id: "0192f3a0-aaaa-7000-8000-000000000009", ownerId: ACCOUNT, url: "https://example.com/", urlCanonical: "https://example.com", host: "example.com", title: "Docs", description: null, pinned: false }, ceiling: "unlimited", events: [] }), ownerId });

  it("returns the bookmark to its owner", async () => {
    const stored = record(ACCOUNT);

    expect(await readBookmark({ store: { find: () => Promise.resolve(stored) } }, { bookmarkId: stored.id, accountId: ACCOUNT })).toBe(stored);
    expect(await readBookmark({ store: { find: () => Promise.resolve(stored) } }, { bookmarkId: stored.id, accountId: ACCOUNT.toUpperCase() })).toBe(stored);
  });

  it("answers another member's bookmark, an ownerless one and a missing one alike", async () => {
    const found = (bookmark: BookmarkRecord | undefined) => ({ store: { find: () => Promise.resolve(bookmark) } });

    expect(await readBookmark(found(record(OTHER_ACCOUNT)), { bookmarkId: "x", accountId: ACCOUNT })).toBeUndefined();
    expect(await readBookmark(found(record(null)), { bookmarkId: "x", accountId: ACCOUNT })).toBeUndefined();
    expect(await readBookmark(found(undefined), { bookmarkId: "x", accountId: ACCOUNT })).toBeUndefined();
  });
});
