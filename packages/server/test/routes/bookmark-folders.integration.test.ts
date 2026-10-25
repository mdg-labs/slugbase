import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Filing bookmarks in folders (doc 04 sections 10.6 and 10.7, doc 02 sections 7.1 and 8.2, doc 13 Q22, doc 10 T1 and T2): POST and DELETE
// /api/v1/folders/{id}/bookmarks, `folderIds` on the creation and the change of a bookmark, `folderId` on the list and the `folders` every
// bookmark carries, through the whole chain over the migrated database. The failure scenario: member A files A's bookmark into member B's
// folder, B's bookmark into A's folder, and a bookmark or a folder of workspace B into A's, and every call answers 404 and changes nothing.

const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const UNKNOWN = "0192f3a0-aaaa-7000-8000-00000000dead";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Problem {
  readonly code: string;
}

interface FolderRef {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

interface Bookmark {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly folders: readonly FolderRef[];
}

interface Folder {
  readonly id: string;
  readonly name: string;
  readonly bookmarkCount: number;
  readonly version: number;
}

interface BookmarkList {
  readonly items: readonly Bookmark[];
  readonly nextCursor: string | null;
  readonly total: number | null;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

async function createdBookmark(world: World, as: Person, title: string, folderIds?: readonly string[]): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...(folderIds === undefined ? {} : { folderIds }) });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function createdFolder(world: World, as: Person, name: string): Promise<Folder> {
  const response = await send(world, "POST", FOLDERS, { cookie: as.cookie }, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Folder;
}

const file = (world: World, as: Person, folderId: string, bookmarkIds: readonly string[]) => send(world, "POST", `${FOLDERS}/${folderId}/bookmarks`, { cookie: as.cookie }, { bookmarkIds });
const unfile = (world: World, as: Person, folderId: string, bookmarkIds: readonly string[]) => send(world, "DELETE", `${FOLDERS}/${folderId}/bookmarks`, { cookie: as.cookie }, { bookmarkIds });
const readBookmark = async (world: World, as: Person, id: string): Promise<Bookmark> => (await (await send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie })).json()) as Bookmark;

async function listed(world: World, as: Person, query: string): Promise<BookmarkList> {
  const response = await send(world, "GET", `${BOOKMARKS}?${query}`, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as BookmarkList;
}

async function storedLinks(): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ link: string }[]>`SELECT folder_id || '/' || bookmark_id AS link FROM folder_bookmarks ORDER BY 1`;
  });
  return rows.map((row) => row.link);
}

async function storedBookmarkRows(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks`;
  });
  return rows[0]?.n ?? -1;
}

/** A workspace of an owner and a member, and one of a stranger. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

describe("the failure scenario: filing across members and workspaces changes nothing (T1, T2)", () => {
  it("answers 404 for A's bookmark into B's folder, B's bookmark into A's folder, and writes no link", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    const folderOfA = await createdFolder(world, owner, "Of A");
    const folderOfB = await createdFolder(world, member, "Of B");
    const bookmarkOfA = await createdBookmark(world, owner, "Of A");
    const bookmarkOfB = await createdBookmark(world, member, "Of B");

    for (const response of [
      await file(world, owner, folderOfB.id, [bookmarkOfA.id]),
      await file(world, owner, folderOfA.id, [bookmarkOfB.id]),
      await file(world, owner, folderOfA.id, [bookmarkOfA.id, bookmarkOfB.id]),
      await file(world, member, folderOfA.id, [bookmarkOfB.id]),
    ]) {
      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe("not_found");
    }
    expect(await storedLinks()).toEqual([]);
  });

  it("answers 404 for a folder or a bookmark of another workspace, and writes no link", async () => {
    const world = harness.serve();
    const { owner, stranger } = await setup(world);
    const folderHere = await createdFolder(world, owner, "Here");
    const folderThere = await createdFolder(world, stranger, "There");
    const bookmarkHere = await createdBookmark(world, owner, "Here");
    const bookmarkThere = await createdBookmark(world, stranger, "There");

    for (const response of [
      await file(world, owner, folderThere.id, [bookmarkHere.id]),
      await file(world, owner, folderHere.id, [bookmarkThere.id]),
      await file(world, owner, folderHere.id, [bookmarkHere.id, bookmarkThere.id]),
      await file(world, owner, UNKNOWN, [bookmarkHere.id]),
      await file(world, owner, folderHere.id, [UNKNOWN]),
    ]) {
      expect(response.status).toBe(404);
    }
    expect(await storedLinks()).toEqual([]);
  });

  it("creates no bookmark, and takes no place under the ceiling, when folderIds names a folder that is another member's, another workspace's or unknown", async () => {
    const world = harness.serve();
    const { owner, member, stranger } = await setup(world);
    const own = await createdFolder(world, owner, "Own");
    const foreign = [(await createdFolder(world, member, "Of B")).id, (await createdFolder(world, stranger, "There")).id, UNKNOWN];

    for (const folderId of foreign) {
      const response = await send(world, "POST", BOOKMARKS, { cookie: owner.cookie }, { url: "https://example.com/refused", title: "Refused", folderIds: [own.id, folderId] });
      expect(response.status).toBe(404);
    }

    expect(await storedBookmarkRows()).toBe(0);
    expect(await storedLinks()).toEqual([]);
    expect(((await (await send(world, "GET", `${FOLDERS}/${own.id}`, { cookie: owner.cookie })).json()) as Folder).bookmarkCount).toBe(0);
  });

  it("changes nothing of a bookmark when its change names a folder that is not the caller's, whatever else the patch says", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    const own = await createdFolder(world, owner, "Own");
    const foreign = await createdFolder(world, member, "Of B");
    const bookmark = await createdBookmark(world, owner, "Kept", [own.id]);

    const response = await send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: owner.cookie }, { title: "Changed", folderIds: [foreign.id] });

    expect(response.status).toBe(404);
    const after = await readBookmark(world, owner, bookmark.id);
    expect(after.title).toBe("Kept");
    expect(after.version).toBe(bookmark.version);
    expect(after.folders.map((folder) => folder.id)).toEqual([own.id]);
  });
});

describe("POST and DELETE /folders/{id}/bookmarks", () => {
  it("files bookmarks and answers the folder with its count, files again without a change, and takes them out again", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const bookmarks = [await createdBookmark(world, owner, "One"), await createdBookmark(world, owner, "Two")];
    const ids = bookmarks.map((bookmark) => bookmark.id);

    const filed = await file(world, owner, folder.id, ids);
    const again = await file(world, owner, folder.id, [...ids, ...ids]);

    expect(filed.status).toBe(200);
    expect(filed.headers.get("etag")).toBe(`"${String(folder.version)}"`);
    expect(await filed.json()).toMatchObject({ id: folder.id, bookmarkCount: 2, version: folder.version });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ bookmarkCount: 2 });
    expect(await storedLinks()).toHaveLength(2);

    const taken = await unfile(world, owner, folder.id, [ids[0] ?? ""]);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ bookmarkCount: 1 });
    expect((await unfile(world, owner, folder.id, [ids[0] ?? ""])).status).toBe(200);
    expect((await readBookmark(world, owner, ids[0] ?? "")).folders).toEqual([]);
    expect((await readBookmark(world, owner, ids[1] ?? "")).folders.map((ref) => ref.id)).toEqual([folder.id]);
    expect(await storedBookmarkRows()).toBe(2);
  });

  it("unfiles none when one bookmark named is another member's or unknown", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const own = await createdBookmark(world, owner, "Own", [folder.id]);
    const theirs = await createdBookmark(world, member, "Theirs");

    expect((await unfile(world, owner, folder.id, [own.id, theirs.id])).status).toBe(404);
    expect((await unfile(world, owner, folder.id, [own.id, UNKNOWN])).status).toBe(404);
    expect((await unfile(world, member, folder.id, [theirs.id])).status).toBe(404);

    expect(await storedLinks()).toEqual([`${folder.id}/${own.id}`]);
  });

  it("answers 422 for no bookmark, more than 1 000, a malformed identifier, a field it does not declare and an identifier that is not a UUID in the path", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const bookmark = await createdBookmark(world, owner, "One");
    const post = (path: string, body: unknown) => send(world, "POST", path, { cookie: owner.cookie }, body);

    for (const body of [{}, { bookmarkIds: [] }, { bookmarkIds: ["nope"] }, { bookmarkIds: Array.from({ length: 1001 }, () => bookmark.id) }, { bookmarkIds: [bookmark.id], extra: 1 }]) {
      expect((await post(`${FOLDERS}/${folder.id}/bookmarks`, body)).status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect((await post(`${FOLDERS}/nope/bookmarks`, { bookmarkIds: [bookmark.id] })).status).toBe(422);
    expect(await storedLinks()).toEqual([]);
  });

  it("is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope); a read-write token files", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const bookmark = await createdBookmark(world, owner, "One");
    const path = `${FOLDERS}/${folder.id}/bookmarks`;
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    expect((await send(world, "POST", path, {}, { bookmarkIds: [bookmark.id] })).status).toBe(401);
    const crossSite = await send(world, "POST", path, { cookie: owner.cookie, origin: "https://evil.example" }, { bookmarkIds: [bookmark.id] });
    expect(crossSite.status).toBe(403);
    expect((await problemOf(crossSite)).code).toBe("cross_site_request");
    for (const method of ["POST", "DELETE"]) {
      const scoped = await send(world, method, path, bearer(readOnly), { bookmarkIds: [bookmark.id] });
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
    }
    expect(await storedLinks()).toEqual([]);

    expect((await send(world, "POST", path, bearer(readWrite), { bookmarkIds: [bookmark.id] })).status).toBe(200);
    expect(await storedLinks()).toEqual([`${folder.id}/${bookmark.id}`]);
    expect((await send(world, "DELETE", path, bearer(readWrite), { bookmarkIds: [bookmark.id] })).status).toBe(200);
    expect(await storedLinks()).toEqual([]);
  });
});

describe("folderIds on the creation and the change of a bookmark, and folders on its body", () => {
  it("files a new bookmark in the folders it names, and carries them in the order of their names on the creation, the read and the list", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const zebra = await createdFolder(world, owner, "Zebra");
    const apple = await createdFolder(world, owner, "apple");

    const bookmark = await createdBookmark(world, owner, "Filed", [zebra.id, apple.id, zebra.id]);

    const refs = [apple, zebra].map((folder) => ({ id: folder.id, name: folder.name, icon: "folder", color: 1 }));
    expect(bookmark.folders).toEqual(refs);
    expect((await readBookmark(world, owner, bookmark.id)).folders).toEqual(refs);
    expect((await listed(world, owner, "")).items[0]?.folders).toEqual(refs);
    expect((await createdBookmark(world, owner, "Loose")).folders).toEqual([]);
  });

  it("replaces the folders on a change, keeps the version and the ETag when only the folders change, and clears them with an empty list", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const [one, two, three] = [await createdFolder(world, owner, "One"), await createdFolder(world, owner, "Two"), await createdFolder(world, owner, "Three")];
    const bookmark = await createdBookmark(world, owner, "Filed", [one.id, two.id]);
    const patch = (body: unknown) => send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: owner.cookie, "if-match": `"${String(bookmark.version)}"` }, body);

    const replaced = await patch({ folderIds: [two.id, three.id] });
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("etag")).toBe(`"${String(bookmark.version)}"`);
    expect(((await replaced.json()) as Bookmark).folders.map((folder) => folder.name)).toEqual(["Three", "Two"]);

    const retitled = await patch({ title: "Renamed", folderIds: [two.id] });
    expect(retitled.status).toBe(200);
    expect(await retitled.json()).toMatchObject({ title: "Renamed", version: bookmark.version + 1, folders: [{ id: two.id }] });

    const left = await send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: owner.cookie }, { description: "kept" });
    expect(((await left.json()) as Bookmark).folders.map((folder) => folder.id)).toEqual([two.id]);
    const cleared = await send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: owner.cookie }, { folderIds: [] });
    expect(((await cleared.json()) as Bookmark).folders).toEqual([]);
    expect(await storedLinks()).toEqual([]);
  });

  it("answers 422 for more than 100 folders or a malformed identifier in folderIds, on both operations", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const bookmark = await createdBookmark(world, owner, "Filed");

    for (const folderIds of [Array.from({ length: 101 }, () => UNKNOWN), ["nope"]]) {
      expect((await send(world, "POST", BOOKMARKS, { cookie: owner.cookie }, { url: "https://example.com/x", title: "X", folderIds })).status).toBe(422);
      expect((await send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: owner.cookie }, { folderIds })).status).toBe(422);
    }
  });
});

describe("GET /bookmarks?folderId=", () => {
  it("lists the caller's bookmarks filed in the folder, counts them and pages through them with a cursor bound to the folder", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const reading = await createdFolder(world, owner, "Reading");
    const other = await createdFolder(world, owner, "Other");
    const filed = [await createdBookmark(world, owner, "A", [reading.id]), await createdBookmark(world, owner, "B", [reading.id]), await createdBookmark(world, owner, "C", [reading.id, other.id])];
    await createdBookmark(world, owner, "Loose");

    const all = await listed(world, owner, `folderId=${reading.id}&sort=title_asc`);
    expect(all.items.map((bookmark) => bookmark.title)).toEqual(["A", "B", "C"]);
    expect(all.total).toBe(3);
    expect((await listed(world, owner, `folderId=${other.id}`)).items.map((bookmark) => bookmark.id)).toEqual([filed[2]?.id]);

    const first = await listed(world, owner, `folderId=${reading.id}&sort=title_asc&limit=2`);
    expect(first.items.map((bookmark) => bookmark.title)).toEqual(["A", "B"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listed(world, owner, `folderId=${reading.id}&sort=title_asc&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.items.map((bookmark) => bookmark.title)).toEqual(["C"]);
    const forged = await send(world, "GET", `${BOOKMARKS}?folderId=${other.id}&sort=title_asc&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, { cookie: owner.cookie });
    expect(forged.status).toBe(400);
  });

  it("answers an empty page for a folder of another member, of another workspace or unknown, not an error and not a row", async () => {
    const world = harness.serve();
    const { owner, member, stranger } = await setup(world);
    const folderOfB = await createdFolder(world, member, "Of B");
    const folderThere = await createdFolder(world, stranger, "There");
    await createdBookmark(world, member, "Of B", [folderOfB.id]);
    await createdBookmark(world, stranger, "There", [folderThere.id]);
    await createdBookmark(world, owner, "Mine");

    for (const folderId of [folderOfB.id, folderThere.id, UNKNOWN]) {
      expect(await listed(world, owner, `folderId=${folderId}`)).toMatchObject({ items: [], nextCursor: null, total: 0 });
    }
  });
});
