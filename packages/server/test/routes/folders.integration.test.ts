import { FOLDER_ICONS } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST and GET /api/v1/folders, GET, PATCH and DELETE /api/v1/folders/{id} (doc 04 sections 2.4 and 10.7, doc 02 section 7.1, doc 05 section
// 2.4, doc 10 T1 and T2), through the whole chain over the migrated database. The failure scenario: member B lists, reads and renames member
// A's folder of the same workspace, and every call answers an empty list or 404. Besides that: the creation (name 1 to 64 characters, stored
// as entered, unique per owner without regard to case, 409 name_taken; icon from the published list; colour 1 to 8), the list with the
// number of bookmarks of each folder, its search, its three sorts and its signed keyset cursor, the read with its ETag, the change with
// If-Match (412) and the deletion that leaves the bookmarks, and that a token needs the write scope to change folders and the read scope to
// read them.

const TEST_TIMEOUT_MS = 60_000;
const FOLDERS = "/api/v1/folders";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { readonly path: string; readonly code: string }[];
}

interface Folder {
  readonly id: string;
  readonly ownerId: string | null;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
  readonly bookmarkCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FolderList {
  readonly items: readonly Folder[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly totalAtLeast?: number;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const create = (world: World, as: Person, body: unknown) => send(world, "POST", FOLDERS, { cookie: as.cookie }, body);
const list = (world: World, as: Person, query = "") => send(world, "GET", `${FOLDERS}${query}`, { cookie: as.cookie });
const read = (world: World, as: Person, id: string) => send(world, "GET", `${FOLDERS}/${id}`, { cookie: as.cookie });
const change = (world: World, as: Person, id: string, body: unknown, headers: Record<string, string> = {}) => send(world, "PATCH", `${FOLDERS}/${id}`, { cookie: as.cookie, ...headers }, body);
const remove = (world: World, as: Person, id: string) => send(world, "DELETE", `${FOLDERS}/${id}`, { cookie: as.cookie });

async function created(world: World, as: Person, name: string, extra: Record<string, unknown> = {}): Promise<Folder> {
  const response = await create(world, as, { name, ...extra });
  expect(response.status).toBe(201);
  return (await response.json()) as Folder;
}

async function namesOf(world: World, as: Person, query = ""): Promise<readonly string[]> {
  const response = await list(world, as, query);
  expect(response.status).toBe(200);
  return ((await response.json()) as FolderList).items.map((folder) => folder.name);
}

interface StoredFolder {
  id: string;
  owner_id: string | null;
  workspace_id: string;
  name: string;
  icon: string;
  color: number;
  version: number;
}

async function storedFolders(): Promise<StoredFolder[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<StoredFolder[]>`SELECT id, owner_id, workspace_id, name, icon, color, version FROM folders ORDER BY name`;
  });
}

/** Files a new bookmark of the owner in the folder, the way the operation that files bookmarks will: as the system, since a request may not yet. */
async function fileBookmark(workspaceId: string, ownerId: string, folderId: string, archived = false): Promise<string> {
  const bookmarkId = crypto.randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${bookmarkId}, ${workspaceId}, ${ownerId}, 'https://example.com/filed', 'https://example.com/filed', 'example.com', 'Filed', ${archived ? new Date() : null})`;
    await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`;
  });
  return bookmarkId;
}

async function storedFilings(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: string }[]>`SELECT count(*)::text AS n FROM folder_bookmarks`;
  });
  return Number(rows[0]?.n);
}

async function storedBookmarks(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmarks`;
  });
  return Number(rows[0]?.n);
}

/** Gives the owner `count` folders named `Bulk 00001` and on, as the system: far more than a request creates in a test. */
async function seedFolders(workspaceId: string, ownerId: string, count: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO folders (id, workspace_id, owner_id, name)
      SELECT gen_random_uuid(), ${workspaceId}, ${ownerId}, 'Bulk ' || lpad(n::text, 5, '0') FROM generate_series(1, ${count}::int) AS n`;
  });
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

describe("a folder is its owner's alone (T2)", () => {
  it(
    "is not listed, read or renamed by another member of the workspace, who gets an empty list and 404 and changes nothing",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      const folder = await created(world, owner, "Owner's private folder");
      await fileBookmark(shared.workspaceId, owner.account.id, folder.id);
      const before = await storedFolders();

      const listed = await list(world, member);
      const searched = await list(world, member, "?q=private");
      const fetched = await read(world, member, folder.id);
      const renamed = await change(world, member, folder.id, { name: "Taken over", icon: "star", color: 5 });
      const withVersion = await change(world, member, folder.id, { name: "Taken over" }, { "if-match": '"1"' });
      const deleted = await remove(world, member, folder.id);

      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ items: [], nextCursor: null, total: 0 });
      expect(((await searched.json()) as FolderList).items).toEqual([]);
      expect([fetched.status, renamed.status, withVersion.status, deleted.status]).toEqual([404, 404, 404, 404]);
      expect(await Promise.all([fetched, renamed, withVersion, deleted].map(async (response) => (await problemOf(response)).code))).toEqual(["not_found", "not_found", "not_found", "not_found"]);
      expect(await storedFolders()).toEqual(before);
      expect(await storedFilings()).toBe(1);
      // The owner still has everything.
      expect(await namesOf(world, owner)).toEqual(["Owner's private folder"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for the folder of another workspace and an unknown one, as for another member's, in every operation",
    async () => {
      const world = harness.serve();
      const { owner, stranger } = await setup(world);
      const mine = await created(world, owner, "Mine");
      const theirs = await created(world, stranger, "Theirs");

      for (const id of [theirs.id, crypto.randomUUID()]) {
        expect((await read(world, owner, id)).status).toBe(404);
        expect((await change(world, owner, id, { name: "Nope" })).status).toBe(404);
        expect((await remove(world, owner, id)).status).toBe(404);
      }
      expect((await read(world, stranger, mine.id)).status).toBe(404);
      expect((await storedFolders()).map((row) => row.name)).toEqual(["Mine", "Theirs"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lists nothing of another member's folders or of another workspace's, whoever asks",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      await created(world, owner, "Owner's");
      await created(world, member, "Member's");
      await created(world, stranger, "Stranger's");

      expect(await namesOf(world, owner)).toEqual(["Owner's"]);
      expect(await namesOf(world, member)).toEqual(["Member's"]);
      expect(await namesOf(world, stranger)).toEqual(["Stranger's"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404, not the folder, to an account whose member left: a folder with no owner belongs to nobody",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      const folder = await created(world, member, "Former member's");
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`DELETE FROM workspace_members WHERE workspace_id = ${shared.workspaceId} AND account_id = ${member.account.id}`;
      });

      expect((await read(world, owner, folder.id)).status).toBe(404);
      expect((await change(world, owner, folder.id, { name: "Mine now" })).status).toBe(404);
      expect((await remove(world, owner, folder.id)).status).toBe(404);
      expect(await namesOf(world, owner)).toEqual([]);
      expect((await storedFolders()).map((row) => [row.name, row.owner_id])).toEqual([["Former member's", null]]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("createFolder", () => {
  it(
    "answers 201 with the folder as entered, the default icon and colour, no bookmarks and version 1, and stores it for the caller in the workspace of the request",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);

      const response = await create(world, owner, { name: "  Reading List  " });

      expect(response.status).toBe(201);
      const folder = (await response.json()) as Folder;
      expect(folder).toEqual({
        id: folder.id,
        ownerId: owner.account.id,
        name: "Reading List",
        icon: "folder",
        color: 1,
        bookmarkCount: 0,
        version: 1,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      });
      expect(new Date(folder.createdAt).toISOString()).toBe(folder.createdAt);
      expect(await storedFolders()).toEqual([{ id: folder.id, owner_id: owner.account.id, workspace_id: shared.workspaceId, name: "Reading List", icon: "folder", color: 1, version: 1 }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes an icon of the published list and a colour from 1 to 8, and refuses any other with 422, writing nothing",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      expect(FOLDER_ICONS).toHaveLength(60);
      const styled = await created(world, owner, "Trips", { icon: "plane", color: 8 });
      expect([styled.icon, styled.color]).toEqual(["plane", 8]);
      for (const body of [{ icon: "not-an-icon" }, { icon: "Folder" }, { icon: "" }, { icon: 5 }, { color: 0 }, { color: 9 }, { color: 1.5 }, { color: "3" }, { color: null }]) {
        const response = await create(world, owner, { name: "Rejected", ...body });
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect(await storedFolders()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 409 name_taken for a name the caller has in any case, writing nothing, and lets another member use the name",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      await created(world, owner, "Reading List");

      for (const name of ["Reading List", "reading list", "READING LIST", " Reading List "]) {
        const refused = await create(world, owner, { name });
        expect(refused.status).toBe(409);
        const problem = await problemOf(refused);
        expect(problem.code).toBe("name_taken");
        expect(problem.errors).toEqual([{ path: "name", code: "name_taken" }]);
      }
      expect(await storedFolders()).toHaveLength(1);

      expect((await create(world, member, { name: "reading list" })).status).toBe(201);
      expect((await storedFolders()).map((folder) => [folder.name, folder.owner_id]).sort()).toEqual(
        [["Reading List", owner.account.id], ["reading list", member.account.id]].sort(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes one folder of the creations of one name at the same time and answers the others 409 name_taken",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      const responses = await Promise.all([1, 2, 3, 4].map(() => create(world, owner, { name: "Race" })));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await storedFolders()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for a name that is missing, blank or longer than 64 characters, and for a field it does not declare, writing nothing",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(65) }, { name: 5 }, { name: "ok", owner: "someone" }]) {
        const response = await create(world, owner, body);
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect((await create(world, owner, { name: "x".repeat(64) })).status).toBe(201);
      expect((await create(world, owner, { name: "😀".repeat(64) })).status).toBe(201);
      expect(await storedFolders()).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and writes nothing; a read-write token creates",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await send(world, "POST", FOLDERS, {}, { name: "Anonymous" })).status).toBe(401);
      const crossSite = await send(world, "POST", FOLDERS, { cookie: owner.cookie, origin: "https://evil.example" }, { name: "Cross site" });
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "POST", FOLDERS, bearer(readOnly), { name: "Read-only" });
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect(await storedFolders()).toEqual([]);

      expect((await send(world, "POST", FOLDERS, bearer(readWrite), { name: "By token" })).status).toBe(201);
      expect((await storedFolders()).map((folder) => [folder.name, folder.owner_id])).toEqual([["By token", owner.account.id]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 to an account with no workspace",
    async () => {
      const world = harness.serve();
      const loner = await harness.person(world);

      expect((await create(world, loner, { name: "Nowhere" })).status).toBe(404);
      expect((await list(world, loner)).status).toBe(404);
      expect(await storedFolders()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("listFolders", () => {
  it(
    "lists the caller's folders with their counts by name, and by count and then name, leaving out plan-archived bookmarks",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const busy = await created(world, owner, "Busy");
      const quiet = await created(world, owner, "quiet");
      await created(world, owner, "Apple");
      await fileBookmark(shared.workspaceId, owner.account.id, busy.id);
      await fileBookmark(shared.workspaceId, owner.account.id, busy.id);
      await fileBookmark(shared.workspaceId, owner.account.id, busy.id, true);
      await fileBookmark(shared.workspaceId, owner.account.id, quiet.id);

      const byName = await list(world, owner);
      const byCount = await list(world, owner, "?sort=count");

      expect(byName.status).toBe(200);
      const named = (await byName.json()) as FolderList;
      expect(named.items.map((folder) => [folder.name, folder.bookmarkCount])).toEqual([["Apple", 0], ["Busy", 2], ["quiet", 1]]);
      expect(named.total).toBe(3);
      expect(((await byCount.json()) as FolderList).items.map((folder) => [folder.name, folder.bookmarkCount])).toEqual([["Busy", 2], ["quiet", 1], ["Apple", 0]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lists the folder changed last first with the sort by updated, and a rename moves a folder to the front",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const first = await created(world, owner, "First");
      await created(world, owner, "Second");
      await created(world, owner, "Third");
      expect(await namesOf(world, owner, "?sort=updated")).toEqual(["Third", "Second", "First"]);

      expect((await change(world, owner, first.id, { color: 4 })).status).toBe(200);

      expect(await namesOf(world, owner, "?sort=updated")).toEqual(["First", "Third", "Second"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pages the list by keyset in every sort: every folder once, a nextCursor until the last page, and the total of all pages on each",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      for (const [name, filed] of [["Delta", 2], ["alpha", 0], ["Charlie", 2], ["Bravo", 1], ["Echo", 0]] as const) {
        const folder = await created(world, owner, name);
        for (let link = 0; link < filed; link += 1) {
          await fileBookmark(shared.workspaceId, owner.account.id, folder.id);
        }
      }

      for (const [sort, expected] of [
        ["name", ["alpha", "Bravo", "Charlie", "Delta", "Echo"]],
        ["count", ["Charlie", "Delta", "Bravo", "alpha", "Echo"]],
        ["updated", ["Echo", "Bravo", "Charlie", "alpha", "Delta"]],
      ] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const response = await list(world, owner, `?sort=${sort}&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
          expect(response.status).toBe(200);
          const page = (await response.json()) as FolderList;
          expect(page.total).toBe(5);
          expect(page.totalAtLeast).toBeUndefined();
          seen.push(...page.items.map((folder) => folder.name));
          cursor = page.nextCursor;
          pages += 1;
          expect(page.items.length).toBe(cursor === null ? 1 : 2);
        } while (cursor !== null && pages < 10);
        expect([sort, pages, seen]).toEqual([sort, 3, expected]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds the folders whose name contains q without regard to case, counts only those in the total and pages through them",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      for (const name of ["Reading list", "Bread", "Cooking", "100% done", "ready_to_go"]) {
        await created(world, owner, name);
      }

      expect(await namesOf(world, owner, "?q=READ")).toEqual(["Bread", "Reading list", "ready_to_go"]);
      expect(await namesOf(world, owner, "?q=%25")).toEqual(["100% done"]);
      expect(await namesOf(world, owner, "?q=_")).toEqual(["ready_to_go"]);
      expect(await namesOf(world, owner, "?q=nothing")).toEqual([]);
      const page = (await (await list(world, owner, "?q=read&limit=2")).json()) as FolderList;
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(2);
      const next = (await (await list(world, owner, `?q=read&limit=2&cursor=${encodeURIComponent(page.nextCursor ?? "")}`)).json()) as FolderList;
      expect([...page.items, ...next.items].map((folder) => folder.name)).toEqual(["Bread", "Reading list", "ready_to_go"]);
      expect(next.nextCursor).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names the caller's own folders for scope all and scope mine alike",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      await created(world, owner, "Owner's");
      await created(world, member, "Member's");

      expect(await namesOf(world, owner, "?scope=all")).toEqual(["Owner's"]);
      expect(await namesOf(world, owner, "?scope=mine")).toEqual(["Owner's"]);
      expect((await list(world, owner, "?scope=shared")).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a cursor that was forged, altered, issued for another sort, search, scope or account with 400, and reads nothing of another member's folders through one",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      await created(world, owner, "One");
      await created(world, owner, "Two");
      await created(world, member, "Member's");
      const first = (await (await list(world, owner, "?limit=1")).json()) as FolderList;
      const cursor = first.nextCursor;
      expect(cursor).not.toBeNull();
      const query = (parameters: string) => `?${parameters}&limit=1&cursor=${encodeURIComponent(cursor ?? "")}`;

      expect((await list(world, owner, query("sort=name"))).status).toBe(200);
      expect((await list(world, owner, query("sort=count"))).status).toBe(400);
      expect((await list(world, owner, query("sort=updated"))).status).toBe(400);
      expect((await list(world, owner, query("sort=name&q=o"))).status).toBe(400);
      expect((await list(world, owner, query("sort=name&scope=mine"))).status).toBe(400);
      expect((await list(world, member, query("sort=name"))).status).toBe(400);
      expect((await list(world, owner, `?limit=1&cursor=${encodeURIComponent(`${cursor ?? ""}x`)}`)).status).toBe(400);
      const refused = await list(world, owner, "?limit=1&cursor=forged");
      expect(refused.status).toBe(400);
      expect((await problemOf(refused)).code).toBe("bad_request");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives the exact total up to 10 000 folders and null with totalAtLeast above, counting only the caller's folders",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      await seedFolders(shared.workspaceId, member.account.id, 5);
      await seedFolders(shared.workspaceId, owner.account.id, 10_000);

      const atTheCap = (await (await list(world, owner, "?limit=1")).json()) as FolderList;
      expect(atTheCap.total).toBe(10_000);
      expect(atTheCap.totalAtLeast).toBeUndefined();
      expect(atTheCap.items).toHaveLength(1);
      expect(atTheCap.nextCursor).not.toBeNull();

      await created(world, owner, "One more");
      const above = (await (await list(world, owner, "?limit=1")).json()) as FolderList;
      expect(above.total).toBeNull();
      expect(above.totalAtLeast).toBe(10_000);
      expect(above.items).toHaveLength(1);
    },
    TEST_TIMEOUT_MS * 2,
  );

  it(
    "answers 422 for a sort or a parameter it does not declare, a search that is blank or over-long and a limit outside 1 to 100, and an empty list for a caller with no folders",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      for (const query of ["?sort=newest", "?offset=5", "?limit=0", "?limit=101", `?q=${"x".repeat(65)}`, "?q=%20"]) {
        expect((await list(world, owner, query)).status, query).toBe(422);
      }
      const empty = await list(world, owner);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ items: [], nextCursor: null, total: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401) and lets a read-only token list the folders of the account it is bound to",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      await created(world, owner, "Owner's");
      await created(world, member, "Member's");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");

      expect((await send(world, "GET", FOLDERS, {})).status).toBe(401);
      const response = await send(world, "GET", FOLDERS, bearer(readOnly));
      expect(response.status).toBe(200);
      expect(((await response.json()) as FolderList).items.map((folder) => folder.name)).toEqual(["Owner's"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("getFolder", () => {
  it(
    "returns the caller's folder with its count, its version in the body and the ETag",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const folder = await created(world, owner, "Reading", { icon: "book", color: 3 });
      await fileBookmark(shared.workspaceId, owner.account.id, folder.id);
      await fileBookmark(shared.workspaceId, owner.account.id, folder.id, true);

      const response = await read(world, owner, folder.id);

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe('"1"');
      expect(await response.json()).toEqual({ ...folder, bookmarkCount: 1 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401), answers 422 for an identifier that is not a UUID, and lets a read-only token read",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const folder = await created(world, owner, "Reading");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");

      expect((await send(world, "GET", `${FOLDERS}/${folder.id}`, {})).status).toBe(401);
      expect((await read(world, owner, "not-a-uuid")).status).toBe(422);
      expect((await send(world, "GET", `${FOLDERS}/${folder.id}`, bearer(readOnly))).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("updateFolder", () => {
  it(
    "changes the name, the icon and the colour of the caller's folder, moves the version, keeps the count and answers the folder as it now is with the new ETag",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const folder = await created(world, owner, "Alpha");
      await fileBookmark(shared.workspaceId, owner.account.id, folder.id);

      const renamed = await change(world, owner, folder.id, { name: "  Beta ", icon: "star", color: 6 });

      expect(renamed.status).toBe(200);
      expect(renamed.headers.get("etag")).toBe('"2"');
      const body = (await renamed.json()) as Folder;
      expect(body).toMatchObject({ id: folder.id, name: "Beta", icon: "star", color: 6, bookmarkCount: 1, version: 2, createdAt: folder.createdAt });
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(new Date(folder.updatedAt).getTime());
      expect((await storedFolders()).map((row) => [row.name, row.icon, row.color, row.version])).toEqual([["Beta", "star", 6, 2]]);
      expect((await change(world, owner, folder.id, { name: "BETA" })).status).toBe(200);
      expect((await storedFolders()).map((row) => [row.name, row.version])).toEqual([["BETA", 3]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 200 with the unchanged ETag and writes nothing for an empty patch and for a patch that names the values the folder has",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const folder = await created(world, owner, "Alpha", { icon: "star", color: 2 });

      for (const body of [{}, { name: "Alpha" }, { name: " Alpha ", icon: "star", color: 2 }]) {
        const response = await change(world, owner, folder.id, body);
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(response.headers.get("etag")).toBe('"1"');
        expect(await response.json()).toEqual(folder);
      }
      expect((await storedFolders()).map((row) => row.version)).toEqual([1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a stale If-Match with 412 precondition_failed and writes nothing, and applies a current one, a list holding it and *",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const folder = await created(world, owner, "Alpha");

      expect((await change(world, owner, folder.id, { name: "Second" }, { "if-match": '"1"' })).status).toBe(200);
      const stale = await change(world, owner, folder.id, { name: "Overwrite" }, { "if-match": '"1"' });
      expect(stale.status).toBe(412);
      expect((await problemOf(stale)).code).toBe("precondition_failed");
      expect((await storedFolders()).map((row) => [row.name, row.version])).toEqual([["Second", 2]]);

      expect((await change(world, owner, folder.id, { name: "Third" }, { "if-match": '"2"' })).status).toBe(200);
      expect((await change(world, owner, folder.id, { name: "Fourth" }, { "if-match": '"1", "3"' })).status).toBe(200);
      expect((await change(world, owner, folder.id, { name: "Fifth" }, { "if-match": "*" })).status).toBe(200);
      for (const header of ['W/"5"', "5", '""', "garbage"]) {
        expect((await change(world, owner, folder.id, { name: "Weak" }, { "if-match": header })).status, header).toBe(412);
      }
      expect((await storedFolders()).map((row) => [row.name, row.version])).toEqual([["Fifth", 5]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets two patches against one version make one change: the second is refused with 412",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const folder = await created(world, owner, "Alpha");

      const [first, second] = await Promise.all([
        change(world, owner, folder.id, { name: "From tab one" }, { "if-match": '"1"' }),
        change(world, owner, folder.id, { name: "From tab two" }, { "if-match": '"1"' }),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 412]);
      expect((await storedFolders())[0]?.version).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "applies a patch without If-Match, as an API token does, and answers the ETag of the new version",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const folder = await created(world, owner, "Alpha");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      const response = await send(world, "PATCH", `${FOLDERS}/${folder.id}`, bearer(readWrite), { name: "By token" });

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe('"2"');
      expect(((await response.json()) as Folder).name).toBe("By token");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 409 name_taken for a name another folder of the caller has, in any case, writing nothing, and lets the caller take a name another member has",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      const alpha = await created(world, owner, "Alpha");
      await created(world, owner, "Beta");
      await created(world, member, "Gamma");

      for (const name of ["Beta", "beta", " BETA "]) {
        const refused = await change(world, owner, alpha.id, { name });
        expect(refused.status).toBe(409);
        const problem = await problemOf(refused);
        expect(problem.code).toBe("name_taken");
        expect(problem.errors).toEqual([{ path: "name", code: "name_taken" }]);
      }
      expect((await change(world, owner, alpha.id, { name: "Gamma" })).status).toBe(200);
      expect((await storedFolders()).map((row) => [row.name, row.version])).toEqual([["Beta", 1], ["Gamma", 1], ["Gamma", 2]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets one of the renames to one name at the same time through and answers the others 409 name_taken",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const [first, second, third] = [await created(world, owner, "One"), await created(world, owner, "Two"), await created(world, owner, "Three")];

      const responses = await Promise.all([first, second, third].map((folder) => change(world, owner, folder.id, { name: "Contested" })));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
      expect((await storedFolders()).filter((row) => row.name === "Contested")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for an identifier that is not a UUID and for a name that is blank or over-long, an icon outside the list, a colour outside 1 to 8, a null or a field it does not declare, writing nothing",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const folder = await created(world, owner, "Alpha");

      expect((await change(world, owner, "not-a-uuid", { name: "Beta" })).status).toBe(422);
      for (const body of [{ name: "" }, { name: "  " }, { name: "x".repeat(65) }, { name: null }, { icon: "nope" }, { icon: null }, { color: 0 }, { color: 9 }, { color: null }, { ownerId: crypto.randomUUID() }, { version: 9 }]) {
        const response = await change(world, owner, folder.id, body);
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect((await storedFolders()).map((row) => [row.name, row.version])).toEqual([["Alpha", 1]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and writes nothing",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const folder = await created(world, owner, "Alpha");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");

      expect((await send(world, "PATCH", `${FOLDERS}/${folder.id}`, {}, { name: "Anonymous" })).status).toBe(401);
      const crossSite = await send(world, "PATCH", `${FOLDERS}/${folder.id}`, { cookie: owner.cookie, origin: "https://evil.example" }, { name: "Cross site" });
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "PATCH", `${FOLDERS}/${folder.id}`, bearer(readOnly), { name: "Read-only" });
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect((await storedFolders()).map((row) => row.name)).toEqual(["Alpha"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("deleteFolder", () => {
  it(
    "answers 204, deletes the folder with its filings, keeps the bookmarks and the caller's other folders, and answers the repeat 404",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const doomed = await created(world, owner, "Doomed");
      const kept = await created(world, owner, "Kept");
      await fileBookmark(shared.workspaceId, owner.account.id, doomed.id);
      await fileBookmark(shared.workspaceId, owner.account.id, kept.id);
      expect(await storedBookmarks()).toBe(2);

      const response = await remove(world, owner, doomed.id);

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect((await storedFolders()).map((row) => row.name)).toEqual(["Kept"]);
      expect(await storedFilings()).toBe(1);
      expect(await storedBookmarks()).toBe(2);
      const again = await remove(world, owner, doomed.id);
      expect(again.status).toBe(404);
      expect((await problemOf(again)).code).toBe("not_found");
      expect((await read(world, owner, doomed.id)).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for an identifier that is not a UUID, and is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope)",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const folder = await created(world, owner, "Alpha");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await remove(world, owner, "not-a-uuid")).status).toBe(422);
      expect((await send(world, "DELETE", `${FOLDERS}/${folder.id}`, {})).status).toBe(401);
      const crossSite = await send(world, "DELETE", `${FOLDERS}/${folder.id}`, { cookie: owner.cookie, origin: "https://evil.example" });
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "DELETE", `${FOLDERS}/${folder.id}`, bearer(readOnly));
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect((await storedFolders()).map((row) => row.name)).toEqual(["Alpha"]);

      expect((await send(world, "DELETE", `${FOLDERS}/${folder.id}`, bearer(readWrite))).status).toBe(204);
      expect(await storedFolders()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
