import { describe, expect, it } from "vitest";
import { BOOKMARK_LIST_TOTAL_CAP, listBookmarks, type BookmarkCursors, type BookmarkListAsk, type BookmarkListRequest, type BookmarkListRow, type BookmarkListStore, type BookmarkRecord } from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const ALICE = "0192f3a0-bbbb-7000-8000-00000000000B";

function record(id: string): BookmarkRecord {
  return {
    id, ownerId: ALICE.toLowerCase(), url: "https://example.com/", host: "example.com", title: id, description: null, slug: null, forwarding: false, pinned: false,
    openCount: 0, lastOpenedAt: null, version: 1, createdAt: new Date(0), updatedAt: new Date(0),
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
  const port: BookmarkListStore = {
    list(request) {
      lists.push(request);
      return Promise.resolve(rows.slice(0, request.limit));
    },
    count(filter, limit) {
      counts.push({ filter, limit });
      return Promise.resolve(Math.min(count, limit));
    },
  };
  return { port, lists, counts };
}

function ask(overrides: Partial<BookmarkListAsk> = {}): BookmarkListAsk {
  return { workspaceId: WORKSPACE, accountId: ALICE, scope: "all", pinned: undefined, hasSlug: undefined, forwarding: undefined, url: undefined, sort: "recent", limit: 2, cursor: undefined, ...overrides };
}

const ROWS: readonly BookmarkListRow[] = ["a", "b", "c"].map((id) => ({ bookmark: record(id), key: `key-${id}` }));

describe("listBookmarks", () => {
  it("returns a page, asks the store for one more bookmark than the page to know whether another follows, and seals the cursor at the last item of the page", async () => {
    const { port, lists } = store(ROWS);
    const { codec, sealed } = cursors();

    const outcome = await listBookmarks({ store: port, cursors: codec }, ask());

    expect(outcome).toEqual({ kind: "listed", items: [record("a"), record("b")], nextCursor: "cursor-0", total: 3 });
    expect(lists).toEqual([{ filter: { ownerId: ALICE, pinned: undefined, hasSlug: undefined, forwarding: undefined, urlCanonical: undefined }, sort: "recent", after: undefined, limit: 3 }]);
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

    const filter = { ownerId: ALICE, pinned: false, hasSlug: true, forwarding: true, urlCanonical: "https://example.com/a" };
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

  it("gives the exact total up to the cap and null above it, counting no further than one past the cap", async () => {
    const exact = store(ROWS, BOOKMARK_LIST_TOTAL_CAP);
    const above = store(ROWS, BOOKMARK_LIST_TOTAL_CAP + 1);
    const { codec } = cursors();

    expect(await listBookmarks({ store: exact.port, cursors: codec }, ask())).toMatchObject({ total: 10_000 });
    expect(await listBookmarks({ store: above.port, cursors: codec }, ask())).toMatchObject({ total: null });
    expect(above.counts[0]?.limit).toBe(10_001);
  });
});
