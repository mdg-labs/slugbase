import { describe, expect, it } from "vitest";
import { BOOKMARK_LIST_TOTAL_CAP, listArchivedBookmarks, type ArchivedBookmarkListAsk, type ArchivedBookmarkListRequest, type ArchivedBookmarkRow, type ArchivedBookmarkStore, type BookmarkCursors, type BookmarkRecord } from "../../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-00000000000a";
const ALICE = "0192f3a0-bbbb-7000-8000-00000000000B";

function record(id: string): BookmarkRecord {
  return {
    id, ownerId: ALICE.toLowerCase(), url: "https://example.com/", host: "example.com", title: id, description: null, slug: null, forwarding: false, pinned: false,
    openCount: 0, lastOpenedAt: null, owner: null, sharedVia: null, folders: [], tags: [], version: 1, createdAt: new Date(0), updatedAt: new Date(0),
  };
}

function row(id: string): ArchivedBookmarkRow {
  return { bookmark: record(id), archivedAt: new Date("2026-02-01T00:00:00Z"), key: `key-${id}` };
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

function store(rows: readonly ArchivedBookmarkRow[], count = rows.length) {
  const lists: ArchivedBookmarkListRequest[] = [];
  const counts: number[] = [];
  const port: ArchivedBookmarkStore = {
    listArchived(request) {
      lists.push(request);
      return Promise.resolve(rows.slice(0, request.limit));
    },
    countArchived(limit) {
      counts.push(limit);
      return Promise.resolve(Math.min(count, limit));
    },
  };
  return { port, lists, counts };
}

function ask(overrides: Partial<ArchivedBookmarkListAsk> = {}): ArchivedBookmarkListAsk {
  return { workspaceId: WORKSPACE, accountId: ALICE, limit: 2, cursor: undefined, ...overrides };
}

const ROWS = ["a", "b", "c"].map(row);

describe("listArchivedBookmarks", () => {
  it("returns a page, asks the store for one more bookmark than the page to know whether another follows, and seals the cursor at the last item of the page", async () => {
    const { port, lists } = store(ROWS);
    const { codec, sealed } = cursors();

    const outcome = await listArchivedBookmarks({ store: port, cursors: codec }, ask());

    expect(outcome).toEqual({ kind: "listed", items: [row("a"), row("b")], nextCursor: "cursor-0", total: 3 });
    expect(lists).toEqual([{ after: undefined, limit: 3 }]);
    expect(sealed[0]?.position).toEqual({ key: "key-b", id: "b" });
  });

  it("has no next cursor on the last page, and an empty page with a total of 0 when nothing is archived", async () => {
    expect(await listArchivedBookmarks({ store: store(ROWS.slice(0, 2)).port, cursors: cursors().codec }, ask())).toMatchObject({ kind: "listed", nextCursor: null, total: 2 });
    expect(await listArchivedBookmarks({ store: store([]).port, cursors: cursors().codec }, ask())).toEqual({ kind: "listed", items: [], nextCursor: null, total: 0 });
  });

  it("counts exactly up to the cap and gives no total above it", async () => {
    const exact = store(ROWS, BOOKMARK_LIST_TOTAL_CAP);
    const over = store(ROWS, BOOKMARK_LIST_TOTAL_CAP + 5);

    expect(await listArchivedBookmarks({ store: exact.port, cursors: cursors().codec }, ask())).toMatchObject({ total: BOOKMARK_LIST_TOTAL_CAP });
    expect(await listArchivedBookmarks({ store: over.port, cursors: cursors().codec }, ask())).toMatchObject({ total: null });
    expect(over.counts).toEqual([BOOKMARK_LIST_TOTAL_CAP + 1]);
  });

  it("resumes after the place of a cursor it issued for the same account and workspace", async () => {
    const { port, lists } = store(ROWS);
    const { codec } = cursors();
    const dependencies = { store: port, cursors: codec };
    await listArchivedBookmarks(dependencies, ask());

    expect(await listArchivedBookmarks(dependencies, ask({ cursor: "cursor-0" }))).toMatchObject({ kind: "listed" });
    expect(lists[1]).toEqual({ after: { key: "key-b", id: "b" }, limit: 3 });
  });

  it("refuses a cursor issued to another account or for another workspace, and reads nothing", async () => {
    const { port, lists, counts } = store(ROWS);
    const { codec } = cursors();
    const dependencies = { store: port, cursors: codec };
    await listArchivedBookmarks(dependencies, ask());
    lists.length = 0;

    expect(await listArchivedBookmarks(dependencies, ask({ accountId: "0192f3a0-bbbb-7000-8000-00000000000c", cursor: "cursor-0" }))).toEqual({ kind: "bad_cursor" });
    expect(await listArchivedBookmarks(dependencies, ask({ workspaceId: "0192f3a0-aaaa-7000-8000-00000000000b", cursor: "cursor-0" }))).toEqual({ kind: "bad_cursor" });
    expect(await listArchivedBookmarks(dependencies, ask({ cursor: "forged" }))).toEqual({ kind: "bad_cursor" });
    expect(lists).toEqual([]);
    expect(counts).toHaveLength(1);
  });

  it("treats the spelling of the identifiers in the scope alike, and refuses a sealed place that has no archive instant", async () => {
    const { port } = store(ROWS);
    const { codec, sealed } = cursors();
    const dependencies = { store: port, cursors: codec };
    await listArchivedBookmarks(dependencies, ask());

    expect(await listArchivedBookmarks(dependencies, ask({ accountId: ALICE.toLowerCase(), workspaceId: WORKSPACE.toUpperCase(), cursor: "cursor-0" }))).toMatchObject({ kind: "listed" });

    // A cursor of this scope that carries no instant was not issued for this list.
    const scope = sealed[0]?.scope ?? "";
    sealed.push({ scope, position: { key: null, id: "b" } });
    expect(await listArchivedBookmarks(dependencies, ask({ cursor: `cursor-${String(sealed.length - 1)}` }))).toEqual({ kind: "bad_cursor" });
  });
});
