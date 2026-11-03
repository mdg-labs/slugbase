import { describe, expect, it } from "vitest";
import {
  BOOKMARK_SELECT_ALL_CAP,
  exportNetscapeStream,
  exportStream,
  resolveExportSelection,
  startExport,
  type AuditWriter,
  type BookmarkListFilter,
  type ExportSharedRow,
  type ExportStore,
  type ExportSummary,
  type NetscapeExportStore,
} from "../../src/index.ts";

// The selection of an export (doc 02 section 5.8, doc 04 section 10.9). The failure scenario: the identifiers of a selection are dropped on the way to a read, so the export holds the member's whole library, or a request by filters
// that matches more than the select-all cap is cut at it and the file silently holds fewer bookmarks than the member selected.

const ME = "0192F3A0-BBBB-7000-8000-00000000000A";
const WORKSPACE = "0192F3A0-BBBB-7000-8000-0000000000F1";
const AT = new Date("2026-11-02T10:00:00.000Z");
const A = "0192F3A0-1111-7000-8000-000000000001";
const B = "0192f3a0-1111-7000-8000-000000000002";

const idsOf = (count: number): string[] => Array.from({ length: count }, (_, index) => `0192f3a0-2222-7000-8000-${String(index).padStart(12, "0")}`);

describe("resolving the selection of an export", () => {
  it("keeps the identifiers a request names, lower-cased and once each, without asking whether the member can read them", async () => {
    let asked = 0;
    const store = { ids: () => ((asked += 1), Promise.resolve([])) };

    const outcome = await resolveExportSelection(store, { kind: "ids", ids: [A, B, A.toLowerCase()] });

    expect(outcome).toEqual({ kind: "selected", only: [A.toLowerCase(), B] });
    expect(asked).toBe(0);
  });

  it("takes at most 100 identifiers", async () => {
    const store = { ids: () => Promise.resolve([]) };

    expect(await resolveExportSelection(store, { kind: "ids", ids: idsOf(100) })).toMatchObject({ kind: "selected" });
    expect(await resolveExportSelection(store, { kind: "ids", ids: idsOf(101) })).toEqual({ kind: "too_many", limit: 100 });
    expect(await resolveExportSelection(store, { kind: "ids", ids: [...idsOf(100), ...idsOf(100)] })).toMatchObject({ kind: "selected" });
  });

  it("resolves the filters as the select-all of the list does: the scope, the folder, the tags and the text reach the store as the filter of the list", async () => {
    const seen: { filter: BookmarkListFilter; limit: number }[] = [];
    const store = { ids: (filter: BookmarkListFilter, limit: number) => (seen.push({ filter, limit }), Promise.resolve([A, B])) };

    const outcome = await resolveExportSelection(store, {
      kind: "filter",
      filter: { accountId: ME, scope: "all", pinned: true, hasSlug: undefined, forwarding: undefined, url: undefined, folderId: B.toUpperCase(), tagIds: [B, A], q: "  docs  " },
    });

    expect(outcome).toEqual({ kind: "selected", only: [A.toLowerCase(), B] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.filter).toMatchObject({ ownerId: ME, scope: "all", pinned: true, folderId: B, tagIds: [A.toLowerCase(), B], q: "docs" });
    expect(seen[0]?.limit).toBe(BOOKMARK_SELECT_ALL_CAP + 1);
  });

  it("refuses the filters of more than the select-all cap instead of cutting the selection at it", async () => {
    const filter = { accountId: ME, scope: "mine", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined } as const;

    const atCap = await resolveExportSelection({ ids: () => Promise.resolve(idsOf(BOOKMARK_SELECT_ALL_CAP)) }, { kind: "filter", filter });
    const over = await resolveExportSelection({ ids: () => Promise.resolve(idsOf(BOOKMARK_SELECT_ALL_CAP + 1)) }, { kind: "filter", filter });

    expect(atCap).toMatchObject({ kind: "selected" });
    expect(atCap.kind === "selected" ? atCap.only : []).toHaveLength(BOOKMARK_SELECT_ALL_CAP);
    expect(over).toEqual({ kind: "too_many", limit: BOOKMARK_SELECT_ALL_CAP });
  });

  it("refuses a url filter that cannot be a bookmark's URL without reading", async () => {
    let asked = 0;
    const store = { ids: () => ((asked += 1), Promise.resolve([])) };

    const outcome = await resolveExportSelection(store, { kind: "filter", filter: { accountId: ME, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: "ftp://example.com/" } });

    expect(outcome.kind).toBe("url_refused");
    expect(asked).toBe(0);
  });

  it("selects nothing when the filters match nothing", async () => {
    const outcome = await resolveExportSelection({ ids: () => Promise.resolve([]) }, { kind: "filter", filter: { accountId: ME, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined } });

    expect(outcome).toEqual({ kind: "selected", only: [] });
  });
});

describe("the export of a selection", () => {
  const ONLY = [A.toLowerCase(), B];
  const theirs: ExportSharedRow = { id: B, url: "https://example.com/theirs", title: "Theirs", description: null, slug: null, ownerName: "Olga Owner" };

  function recorder() {
    const asked: { what: string; only: readonly string[] | undefined }[] = [];
    const note = (what: string, only: readonly string[] | undefined): void => void asked.push({ what, only });
    return { asked, note };
  }

  it("passes the selection to every read of the JSON document, and reads the shared bookmarks without includeShared", async () => {
    const { asked, note } = recorder();
    const store: ExportStore = {
      summary: () => Promise.resolve(undefined),
      folders: (_o, _a, _l, only) => (note("folders", only), Promise.resolve([])),
      tags: (_o, _a, _l, only) => (note("tags", only), Promise.resolve([])),
      bookmarks: (_o, _a, _l, only) =>
        (note("bookmarks", only),
        Promise.resolve([{ id: A.toLowerCase(), url: "https://example.com/a", title: "A", description: null, slug: "a", forwarding: true, pinned: false, planArchived: false, folders: [], tags: [] }])),
      goPreferences: (_o, _a, _l, only) => (note("goPreferences", only), Promise.resolve([])),
      shared: (_o, _a, _l, only) => (note("shared", only), Promise.resolve([theirs])),
    };
    const stream = exportStream({ page: (read) => read(store), onFailure: () => undefined }, { accountId: ME, workspaceName: "Home", exportedAt: AT, includeShared: false, only: ONLY });

    const document = JSON.parse(await new Response(stream).text()) as { bookmarks: unknown[]; shared: { title: string }[] };

    expect(asked.map((entry) => entry.what)).toEqual(["folders", "tags", "bookmarks", "goPreferences", "shared"]);
    expect(asked.every((entry) => entry.only === ONLY)).toBe(true);
    expect(document.bookmarks).toHaveLength(1);
    expect(document.shared.map((entry) => entry.title)).toEqual(["Theirs"]);
  });

  it("holds no shared bookmark without a selection or includeShared, and reads none", async () => {
    const { asked, note } = recorder();
    const store: ExportStore = {
      summary: () => Promise.resolve(undefined),
      folders: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      bookmarks: () => Promise.resolve([]),
      goPreferences: () => Promise.resolve([]),
      shared: (_o, _a, _l, only) => (note("shared", only), Promise.resolve([theirs])),
    };
    const stream = exportStream({ page: (read) => read(store), onFailure: () => undefined }, { accountId: ME, workspaceName: "Home", exportedAt: AT, includeShared: false });

    expect((JSON.parse(await new Response(stream).text()) as { shared: unknown[] }).shared).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("passes the selection to every read of the Netscape file, and reads the shared bookmarks without includeShared", async () => {
    const { asked, note } = recorder();
    const store: NetscapeExportStore = {
      sections: (_o, _a, _l, only) => (note("sections", only), Promise.resolve([{ id: "0192f3a0-ffff-7000-8000-000000000001", name: "Reading" }])),
      folderBookmarks: (_o, _f, _a, _l, only) => (note("folderBookmarks", only), Promise.resolve([])),
      unfiledBookmarks: (_o, _a, _l, only) => (note("unfiledBookmarks", only), Promise.resolve([])),
      shared: (_o, _a, _l, only) => (note("shared", only), Promise.resolve([theirs])),
    };
    const stream = exportNetscapeStream({ page: (read) => read(store), onFailure: () => undefined }, { accountId: ME, includeShared: false, only: ONLY });

    const file = await new Response(stream).text();

    expect(asked.map((entry) => entry.what).sort()).toEqual(["folderBookmarks", "sections", "shared", "unfiledBookmarks"]);
    expect(asked.every((entry) => entry.only === ONLY)).toBe(true);
    expect(file).toContain('<A HREF="https://example.com/theirs">Theirs</A>');
  });

  it("counts the selection for the audit event, asking the store for the shared bookmarks it names", async () => {
    const seen: { includeShared: boolean; only: readonly string[] | undefined }[] = [];
    const store: ExportStore = {
      summary: (_o, includeShared, only): Promise<ExportSummary> => (seen.push({ includeShared, only }), Promise.resolve({ workspaceName: "Home", bookmarks: 1, folders: 0, tags: 0, shared: 1 })),
      folders: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      bookmarks: () => Promise.resolve([]),
      goPreferences: () => Promise.resolve([]),
      shared: () => Promise.resolve([]),
    };
    const written: unknown[] = [];
    const audit: AuditWriter = { write: (event) => (written.push(event), Promise.resolve()) };
    const ask = { workspaceId: WORKSPACE, accountId: ME, actor: { type: "account", accountId: ME, label: "Me" } as const, ipPrefix: null };

    await startExport({ store, audit }, { ...ask, includeShared: false, only: ONLY });
    await startExport({ store, audit }, { ...ask, includeShared: false });

    expect(seen).toEqual([
      { includeShared: true, only: ONLY },
      { includeShared: false, only: undefined },
    ]);
    expect(written).toHaveLength(2);
  });
});
