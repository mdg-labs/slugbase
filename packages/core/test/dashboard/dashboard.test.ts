import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PINNED_LIMIT,
  DASHBOARD_QUICK_ACCESS_LIMIT,
  DASHBOARD_TOP_TAGS_LIMIT,
  dashboard,
  type DashboardBookmark,
  type DashboardStore,
  type DashboardSummary,
  type StoredOnboarding,
  type TagListRequest,
  type TagRecord,
} from "../../src/index.ts";

// The dashboard service (doc 02 section 9.3, doc 04 section 10.8): it asks the stores for the caller's own counts, quick access, pinned bookmarks and top tags, and puts the checklist together
// from what the data shows and what the account stored.

const ME = "0192F3A0-BBBB-7000-8000-00000000000A";

const BOOKMARK: DashboardBookmark = { id: "b1", title: "Mail", url: "https://mail.example.com/", host: "mail.example.com", slug: "mail", forwarding: true, openCount: 3 };
const TAG: TagRecord = { id: "t1", name: "read", bookmarkCount: 2, createdAt: new Date("2026-01-01T00:00:00Z") };
const SUMMARY: DashboardSummary = { bookmarks: 4, folders: 2, tags: 3, hasBookmark: true, hasSlug: true };
const STORED: StoredOnboarding = { browserSetupDone: false, importDone: true, checklistDismissed: false };

function stores(overrides: { summary?: DashboardSummary; onboarding?: StoredOnboarding | undefined } = {}) {
  const asked: { what: string; ownerId: string; limit?: number; sort?: string }[] = [];
  const store: DashboardStore = {
    summary: (ownerId) => {
      asked.push({ what: "summary", ownerId });
      return Promise.resolve(overrides.summary ?? SUMMARY);
    },
    quickAccess: (ownerId, limit) => {
      asked.push({ what: "quickAccess", ownerId, limit });
      return Promise.resolve([BOOKMARK]);
    },
    pinned: (ownerId, limit) => {
      asked.push({ what: "pinned", ownerId, limit });
      return Promise.resolve([{ ...BOOKMARK, forwarding: false, slug: null }]);
    },
    onboarding: (ownerId) => {
      asked.push({ what: "onboarding", ownerId });
      return Promise.resolve("onboarding" in overrides ? overrides.onboarding : STORED);
    },
  };
  const tags = {
    list: (request: TagListRequest) => {
      asked.push({ what: "tags", ownerId: request.ownerId, limit: request.limit, sort: request.sort });
      return Promise.resolve([TAG]);
    },
  };
  return { store, tags, asked };
}

describe("the dashboard", () => {
  it("asks every store for the caller's own rows, with the limits of the dashboard, and answers what they hold", async () => {
    const { store, tags, asked } = stores();

    const answer = await dashboard({ store, tags }, { accountId: ME });

    expect(asked).toEqual([
      { what: "summary", ownerId: ME.toLowerCase() },
      { what: "quickAccess", ownerId: ME.toLowerCase(), limit: DASHBOARD_QUICK_ACCESS_LIMIT },
      { what: "pinned", ownerId: ME.toLowerCase(), limit: DASHBOARD_PINNED_LIMIT },
      { what: "tags", ownerId: ME.toLowerCase(), limit: DASHBOARD_TOP_TAGS_LIMIT, sort: "count" },
      { what: "onboarding", ownerId: ME.toLowerCase() },
    ]);
    expect([DASHBOARD_QUICK_ACCESS_LIMIT, DASHBOARD_PINNED_LIMIT, DASHBOARD_TOP_TAGS_LIMIT]).toEqual([8, 12, 12]);
    expect(answer).toEqual({
      counts: { bookmarks: 4, folders: 2, tags: 3, sharedWithYou: null },
      quickAccess: [BOOKMARK],
      pinned: [{ ...BOOKMARK, forwarding: false, slug: null }],
      topTags: [{ id: "t1", name: "read", bookmarkCount: 2 }],
      sharing: null,
      onboarding: { bookmarkAdded: true, slugGiven: true, browserSetupDone: false, folderCreated: true, importDone: true, dismissed: false },
    });
  });

  it("derives the checklist items of bookmark, slug and folder from the data and the other two and the dismissal from the stored state", async () => {
    const empty = stores({ summary: { bookmarks: 0, folders: 0, tags: 0, hasBookmark: false, hasSlug: false }, onboarding: { browserSetupDone: true, importDone: false, checklistDismissed: true } });
    expect((await dashboard({ store: empty.store, tags: empty.tags }, { accountId: ME }))?.onboarding).toEqual({
      bookmarkAdded: false,
      slugGiven: false,
      browserSetupDone: true,
      folderCreated: false,
      importDone: false,
      dismissed: true,
    });
    // A member whose only bookmarks are plan-archived has none to count and still added one.
    const archived = stores({ summary: { bookmarks: 0, folders: 1, tags: 0, hasBookmark: true, hasSlug: true } });
    const answer = await dashboard({ store: archived.store, tags: archived.tags }, { accountId: ME });
    expect(answer?.counts.bookmarks).toBe(0);
    expect(answer?.onboarding).toMatchObject({ bookmarkAdded: true, slugGiven: true, folderCreated: true });
  });

  it("answers nothing when the account has no row any more, rather than an empty checklist", async () => {
    const gone = stores({ onboarding: undefined });

    expect(await dashboard({ store: gone.store, tags: gone.tags }, { accountId: ME })).toBeUndefined();
  });

  it("never says a count of shared bookmarks or a sharing block while sharing does not exist", async () => {
    const { store, tags } = stores();

    const answer = await dashboard({ store, tags }, { accountId: ME });

    expect(answer?.counts.sharedWithYou).toBeNull();
    expect(answer?.sharing).toBeNull();
  });
});
