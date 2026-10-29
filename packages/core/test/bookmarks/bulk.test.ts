import { describe, expect, it } from "vitest";
import {
  BOOKMARK_BULK_IDS_MAX,
  BOOKMARK_SELECT_ALL_CAP,
  bulkBookmarks,
  listBookmarkIds,
  previewBulkShare,
  previewBulkTags,
  type AuditActor,
  type AuditEventInput,
  type BookmarkBulkAction,
  type BookmarkBulkStore,
  type BookmarkBulkTarget,
  type BookmarkLinkingResult,
  type BookmarkListFilter,
  type BookmarkShareManyResult,
  type BookmarkSharePreviewResult,
  type BookmarkTagPreviewResult,
  type ShareTarget,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-0000000000a1";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-00000000000A";
const ACTOR: AuditActor = { type: "account", accountId: ACCOUNT, label: "Ada" };
const idOf = (index: number): string => `0192f3a0-cccc-7000-8000-${index.toString(16).padStart(12, "0")}`;
const FOLDER = "0192f3a0-dddd-7000-8000-0000000000F1";
const TAG_A = "0192f3a0-eeee-7000-8000-0000000000A1";
const TAG_B = "0192f3a0-eeee-7000-8000-0000000000B2";
const MEMBER = "0192f3a0-ffff-7000-8000-0000000000C1";
const TEAM = "0192f3a0-ffff-7000-8000-0000000000D1";
const MEMBER_TARGET: ShareTarget = { kind: "member", accountId: MEMBER };
const TEAM_TARGET: ShareTarget = { kind: "team", teamId: TEAM };

interface Calls {
  readonly removed: (readonly string[])[];
  readonly sharedAsked: { readonly bookmarkIds: readonly string[]; readonly accountId: string }[];
  readonly pinned: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }[];
  readonly filters: { readonly filter: BookmarkListFilter; readonly limit: number }[];
  readonly events: AuditEventInput[];
  readonly filed: Parameters<BookmarkBulkStore["fileIn"]>[0][];
  readonly tagged: Parameters<BookmarkBulkStore["tag"]>[0][];
  readonly previewed: Parameters<BookmarkBulkStore["previewTags"]>[0][];
  readonly shared: Omit<Parameters<BookmarkBulkStore["share"]>[0], "newId">[];
  readonly sharePreviewed: Parameters<BookmarkBulkStore["previewShare"]>[0][];
}

interface BulkingOptions {
  readonly matching?: readonly string[];
  /** The bookmarks the store says are shared with the account, among those it is asked about. */
  readonly shared?: readonly string[];
  readonly removed?: number | undefined;
  readonly pinned?: number;
  /** What the store answers a filing and a tagging; the number of bookmarks it was given when left out. */
  readonly linking?: BookmarkLinkingResult;
  readonly previewing?: BookmarkTagPreviewResult;
  /** What the store answers a share; the bookmarks it was given, all of them newly shared, when left out. */
  readonly sharing?: BookmarkShareManyResult;
  readonly sharePreviewing?: BookmarkSharePreviewResult;
}

function bulking(options: BulkingOptions = {}) {
  const calls: Calls = { removed: [], sharedAsked: [], pinned: [], filters: [], events: [], filed: [], tagged: [], previewed: [], shared: [], sharePreviewed: [] };
  const dependencies = {
    store: {
      ids: (filter: BookmarkListFilter, limit: number) => {
        calls.filters.push({ filter, limit });
        return Promise.resolve((options.matching ?? []).slice(0, limit));
      },
      sharedAmong: (request: { readonly bookmarkIds: readonly string[]; readonly accountId: string }) => {
        calls.sharedAsked.push(request);
        return Promise.resolve(request.bookmarkIds.filter((id) => (options.shared ?? []).includes(id)));
      },
      removeMany: (bookmarkIds: readonly string[]) => {
        calls.removed.push(bookmarkIds);
        return Promise.resolve("removed" in options ? options.removed : bookmarkIds.length);
      },
      setPinned: (request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }) => {
        calls.pinned.push(request);
        return Promise.resolve(options.pinned ?? request.bookmarkIds.length);
      },
      fileIn: (request: Parameters<BookmarkBulkStore["fileIn"]>[0]) => {
        calls.filed.push(request);
        return Promise.resolve(options.linking ?? ({ kind: "done", affected: request.bookmarkIds.length } as const));
      },
      tag: (request: Parameters<BookmarkBulkStore["tag"]>[0]) => {
        calls.tagged.push(request);
        return Promise.resolve(options.linking ?? ({ kind: "done", affected: request.bookmarkIds.length } as const));
      },
      previewTags: (request: Parameters<BookmarkBulkStore["previewTags"]>[0]) => {
        calls.previewed.push(request);
        return Promise.resolve(options.previewing ?? ({ kind: "previewed", affected: request.bookmarkIds.length, tags: [] } as const));
      },
      share: (request: Parameters<BookmarkBulkStore["share"]>[0]) => {
        calls.shared.push({ bookmarkIds: request.bookmarkIds, ownerId: request.ownerId, target: request.target });
        return Promise.resolve(options.sharing ?? ({ kind: "done", affected: request.bookmarkIds.length, granted: request.bookmarkIds.length, targetName: "Grace" } as const));
      },
      previewShare: (request: Parameters<BookmarkBulkStore["previewShare"]>[0]) => {
        calls.sharePreviewed.push(request);
        return Promise.resolve(
          options.sharePreviewing ??
            ({ kind: "previewed", affected: request.bookmarkIds.length, audience: { kind: request.target.kind, id: MEMBER, name: "Grace", memberCount: 1, added: request.bookmarkIds.length } } as const),
        );
      },
    },
    audit: {
      write: (event: AuditEventInput) => {
        calls.events.push(event);
        return Promise.resolve();
      },
    },
    newId: () => "0192f3a0-1111-7000-8000-000000000001",
  };
  const run = (action: BookmarkBulkAction, target: BookmarkBulkTarget, acting: { readonly folderId?: string; readonly tagIds?: readonly string[]; readonly shareTarget?: ShareTarget } = {}) =>
    bulkBookmarks(dependencies, { workspaceId: WORKSPACE, accountId: ACCOUNT, actor: ACTOR, ipPrefix: "203.0.0.0/16", action, target, ...acting });
  const preview = (target: BookmarkBulkTarget, tagIds: readonly string[]) => previewBulkTags(dependencies, { accountId: ACCOUNT, target, tagIds });
  const previewShare = (target: BookmarkBulkTarget, shareTarget: ShareTarget) => previewBulkShare(dependencies, { accountId: ACCOUNT, target, shareTarget });
  return { calls, run, preview, previewShare };
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
      { filter: { ownerId: ACCOUNT.toLowerCase(), scope: "mine", pinned: true, hasSlug: undefined, forwarding: undefined, urlCanonical: "http://example.com/a" }, limit: BOOKMARK_SELECT_ALL_CAP + 1 },
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

describe("bulkBookmarks filing", () => {
  it.each([
    ["add_to_folder", "add"],
    ["move_to_folder", "move"],
    ["remove_from_folder", "remove"],
  ] as const)("%s hands the store the distinct valid identifiers, the account and the lower-cased folder in mode %s, and writes no event", async (action, mode) => {
    const { calls, run } = bulking({ linking: { kind: "done", affected: 2 } });

    const outcome = await run(action, { kind: "ids", ids: [idOf(1), idOf(2), idOf(2), "x"] }, { folderId: FOLDER });

    expect(outcome).toEqual({ kind: "done", requested: 3, affected: 2, skipped: { not_owner: 0, not_found: 1 } });
    expect(calls.filed).toEqual([{ bookmarkIds: [idOf(1), idOf(2)], ownerId: ACCOUNT.toLowerCase(), folderId: FOLDER.toLowerCase(), mode }]);
    expect(calls.events).toEqual([]);
    expect(calls.removed).toEqual([]);
    expect(calls.pinned).toEqual([]);
  });

  it("asks the store even when no identifier is valid, so a folder that is not the caller's is refused whatever the bookmarks", async () => {
    const { calls, run } = bulking({ linking: { kind: "target_not_found" } });

    expect(await run("add_to_folder", { kind: "ids", ids: ["x"] }, { folderId: FOLDER })).toEqual({ kind: "target_not_found" });
    expect(calls.filed).toHaveLength(1);
  });

  it("reports a folder that is not the caller's as target_not_found, not as skipped bookmarks", async () => {
    const { run } = bulking({ linking: { kind: "target_not_found" } });

    expect(await run("move_to_folder", { kind: "ids", ids: [idOf(1)] }, { folderId: FOLDER })).toEqual({ kind: "target_not_found" });
  });

  it("acts on the bookmarks a filter with a folder and tags matches, and hands the filter to the store as the list does", async () => {
    const { calls, run } = bulking({ matching: [idOf(1), idOf(2)] });

    const outcome = await run("add_to_folder", { ...noFilter, folderId: FOLDER, tagIds: [TAG_B, TAG_A, TAG_B] }, { folderId: FOLDER });

    expect(outcome).toEqual({ kind: "done", requested: 2, affected: 2, skipped: { not_owner: 0, not_found: 0 } });
    expect(calls.filters[0]?.filter).toEqual({ ownerId: ACCOUNT.toLowerCase(), scope: "mine", folderId: FOLDER.toLowerCase(), tagIds: [TAG_A.toLowerCase(), TAG_B.toLowerCase()] });
  });

  it("acts on the bookmarks a filter with a text query matches, and hands the text to the store as the list does", async () => {
    const { calls, run } = bulking({ matching: [idOf(1), idOf(2)] });

    const outcome = await run("pin", { ...noFilter, q: "  alpha  " });

    expect(outcome).toMatchObject({ kind: "done", requested: 2, affected: 2 });
    expect(calls.filters[0]?.filter).toMatchObject({ ownerId: ACCOUNT.toLowerCase(), q: "alpha" });
  });

  it("throws when a folder action names no folder, which the contract refuses first", async () => {
    const { calls, run } = bulking();

    await expect(run("add_to_folder", { kind: "ids", ids: [idOf(1)] })).rejects.toThrow(RangeError);
    expect(calls.filed).toEqual([]);
  });
});

describe("bulkBookmarks tagging", () => {
  it.each([
    ["add_tags", "add"],
    ["remove_tags", "remove"],
  ] as const)("%s hands the store the distinct tags and the account in mode %s, and writes no event", async (action, mode) => {
    const { calls, run } = bulking();

    const outcome = await run(action, { kind: "ids", ids: [idOf(1), idOf(2)] }, { tagIds: [TAG_A, TAG_A.toLowerCase(), TAG_B] });

    expect(outcome).toEqual({ kind: "done", requested: 2, affected: 2, skipped: { not_owner: 0, not_found: 0 } });
    expect(calls.tagged).toEqual([{ bookmarkIds: [idOf(1), idOf(2)], ownerId: ACCOUNT.toLowerCase(), tagIds: [TAG_A.toLowerCase(), TAG_B.toLowerCase()], mode }]);
    expect(calls.events).toEqual([]);
  });

  it("reports a tag that is not the caller's as target_not_found", async () => {
    const { run } = bulking({ linking: { kind: "target_not_found" } });

    expect(await run("add_tags", { kind: "ids", ids: [idOf(1)] }, { tagIds: [TAG_A] })).toEqual({ kind: "target_not_found" });
  });

  it("throws when a tag action names no tags, which the contract refuses first", async () => {
    const { calls, run } = bulking();

    await expect(run("remove_tags", { kind: "ids", ids: [idOf(1)] }, { tagIds: [] })).rejects.toThrow(RangeError);
    expect(calls.tagged).toEqual([]);
  });
});

describe("previewBulkTags", () => {
  it("counts like the bulk request and answers the tag set the store computed, writing nothing", async () => {
    const tags = [{ id: TAG_A.toLowerCase(), name: "alpha", bookmarkCount: 2, added: 1 }];
    const { calls, preview } = bulking({ previewing: { kind: "previewed", affected: 2, tags } });

    const outcome = await preview({ kind: "ids", ids: [idOf(1), idOf(2), idOf(3)] }, [TAG_A]);

    expect(outcome).toEqual({ kind: "previewed", requested: 3, affected: 2, skipped: { not_owner: 0, not_found: 1 }, tags });
    expect(calls.previewed).toEqual([{ bookmarkIds: [idOf(1), idOf(2), idOf(3)], ownerId: ACCOUNT.toLowerCase(), tagIds: [TAG_A.toLowerCase()] }]);
    expect(calls.tagged).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("resolves a filter to the account's own identifiers, and refuses one that matches more than the cap", async () => {
    const { calls, preview } = bulking({ matching: Array.from({ length: BOOKMARK_SELECT_ALL_CAP + 1 }, (_, index) => idOf(index)) });

    expect(await preview({ ...noFilter, tagIds: [TAG_B] }, [TAG_A])).toEqual({ kind: "too_many", limit: BOOKMARK_SELECT_ALL_CAP });
    expect(calls.filters[0]?.filter).toMatchObject({ ownerId: ACCOUNT.toLowerCase(), tagIds: [TAG_B.toLowerCase()] });
    expect(calls.previewed).toEqual([]);
  });

  it("refuses more than the identifier limit and a url that cannot be a bookmark's, reading nothing", async () => {
    const { calls, preview } = bulking();

    expect(await preview({ kind: "ids", ids: Array.from({ length: BOOKMARK_BULK_IDS_MAX + 1 }, (_, index) => idOf(index)) }, [TAG_A])).toEqual({ kind: "too_many", limit: BOOKMARK_BULK_IDS_MAX });
    expect(await preview({ ...noFilter, url: "ftp://example.com/x" }, [TAG_A])).toEqual({ kind: "url_refused", reason: "not_http" });
    expect(calls.previewed).toEqual([]);
  });

  it("reports a tag that is not the caller's as target_not_found", async () => {
    const { preview } = bulking({ previewing: { kind: "target_not_found" } });

    expect(await preview({ kind: "ids", ids: [idOf(1)] }, [TAG_A])).toEqual({ kind: "target_not_found" });
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
    expect(calls.filters[0]).toEqual({ filter: { ownerId: ACCOUNT, scope: "all", pinned: undefined, hasSlug: false, forwarding: undefined, urlCanonical: undefined }, limit: BOOKMARK_SELECT_ALL_CAP + 1 });
  });

  it("hands the folder and the tags of the list to the store as the list does", async () => {
    const { calls } = bulking();
    const store = { ids: (filter: BookmarkListFilter, limit: number) => (calls.filters.push({ filter, limit }), Promise.resolve([])) };

    await listBookmarkIds({ store }, { accountId: ACCOUNT, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined, folderId: FOLDER, tagIds: [TAG_B, TAG_A] });

    expect(calls.filters[0]?.filter).toMatchObject({ folderId: FOLDER.toLowerCase(), tagIds: [TAG_A.toLowerCase(), TAG_B.toLowerCase()] });
  });

  it("hands the text query of the list to the store as the list does", async () => {
    const { calls } = bulking();
    const store = { ids: (filter: BookmarkListFilter, limit: number) => (calls.filters.push({ filter, limit }), Promise.resolve([])) };

    await listBookmarkIds({ store }, { accountId: ACCOUNT, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined, q: " alpha " });

    expect(calls.filters[0]?.filter).toMatchObject({ q: "alpha" });
  });

  it("refuses a url that cannot be a bookmark's", async () => {
    const outcome = await listBookmarkIds({ store: { ids: () => Promise.reject(new Error("not read")) } }, { accountId: ACCOUNT, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: "javascript:alert(1)" });

    expect(outcome).toEqual({ kind: "url_refused", reason: "not_http" });
  });
});

describe("a selection that holds a bookmark shared with the caller", () => {
  const SHARED = idOf(900);
  const OWN = idOf(901);
  const ACTIONS = [
    ["delete", {}],
    ["pin", {}],
    ["unpin", {}],
    ["add_to_folder", { folderId: FOLDER }],
    ["move_to_folder", { folderId: FOLDER }],
    ["remove_from_folder", { folderId: FOLDER }],
    ["add_tags", { tagIds: [TAG_A] }],
    ["remove_tags", { tagIds: [TAG_A] }],
    ["share", { shareTarget: MEMBER_TARGET }],
  ] as const;

  it.each(ACTIONS)("refuses %s as a whole, with nothing written, whether it is named by identifier or matched by a filter", async (action, acting) => {
    const byIds = bulking({ shared: [SHARED] });
    const byFilter = bulking({ shared: [SHARED], matching: [OWN, SHARED] });

    expect(await byIds.run(action, { kind: "ids", ids: [OWN, SHARED] }, acting)).toEqual({ kind: "forbidden" });
    expect(await byFilter.run(action, { ...noFilter, scope: "all" }, acting)).toEqual({ kind: "forbidden" });

    for (const { calls } of [byIds, byFilter]) {
      expect(calls.removed).toEqual([]);
      expect(calls.pinned).toEqual([]);
      expect(calls.filed).toEqual([]);
      expect(calls.tagged).toEqual([]);
      expect(calls.shared).toEqual([]);
      expect(calls.events).toEqual([]);
    }
  });

  it("asks the store which of the named bookmarks are shared with the account, in lower case, once and before it acts", async () => {
    const { calls, run } = bulking({ shared: [] });

    expect(await run("pin", { kind: "ids", ids: [OWN, OWN.toUpperCase()] })).toMatchObject({ kind: "done", affected: 1 });
    expect(calls.sharedAsked).toEqual([{ bookmarkIds: [OWN], accountId: ACCOUNT.toLowerCase() }]);
  });

  it("hands the scope of a filter to the store, so that a selection of the shared bookmarks is the one the list shows", async () => {
    const { calls, run } = bulking({ shared: [], matching: [OWN] });

    await run("pin", { ...noFilter, scope: "shared_with_me" });

    expect(calls.filters[0]?.filter).toMatchObject({ ownerId: ACCOUNT.toLowerCase(), scope: "shared_with_me" });
  });

  it("refuses the preview of tags for it too, and previews the rest", async () => {
    const refused = bulking({ shared: [SHARED] });
    const allowed = bulking({ shared: [] });

    expect(await refused.preview({ kind: "ids", ids: [SHARED] }, [TAG_A])).toEqual({ kind: "forbidden" });
    expect(refused.calls.previewed).toEqual([]);
    expect(await allowed.preview({ kind: "ids", ids: [OWN] }, [TAG_A])).toMatchObject({ kind: "previewed", affected: 1 });
  });

  it("refuses the preview of a share for it too, reading no audience", async () => {
    const { calls, previewShare } = bulking({ shared: [SHARED] });

    expect(await previewShare({ kind: "ids", ids: [OWN, SHARED] }, MEMBER_TARGET)).toEqual({ kind: "forbidden" });
    expect(calls.sharePreviewed).toEqual([]);
  });
});

describe("bulkBookmarks sharing", () => {
  const OWN_A = idOf(1);
  const OWN_B = idOf(2);

  it("shares the distinct identifiers with the member, reports what the store reached as affected, and writes one event with the number of shares made and the target", async () => {
    const { calls, run } = bulking({ sharing: { kind: "done", affected: 2, granted: 1, targetName: "Grace" } });

    const outcome = await run("share", { kind: "ids", ids: [OWN_A, OWN_B, OWN_A, idOf(3)] }, { shareTarget: { kind: "member", accountId: MEMBER.toUpperCase() } });

    expect(outcome).toEqual({ kind: "done", requested: 3, affected: 2, skipped: { not_owner: 0, not_found: 1 } });
    expect(calls.shared).toEqual([{ bookmarkIds: [OWN_A, OWN_B, idOf(3)], ownerId: ACCOUNT.toLowerCase(), target: { kind: "member", accountId: MEMBER.toLowerCase() } }]);
    expect(calls.events).toEqual([
      {
        action: "share.bulk_granted",
        workspaceId: WORKSPACE,
        actor: ACTOR,
        metadata: { count: "1", targetKind: "member", targetId: MEMBER.toLowerCase(), targetName: "Grace" },
        ipPrefix: "203.0.0.0/16",
      },
    ]);
  });

  it("names a team by kind and identifier in the one event", async () => {
    const { calls, run } = bulking({ sharing: { kind: "done", affected: 2, granted: 2, targetName: "Design" } });

    await run("share", { kind: "ids", ids: [OWN_A, OWN_B] }, { shareTarget: TEAM_TARGET });

    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]?.metadata).toEqual({ count: "2", targetKind: "team", targetId: TEAM.toLowerCase(), targetName: "Design" });
  });

  it("writes no event when every bookmark was shared with the target already", async () => {
    const { calls, run } = bulking({ sharing: { kind: "done", affected: 2, granted: 0, targetName: "Grace" } });

    expect(await run("share", { kind: "ids", ids: [OWN_A, OWN_B] }, { shareTarget: MEMBER_TARGET })).toEqual({ kind: "done", requested: 2, affected: 2, skipped: { not_owner: 0, not_found: 0 } });
    expect(calls.events).toEqual([]);
  });

  it("shares the bookmarks a filter matches", async () => {
    const { calls, run } = bulking({ matching: [OWN_A, OWN_B] });

    expect(await run("share", { ...noFilter, pinned: true }, { shareTarget: TEAM_TARGET })).toMatchObject({ kind: "done", requested: 2, affected: 2 });
    expect(calls.filters[0]?.filter).toMatchObject({ ownerId: ACCOUNT.toLowerCase(), pinned: true });
    expect(calls.shared[0]?.bookmarkIds).toEqual([OWN_A, OWN_B]);
  });

  it("refuses the caller as the member to share with, writing nothing", async () => {
    const { calls, run } = bulking();

    expect(await run("share", { kind: "ids", ids: [OWN_A] }, { shareTarget: { kind: "member", accountId: ACCOUNT.toUpperCase() } })).toEqual({ kind: "self" });
    expect(calls.shared).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it.each([
    [MEMBER_TARGET, "accountId"],
    [TEAM_TARGET, "teamId"],
  ] as const)("reports a target the workspace does not have (%j) as unknown_target on %s, writing no event", async (shareTarget, field) => {
    const { calls, run } = bulking({ sharing: { kind: "unknown_target" } });

    expect(await run("share", { kind: "ids", ids: [OWN_A] }, { shareTarget })).toEqual({ kind: "unknown_target", field });
    expect(calls.events).toEqual([]);
  });

  it("asks the store even when no identifier is valid, so the same request is refused whatever the bookmarks", async () => {
    const { calls, run } = bulking({ sharing: { kind: "unknown_target" } });

    expect(await run("share", { kind: "ids", ids: ["x"] }, { shareTarget: MEMBER_TARGET })).toEqual({ kind: "unknown_target", field: "accountId" });
    expect(calls.shared).toHaveLength(1);
  });

  it("shares nothing when the selection holds a bookmark that is shared with the caller, the recipient's access staying as it was", async () => {
    const RECIPIENT_ONLY = idOf(900);
    const { calls, run } = bulking({ shared: [RECIPIENT_ONLY] });

    expect(await run("share", { kind: "ids", ids: [OWN_A, RECIPIENT_ONLY] }, { shareTarget: MEMBER_TARGET })).toEqual({ kind: "forbidden" });
    expect(calls.shared).toEqual([]);
    expect(calls.events).toEqual([]);
  });
});

describe("previewBulkShare", () => {
  it("counts the caller's own bookmarks the way the bulk share does and answers the audience, writing nothing", async () => {
    const audience = { kind: "team", id: TEAM.toLowerCase(), name: "Design", memberCount: 4, added: 1 } as const;
    const { calls, previewShare } = bulking({ sharePreviewing: { kind: "previewed", affected: 2, audience } });

    const outcome = await previewShare({ kind: "ids", ids: [idOf(1), idOf(2), idOf(3)] }, TEAM_TARGET);

    expect(outcome).toEqual({ kind: "previewed", requested: 3, affected: 2, skipped: { not_owner: 0, not_found: 1 }, audience });
    expect(calls.sharePreviewed).toEqual([{ bookmarkIds: [idOf(1), idOf(2), idOf(3)], ownerId: ACCOUNT.toLowerCase(), target: { kind: "team", teamId: TEAM.toLowerCase() } }]);
    expect(calls.shared).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("refuses the caller as the member, a target the workspace does not have, and a selection that is too large", async () => {
    const unknown = bulking({ sharePreviewing: { kind: "unknown_target" } });
    const large = bulking();

    expect(await unknown.previewShare({ kind: "ids", ids: [idOf(1)] }, TEAM_TARGET)).toEqual({ kind: "unknown_target", field: "teamId" });
    expect(await large.previewShare({ kind: "ids", ids: [idOf(1)] }, { kind: "member", accountId: ACCOUNT })).toEqual({ kind: "self" });
    expect(await large.previewShare({ kind: "ids", ids: Array.from({ length: BOOKMARK_BULK_IDS_MAX + 1 }, (_, index) => idOf(index)) }, MEMBER_TARGET)).toEqual({ kind: "too_many", limit: BOOKMARK_BULK_IDS_MAX });
    expect(large.calls.sharePreviewed).toEqual([]);
  });
});
