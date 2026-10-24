import { describe, expect, it } from "vitest";
import {
  BOOKMARK_BULK_IDS_MAX,
  BOOKMARK_SELECT_ALL_CAP,
  bulkBookmarks,
  listBookmarkIds,
  type AuditActor,
  type AuditEventInput,
  type BookmarkBulkAction,
  type BookmarkBulkTarget,
  type BookmarkListFilter,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-0000000000a1";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-00000000000A";
const ACTOR: AuditActor = { type: "account", accountId: ACCOUNT, label: "Ada" };
const idOf = (index: number): string => `0192f3a0-cccc-7000-8000-${index.toString(16).padStart(12, "0")}`;

interface Calls {
  readonly removed: (readonly string[])[];
  readonly pinned: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }[];
  readonly filters: { readonly filter: BookmarkListFilter; readonly limit: number }[];
  readonly events: AuditEventInput[];
}

function bulking(options: { readonly matching?: readonly string[]; readonly removed?: number | undefined; readonly pinned?: number } = {}) {
  const calls: Calls = { removed: [], pinned: [], filters: [], events: [] };
  const dependencies = {
    store: {
      ids: (filter: BookmarkListFilter, limit: number) => {
        calls.filters.push({ filter, limit });
        return Promise.resolve((options.matching ?? []).slice(0, limit));
      },
      removeMany: (bookmarkIds: readonly string[]) => {
        calls.removed.push(bookmarkIds);
        return Promise.resolve("removed" in options ? options.removed : bookmarkIds.length);
      },
      setPinned: (request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }) => {
        calls.pinned.push(request);
        return Promise.resolve(options.pinned ?? request.bookmarkIds.length);
      },
    },
    audit: {
      write: (event: AuditEventInput) => {
        calls.events.push(event);
        return Promise.resolve();
      },
    },
  };
  const run = (action: BookmarkBulkAction, target: BookmarkBulkTarget) =>
    bulkBookmarks(dependencies, { workspaceId: WORKSPACE, accountId: ACCOUNT, actor: ACTOR, ipPrefix: "203.0.0.0/16", action, target });
  return { calls, run };
}

const noFilter: BookmarkBulkTarget = { kind: "filter", scope: "mine", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined };

describe("bulkBookmarks by identifier", () => {
  it("deletes the distinct identifiers, reports what the store deleted as affected and the rest as not found, and writes one event with the count", async () => {
    const { calls, run } = bulking({ removed: 7 });
    const named = Array.from({ length: 10 }, (_, index) => idOf(index));

    const outcome = await run("delete", { kind: "ids", ids: [...named, named[0] ?? "", (named[1] ?? "").toUpperCase()] });

    expect(outcome).toEqual({ kind: "done", requested: 10, affected: 7, skipped: { not_owner: 0, not_found: 3 } });
    expect(calls.removed).toEqual([named]);
    expect(calls.events).toEqual([
      { action: "bookmark.bulk_deleted", workspaceId: WORKSPACE, actor: ACTOR, metadata: { count: "7" }, ipPrefix: "203.0.0.0/16" },
    ]);
  });

  it("writes no event when nothing was deleted", async () => {
    const { calls, run } = bulking({ removed: 0 });

    expect(await run("delete", { kind: "ids", ids: [idOf(1)] })).toEqual({ kind: "done", requested: 1, affected: 0, skipped: { not_owner: 0, not_found: 1 } });
    expect(calls.events).toEqual([]);
  });

  it("is unavailable, writing no event, when the store cannot reach the workspace", async () => {
    const { calls, run } = bulking({ removed: undefined });

    expect(await run("delete", { kind: "ids", ids: [idOf(1)] })).toEqual({ kind: "unavailable" });
    expect(calls.events).toEqual([]);
  });

  it("counts a name that is not an identifier as not found without handing it to the store", async () => {
    const { calls, run } = bulking();

    const outcome = await run("delete", { kind: "ids", ids: [idOf(1), "not-an-identifier"] });

    expect(outcome).toEqual({ kind: "done", requested: 2, affected: 1, skipped: { not_owner: 0, not_found: 1 } });
    expect(calls.removed).toEqual([[idOf(1)]]);
  });

  it("calls the store for no identifier at all when none is valid", async () => {
    const { calls, run } = bulking();

    expect(await run("delete", { kind: "ids", ids: ["x"] })).toEqual({ kind: "done", requested: 1, affected: 0, skipped: { not_owner: 0, not_found: 1 } });
    expect(calls.removed).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("pins and unpins for the account that asks, with no audit event, counting what the store found", async () => {
    const { calls, run } = bulking({ pinned: 1 });

    expect(await run("pin", { kind: "ids", ids: [idOf(1), idOf(2)] })).toEqual({ kind: "done", requested: 2, affected: 1, skipped: { not_owner: 0, not_found: 1 } });
    await run("unpin", { kind: "ids", ids: [idOf(3)] });

    expect(calls.pinned).toEqual([
      { bookmarkIds: [idOf(1), idOf(2)], ownerId: ACCOUNT.toLowerCase(), pinned: true },
      { bookmarkIds: [idOf(3)], ownerId: ACCOUNT.toLowerCase(), pinned: false },
    ]);
    expect(calls.removed).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("refuses more than the identifier limit, touching nothing", async () => {
    const { calls, run } = bulking();

    const outcome = await run("delete", { kind: "ids", ids: Array.from({ length: BOOKMARK_BULK_IDS_MAX + 1 }, (_, index) => idOf(index)) });

    expect(outcome).toEqual({ kind: "too_many", limit: BOOKMARK_BULK_IDS_MAX });
    expect(calls.removed).toEqual([]);
    expect(calls.events).toEqual([]);
  });
});

describe("bulkBookmarks by filter", () => {
  it("resolves the filter to the account's own identifiers and acts on those", async () => {
    const matching = [idOf(1), idOf(2), idOf(3)];
    const { calls, run } = bulking({ matching });

    const outcome = await run("delete", { ...noFilter, pinned: true, url: "HTTP://Example.com:80/a" });

    expect(outcome).toEqual({ kind: "done", requested: 3, affected: 3, skipped: { not_owner: 0, not_found: 0 } });
    expect(calls.filters).toEqual([
      { filter: { ownerId: ACCOUNT.toLowerCase(), pinned: true, hasSlug: undefined, forwarding: undefined, urlCanonical: "http://example.com/a" }, limit: BOOKMARK_SELECT_ALL_CAP + 1 },
    ]);
    expect(calls.removed).toEqual([matching]);
    expect(calls.events.map((event) => event.metadata)).toEqual([{ count: "3" }]);
  });

  it("refuses a filter that matches more than the cap, deleting nothing and writing no event", async () => {
    const { calls, run } = bulking({ matching: Array.from({ length: BOOKMARK_SELECT_ALL_CAP + 1 }, (_, index) => idOf(index)) });

    expect(await run("delete", noFilter)).toEqual({ kind: "too_many", limit: BOOKMARK_SELECT_ALL_CAP });
    expect(calls.removed).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("acts on exactly the cap", async () => {
    const matching = Array.from({ length: BOOKMARK_SELECT_ALL_CAP }, (_, index) => idOf(index));
    const { calls, run } = bulking({ matching });

    expect(await run("pin", noFilter)).toMatchObject({ kind: "done", requested: BOOKMARK_SELECT_ALL_CAP, affected: BOOKMARK_SELECT_ALL_CAP });
    expect(calls.pinned[0]?.bookmarkIds).toHaveLength(BOOKMARK_SELECT_ALL_CAP);
  });

  it("does nothing for a filter that matches nothing", async () => {
    const { calls, run } = bulking({ matching: [] });

    expect(await run("delete", noFilter)).toEqual({ kind: "done", requested: 0, affected: 0, skipped: { not_owner: 0, not_found: 0 } });
    expect(calls.removed).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("refuses a url that cannot be a bookmark's, reading nothing", async () => {
    const { calls, run } = bulking({ matching: [idOf(1)] });

    expect(await run("delete", { ...noFilter, url: "ftp://example.com/x" })).toEqual({ kind: "url_refused", reason: "not_http" });
    expect(calls.filters).toEqual([]);
    expect(calls.removed).toEqual([]);
  });
});

describe("listBookmarkIds", () => {
  it("returns the identifiers the filter matches, and says when it cut them at the cap", async () => {
    const matching = Array.from({ length: BOOKMARK_SELECT_ALL_CAP + 1 }, (_, index) => idOf(index));
    const { calls } = bulking();
    const store = { ids: (filter: BookmarkListFilter, limit: number) => (calls.filters.push({ filter, limit }), Promise.resolve(matching.slice(0, limit))) };

    const cut = await listBookmarkIds({ store }, { accountId: ACCOUNT, scope: "all", pinned: undefined, hasSlug: false, forwarding: undefined, url: undefined });
    const whole = await listBookmarkIds({ store: { ids: () => Promise.resolve(matching.slice(0, 3)) } }, { accountId: ACCOUNT, scope: "mine", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined });

    expect(cut).toEqual({ kind: "listed", ids: matching.slice(0, BOOKMARK_SELECT_ALL_CAP), truncated: true });
    expect(whole).toEqual({ kind: "listed", ids: matching.slice(0, 3), truncated: false });
    expect(calls.filters[0]).toEqual({ filter: { ownerId: ACCOUNT, pinned: undefined, hasSlug: false, forwarding: undefined, urlCanonical: undefined }, limit: BOOKMARK_SELECT_ALL_CAP + 1 });
  });

  it("refuses a url that cannot be a bookmark's", async () => {
    const outcome = await listBookmarkIds({ store: { ids: () => Promise.reject(new Error("not read")) } }, { accountId: ACCOUNT, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: "javascript:alert(1)" });

    expect(outcome).toEqual({ kind: "url_refused", reason: "not_http" });
  });
});
