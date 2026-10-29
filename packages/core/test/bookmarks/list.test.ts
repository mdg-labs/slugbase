import { describe, expect, it } from "vitest";
import { BOOKMARK_LIST_TOTAL_CAP, listBookmarks, type BookmarkCursors, type BookmarkListAsk, type BookmarkListRequest, type BookmarkListRow, type BookmarkListStore, type BookmarkRecord } from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const ALICE = "0192f3a0-bbbb-7000-8000-00000000000B";

function record(id: string): BookmarkRecord {
  return {
    id, ownerId: ALICE.toLowerCase(), url: "https://example.com/", host: "example.com", title: id, description: null, slug: null, forwarding: false, pinned: false,
    openCount: 0, lastOpenedAt: null, owner: null, sharedVia: null, folders: [], tags: [], version: 1, createdAt: new Date(0), updatedAt: new Date(0),
  };
}

/** A cursor codec that seals nothing but remembers the scope, so a test sees which scope a cursor was issued for and opened under. */
function cursors() {
  const sealed: { scope: string; position: { key: string | null; id: string } }[] = [];
  const codec: BookmarkCursors = {
    seal(position, scope) {
      sealed.push({ scope, position });
      return `cursor-${String(sealed.length - 1)}`;
    },
    open(cursor, scope) {
      const found = sealed[Number(cursor.replace("cursor-", ""))];
      return found !== undefined && found.scope === scope ? found.position : undefined;
    },
  };
  return { codec, sealed };
}

function store(rows: readonly BookmarkListRow[], count = rows.length) {
  const lists: BookmarkListRequest[] = [];
  const counts: { filter: BookmarkListRequest["filter"]; limit: number }[] = [];
  const separate: string[] = [];
  const port: BookmarkListStore = {
    list(request) {
      separate.push("list");
      lists.push(request);
      return Promise.resolve(rows.slice(0, request.limit));
    },
    count(filter, limit) {
      separate.push("count");
      counts.push({ filter, limit });
      return Promise.resolve(Math.min(count, limit));
    },
    listWithCount(request, limit) {
      lists.push(request);
      counts.push({ filter: request.filter, limit });
      return Promise.resolve({ rows: rows.slice(0, request.limit), count: Math.min(count, limit) });
    },
  };
  return { port, lists, counts, separate };
}

function ask(overrides: Partial<BookmarkListAsk> = {}): BookmarkListAsk {
  return { workspaceId: WORKSPACE, accountId: ALICE, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined, sort: "recent", limit: 2, cursor: undefined, ...overrides };
}

const ROWS: readonly BookmarkListRow[] = ["a", "b", "c"].map((id) => ({ bookmark: record(id), key: `key-${id}` }));

describe("listBookmarks", () => {
  it("hands the store the folder to narrow to, in lower case, and seals the cursor for that folder alone", async () => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();
    const folder = "0192f3a0-dddd-7000-8000-00000000000A";
    const dependencies = { store: port, cursors: codec };

    const first = await listBookmarks(dependencies, ask({ folderId: folder }));

    expect(lists[0]?.filter.folderId).toBe(folder.toLowerCase());
    expect(counts[0]?.filter.folderId).toBe(folder.toLowerCase());
    expect(first).toMatchObject({ kind: "listed", nextCursor: "cursor-0" });
    expect(await listBookmarks(dependencies, ask({ folderId: folder, cursor: "cursor-0" }))).toMatchObject({ kind: "listed" });
    expect(await listBookmarks(dependencies, ask({ folderId: "0192f3a0-dddd-7000-8000-00000000000b", cursor: "cursor-0" }))).toEqual({ kind: "bad_cursor" });
    expect(await listBookmarks(dependencies, ask({ cursor: "cursor-0" }))).toEqual({ kind: "bad_cursor" });
  });

  it("hands the store the tags to narrow to, in lower case, without repeats and in a stable order, and seals the cursor for that set alone", async () => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();
    const upper = "0192f3a0-ffff-7000-8000-00000000000B";
    const lower = "0192f3a0-ffff-7000-8000-00000000000a";
    const dependencies = { store: port, cursors: codec };

    const page = await listBookmarks(dependencies, ask({ tagIds: [upper, lower, upper.toLowerCase()] }));

    expect(lists[0]?.filter.tagIds).toEqual(["0192f3a0-ffff-7000-8000-00000000000a", "0192f3a0-ffff-7000-8000-00000000000b"]);
    expect(counts[0]?.filter.tagIds).toEqual(lists[0]?.filter.tagIds);
    expect(page).toMatchObject({ kind: "listed", nextCursor: "cursor-0" });
    // The same tags in another order and spelling are the same list.
    expect(await listBookmarks(dependencies, ask({ tagIds: [lower, upper.toLowerCase()], cursor: "cursor-0" }))).toMatchObject({ kind: "listed" });
    // A cursor of the AND of two tags opens neither for one of them nor for none.
    expect(await listBookmarks(dependencies, ask({ tagIds: [lower], cursor: "cursor-0" }))).toEqual({ kind: "bad_cursor" });
    expect(await listBookmarks(dependencies, ask({ cursor: "cursor-0" }))).toEqual({ kind: "bad_cursor" });
  });

  it("returns a page, asks the store for one more bookmark than the page to know whether another follows, and seals the cursor at the last item of the page", async () => {
    const { port, lists } = store(ROWS);
    const { codec, sealed } = cursors();

    const outcome = await listBookmarks({ store: port, cursors: codec }, ask());

    expect(outcome).toEqual({ kind: "listed", items: [record("a"), record("b")], nextCursor: "cursor-0", total: 3 });
    expect(lists).toEqual([{ filter: { ownerId: ALICE, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, urlCanonical: undefined }, sort: "recent", after: undefined, limit: 3 }]);
    expect(sealed[0]?.position).toEqual({ key: "key-b", id: "b" });
  });

  it("has no next cursor on the last page", async () => {
    const { port } = store(ROWS.slice(0, 2));

    expect(await listBookmarks({ store: port, cursors: cursors().codec }, ask())).toMatchObject({ kind: "listed", nextCursor: null });
  });

  it("resumes after the place its own cursor names and refuses a cursor that was not issued", async () => {
    const { port, lists } = store(ROWS);
    const { codec } = cursors();
    const first = await listBookmarks({ store: port, cursors: codec }, ask());
    const cursor = first.kind === "listed" ? (first.nextCursor ?? "") : "";

    await listBookmarks({ store: port, cursors: codec }, ask({ cursor }));

    expect(lists[1]?.after).toEqual({ key: "key-b", id: "b" });
    expect(await listBookmarks({ store: port, cursors: codec }, ask({ cursor: "cursor-forged" }))).toEqual({ kind: "bad_cursor" });
    expect(lists).toHaveLength(2);
  });

  it.each<[string, Partial<BookmarkListAsk>]>([
    ["another scope", { scope: "mine" }],
    ["another sort", { sort: "most_used" }],
    ["another filter on pinning", { pinned: true }],
    ["another filter on slugs", { hasSlug: true }],
    ["another filter on forwarding", { forwarding: false }],
    ["another URL", { url: "https://example.com/other" }],
    ["a text query", { q: "alpha" }],
    ["another account", { accountId: "0192f3a0-bbbb-7000-8000-000000000002" }],
    ["another workspace", { workspaceId: "0192f3a0-aaaa-7000-8000-000000000002" }],
  ])("refuses, reading nothing, a cursor issued for the list without %s", async (_name, change) => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();
    const first = await listBookmarks({ store: port, cursors: codec }, ask());
    const cursor = first.kind === "listed" ? (first.nextCursor ?? "") : "";
    lists.length = 0;
    counts.length = 0;

    expect(await listBookmarks({ store: port, cursors: codec }, ask({ cursor, ...change }))).toEqual({ kind: "bad_cursor" });
    expect(lists).toEqual([]);
    expect(counts).toEqual([]);
  });

  it("hands the store the text query without the whitespace around it, and a blank one as it is, so that it never widens the list", async () => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();

    await listBookmarks({ store: port, cursors: codec }, ask({ q: "  alpha beta  " }));
    await listBookmarks({ store: port, cursors: codec }, ask({ q: "   " }));

    expect(lists[0]?.filter.q).toBe("alpha beta");
    expect(counts[0]?.filter.q).toBe("alpha beta");
    expect(lists[1]?.filter.q).toBe("");
    expect(counts[1]?.filter.q).toBe("");
  });

  it("hands the store the text query as the search normalises it, with the control characters the database refuses taken out, one that only holds them as a blank text, and none as none", async () => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();

    await listBookmarks({ store: port, cursors: codec }, ask({ q: "a\u0000b\t\u0007c\u200bd  e" }));
    await listBookmarks({ store: port, cursors: codec }, ask({ q: "\u0000\u0001 \u0000" }));
    await listBookmarks({ store: port, cursors: codec }, ask({ q: "x".repeat(150) }));
    await listBookmarks({ store: port, cursors: codec }, ask());

    expect(lists[0]?.filter.q).toBe("a b c d e");
    expect(counts[0]?.filter.q).toBe("a b c d e");
    expect(lists[1]?.filter.q).toBe("");
    expect(counts[1]?.filter.q).toBe("");
    expect(lists[2]?.filter.q).toBe("x".repeat(100));
    expect(lists[3]?.filter.q).toBeUndefined();
  });

  it("seals the cursor for the text query it was issued for alone, so a cursor of q=a replayed with q=b or without a text is refused and nothing is read", async () => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();
    const first = await listBookmarks({ store: port, cursors: codec }, ask({ q: "a" }));
    const cursor = first.kind === "listed" ? (first.nextCursor ?? "") : "";
    expect(cursor).not.toBe("");
    lists.length = 0;
    counts.length = 0;

    expect(await listBookmarks({ store: port, cursors: codec }, ask({ q: "b", cursor }))).toEqual({ kind: "bad_cursor" });
    expect(await listBookmarks({ store: port, cursors: codec }, ask({ cursor }))).toEqual({ kind: "bad_cursor" });
    expect(await listBookmarks({ store: port, cursors: codec }, ask({ q: "A", cursor }))).toEqual({ kind: "bad_cursor" });
    expect(lists).toEqual([]);
    expect(counts).toEqual([]);
    // The same text, whitespace around it aside, is the same list.
    expect(await listBookmarks({ store: port, cursors: codec }, ask({ q: " a ", cursor }))).toMatchObject({ kind: "listed" });
    expect(lists[0]?.after).toEqual({ key: "key-b", id: "b" });
  });

  it("opens a cursor again for the same list written with the same filters, whatever case the identifiers are in", async () => {
    const { port } = store(ROWS);
    const { codec } = cursors();
    const first = await listBookmarks({ store: port, cursors: codec }, ask());
    const cursor = first.kind === "listed" ? (first.nextCursor ?? "") : "";

    const again = await listBookmarks({ store: port, cursors: codec }, ask({ cursor, accountId: ALICE.toUpperCase(), workspaceId: WORKSPACE.toUpperCase() }));

    expect(again.kind).toBe("listed");
  });

  it("narrows the list to the canonical form of the url and keeps the filters it was given", async () => {
    const { port, lists, counts } = store(ROWS);

    await listBookmarks({ store: port, cursors: cursors().codec }, ask({ url: "  HTTPS://Example.COM:443/a/?utm_source=x#frag ", pinned: false, hasSlug: true, forwarding: true }));

    const filter = { ownerId: ALICE, scope: "all", pinned: false, hasSlug: true, forwarding: true, urlCanonical: "https://example.com/a" };
    expect(lists[0]?.filter).toEqual(filter);
    expect(counts[0]?.filter).toEqual(filter);
  });

  it.each([
    ["", "empty"],
    ["javascript:alert(1)", "not_http"],
    ["https://", "malformed"],
  ])("refuses the url %j without reading anything", async (url, reason) => {
    const { port, lists, counts } = store(ROWS);

    expect(await listBookmarks({ store: port, cursors: cursors().codec }, ask({ url }))).toEqual({ kind: "url_refused", reason });
    expect(lists).toEqual([]);
    expect(counts).toEqual([]);
  });

  it("reads the page and its count with one call of the store, so that the store can share the work of the two", async () => {
    const { port, lists, counts, separate } = store(ROWS);

    const listed = await listBookmarks({ store: port, cursors: cursors().codec }, ask({ q: " alpha " }));

    expect(listed).toMatchObject({ kind: "listed", total: 3 });
    expect(separate).toEqual([]);
    expect(lists).toHaveLength(1);
    expect(counts).toEqual([{ filter: lists[0]?.filter, limit: 10_001 }]);
  });

  it("gives the exact total up to the cap and null above it, counting no further than one past the cap", async () => {
    const exact = store(ROWS, BOOKMARK_LIST_TOTAL_CAP);
    const above = store(ROWS, BOOKMARK_LIST_TOTAL_CAP + 1);
    const { codec } = cursors();

    expect(await listBookmarks({ store: exact.port, cursors: codec }, ask())).toMatchObject({ total: 10_000 });
    expect(await listBookmarks({ store: above.port, cursors: codec }, ask())).toMatchObject({ total: null });
    expect(above.counts[0]?.limit).toBe(10_001);
  });
});
