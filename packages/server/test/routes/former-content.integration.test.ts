import { randomUUID } from "node:crypto";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/workspace/former-content/bookmarks and /folders (doc 04 section 10.5, doc 02 sections 2.10 and 3.6, doc 05 sections 2.4 and 7.5, doc 10 T1,
// T2 and T3), through the whole chain over the migrated database. The failure scenario: the policies of `bookmarks` and `folders` name the workspace
// only, so a list that filters on the workspace alone hands an admin a member's private bookmark, a bookmark that a departure still holds and a bookmark
// of the plan's archive; every list below holds the ownerless rows and nothing else. Besides that: an owner and an admin read, a member, an API token and an
// export-only session are refused, the pages follow the signed cursor, and a cursor of another workspace or of the other list is 400.
//
// POST /api/v1/workspace/former-content/delete (doc 04 section 10.5, doc 02 section 2.10, doc 05 section 3.3, doc 10 T1, T2 and T11), through the same chain. The failure
// scenarios: a plain member deletes the workspace's ownerless content; a request that names a row a member owns, one a departure holds, a plan-archived bookmark or a row
// of another workspace deletes it; the workspace's bookmark counter parts from the rows; the event is written without the deletion or the deletion without the event.

const BOOKMARKS = "/api/v1/workspace/former-content/bookmarks";
const FOLDERS = "/api/v1/workspace/former-content/folders";
const DEPARTURE = "0192f3a0-dddd-7000-8000-000000000001";
const DELETE = "/api/v1/workspace/former-content/delete";
const ANY_STRING: unknown = expect.any(String);

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
}

interface FormerBookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FormerFolder {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
  readonly bookmarkCount: number;
  readonly createdAt: string;
}

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

let counter = 0;

/** A UUID-shaped identifier that rises with every call, the order the lists page in. */
function nextId(): string {
  counter += 1;
  return `0192f3a0-eeee-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

interface SeedBookmark {
  readonly workspaceId: string;
  readonly ownerId?: string | null;
  readonly departureId?: string | null;
  readonly planArchivedAt?: Date | null;
  readonly title: string;
  readonly slug?: string | null;
}

async function seedBookmark(bookmark: SeedBookmark): Promise<string> {
  const id = nextId();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, departure_id, plan_archived_at, url, url_canonical, host, title, slug)
      VALUES (${id}, ${bookmark.workspaceId}, ${bookmark.ownerId ?? null}, ${bookmark.departureId ?? null}, ${bookmark.planArchivedAt ?? null},
              'https://example.com/former', 'https://example.com/former', 'example.com', ${bookmark.title}, ${bookmark.slug ?? null})`;
  });
  return id;
}

async function seedFolder(workspaceId: string, name: string, options: { readonly ownerId?: string | null; readonly departureId?: string | null } = {}): Promise<string> {
  const id = nextId();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, departure_id, name) VALUES (${id}, ${workspaceId}, ${options.ownerId ?? null}, ${options.departureId ?? null}, ${name})`;
  });
  return id;
}

async function file(workspaceId: string, folderId: string, bookmarkId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`;
  });
}

interface Setup {
  readonly world: World;
  readonly workspaceId: string;
  readonly owner: Person;
  readonly admin: Person;
  readonly member: Person;
}

async function setup(): Promise<Setup> {
  const world = harness.serve();
  const owner = await harness.person(world);
  const admin = await harness.person(world);
  const member = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: admin, role: "admin" },
    { person: member, role: "member" },
  ]);
  return { world, workspaceId, owner, admin, member };
}

function bookmarksPath(query = ""): string {
  return `${BOOKMARKS}${query}`;
}

describe("the former members' content lists", () => {
  it("hand an admin the bookmarks and folders that have no owner and no departure, and no other row of the workspace, a plan-archived bookmark or a row of another workspace", async () => {
    const { world, workspaceId, owner, admin, member } = await setup();
    const other = await harness.workspaceOf([{ person: await harness.person(world), role: "owner" }]);
    const first = await seedBookmark({ workspaceId, title: "Ownerless one", slug: "former-one" });
    const second = await seedBookmark({ workspaceId, title: "Ownerless two" });
    await seedBookmark({ workspaceId, ownerId: member.account.id, title: "A member's private bookmark" });
    await seedBookmark({ workspaceId, ownerId: owner.account.id, title: "The owner's bookmark" });
    await seedBookmark({ workspaceId, departureId: DEPARTURE, title: "Waiting for its departure" });
    await seedBookmark({ workspaceId, planArchivedAt: new Date(), title: "Plan-archived" });
    await seedBookmark({ workspaceId: other.workspaceId, title: "Ownerless in another workspace" });
    const reading = await seedFolder(workspaceId, "Reading");
    await seedFolder(workspaceId, "A member's folder", { ownerId: member.account.id });
    await seedFolder(workspaceId, "Waiting for its departure", { departureId: DEPARTURE });
    await seedFolder(other.workspaceId, "Ownerless in another workspace");
    await file(workspaceId, reading, first);
    await file(workspaceId, reading, second);

    for (const reader of [admin, owner]) {
      const bookmarks = await send(world, "GET", BOOKMARKS, { cookie: reader.cookie });
      expect(bookmarks.status).toBe(200);
      const bookmarkPage = (await bookmarks.json()) as Page<FormerBookmark>;
      expect(bookmarkPage.items.map((item) => item.title)).toEqual(["Ownerless one", "Ownerless two"]);
      expect(bookmarkPage.items[0]).toEqual({
        id: first,
        title: "Ownerless one",
        url: "https://example.com/former",
        host: "example.com",
        slug: "former-one",
        forwarding: false,
        createdAt: ANY_STRING,
        updatedAt: ANY_STRING,
      });
      expect(bookmarkPage.nextCursor).toBeNull();

      const folders = await send(world, "GET", FOLDERS, { cookie: reader.cookie });
      expect(folders.status).toBe(200);
      const folderPage = (await folders.json()) as Page<FormerFolder>;
      expect(folderPage.items).toEqual([{ id: reading, name: "Reading", icon: "folder", color: 1, bookmarkCount: 2, createdAt: ANY_STRING }]);
      expect(folderPage.nextCursor).toBeNull();
    }
  });

  it("answer an empty page for a workspace with no ownerless content, and never another workspace's", async () => {
    const { world, admin } = await setup();
    const other = await harness.workspaceOf([{ person: await harness.person(world), role: "owner" }]);
    await seedBookmark({ workspaceId: other.workspaceId, title: "Ownerless in another workspace" });
    await seedFolder(other.workspaceId, "Ownerless in another workspace");
    expect(await (await send(world, "GET", BOOKMARKS, { cookie: admin.cookie })).json()).toEqual({ items: [], nextCursor: null });
    expect(await (await send(world, "GET", FOLDERS, { cookie: admin.cookie })).json()).toEqual({ items: [], nextCursor: null });
  });

  it("are refused to a plain member with 403 forbidden, and to a request that carries no session with 401", async () => {
    const { world, workspaceId, member } = await setup();
    await seedBookmark({ workspaceId, title: "Ownerless" });
    for (const path of [BOOKMARKS, FOLDERS]) {
      const refused = await send(world, "GET", path, { cookie: member.cookie });
      expect(refused.status).toBe(403);
      expect(await problemOf(refused)).toMatchObject({ code: "forbidden", status: 403 });
      expect((await send(world, "GET", path, {})).status).toBe(401);
    }
  });

  it("are refused to an API token, a read token and a read-write token alike, even one of an admin", async () => {
    const { world, workspaceId, admin } = await setup();
    await seedBookmark({ workspaceId, title: "Ownerless" });
    for (const scope of ["read", "read-write"] as const) {
      const token = await harness.token(workspaceId, admin, scope);
      for (const path of [BOOKMARKS, FOLDERS]) {
        const refused = await send(world, "GET", path, bearer(token));
        expect(refused.status, `${scope} token on ${path}`).toBe(403);
        await problemOf(refused);
      }
    }
  });

  it("are refused with 403 account_export_only to an admin whose account is in the export-only period", async () => {
    const { world, workspaceId, admin } = await setup();
    await seedBookmark({ workspaceId, title: "Ownerless" });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET access_mode = 'export_only', export_only_until = now() + interval '3 days', export_only_end_action = 'delete' WHERE id = ${admin.account.id}`;
    });
    for (const path of [BOOKMARKS, FOLDERS]) {
      const refused = await send(world, "GET", path, { cookie: admin.cookie });
      expect(refused.status).toBe(403);
      expect(await problemOf(refused)).toMatchObject({ code: "account_export_only", status: 403 });
    }
  });

  it("page the bookmarks by a signed cursor in the order they were created, and answer a last page that has no cursor", async () => {
    const { world, workspaceId, admin } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await seedBookmark({ workspaceId, title: `Page ${String(index)}` }));
    }
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await send(world, "GET", bookmarksPath(`?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`), { cookie: admin.cookie });
      expect(response.status).toBe(200);
      const page = (await response.json()) as Page<FormerBookmark>;
      collected.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(collected).toEqual(ids);
    expect(pages).toBe(3);
  });

  it("page the folders by a signed cursor in the order they were created", async () => {
    const { world, workspaceId, admin } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await seedFolder(workspaceId, `Page ${String(index)}`));
    }
    const first = (await (await send(world, "GET", `${FOLDERS}?limit=2`, { cookie: admin.cookie })).json()) as Page<FormerFolder>;
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = (await (await send(world, "GET", `${FOLDERS}?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, { cookie: admin.cookie })).json()) as Page<FormerFolder>;
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it("refuse with 400 a cursor of another workspace, a cursor of the other list and one that was never issued", async () => {
    const { world, workspaceId, admin } = await setup();
    const otherAdmin = await harness.person(world);
    const other = await harness.workspaceOf([{ person: otherAdmin, role: "owner" }]);
    for (let index = 0; index < 2; index += 1) {
      await seedBookmark({ workspaceId, title: `Ownerless ${String(index)}` });
      await seedBookmark({ workspaceId: other.workspaceId, title: `Other ${String(index)}` });
      await seedFolder(workspaceId, `Folder ${String(index)}`);
      await seedFolder(other.workspaceId, `Other folder ${String(index)}`);
    }
    const bookmarkCursor = ((await (await send(world, "GET", `${BOOKMARKS}?limit=1`, { cookie: admin.cookie })).json()) as Page<FormerBookmark>).nextCursor ?? "";
    const folderCursor = ((await (await send(world, "GET", `${FOLDERS}?limit=1`, { cookie: admin.cookie })).json()) as Page<FormerFolder>).nextCursor ?? "";
    const foreignBookmarkCursor = ((await (await send(world, "GET", `${BOOKMARKS}?limit=1`, { cookie: otherAdmin.cookie })).json()) as Page<FormerBookmark>).nextCursor ?? "";
    expect(bookmarkCursor).not.toBe("");
    expect(folderCursor).not.toBe("");
    expect(foreignBookmarkCursor).not.toBe("");
    const refused = [
      await send(world, "GET", `${BOOKMARKS}?cursor=${encodeURIComponent(foreignBookmarkCursor)}`, { cookie: admin.cookie }),
      await send(world, "GET", `${BOOKMARKS}?cursor=${encodeURIComponent(folderCursor)}`, { cookie: admin.cookie }),
      await send(world, "GET", `${FOLDERS}?cursor=${encodeURIComponent(bookmarkCursor)}`, { cookie: admin.cookie }),
      await send(world, "GET", `${FOLDERS}?cursor=${encodeURIComponent(randomUUID())}`, { cookie: admin.cookie }),
    ];
    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({ code: "bad_request", status: 400 });
    }
    expect((await send(world, "GET", `${BOOKMARKS}?cursor=${encodeURIComponent(bookmarkCursor)}`, { cookie: admin.cookie })).status).toBe(200);
  });

  it("refuse a limit outside 1 to 100 with 422", async () => {
    const { world, admin } = await setup();
    for (const path of [BOOKMARKS, FOLDERS]) {
      expect((await send(world, "GET", `${path}?limit=0`, { cookie: admin.cookie })).status).toBe(422);
      expect((await send(world, "GET", `${path}?limit=101`, { cookie: admin.cookie })).status).toBe(422);
    }
  });
});

interface Deleted {
  readonly bookmarksDeleted: number;
  readonly foldersDeleted: number;
}

/** Sets the counter of the workspace the way creations leave it, for rows these tests insert without the application. */
async function syncCounter(workspaceId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET bookmark_count = (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND plan_archived_at IS NULL) WHERE id = ${workspaceId}`;
  });
}

async function rowsOf(workspaceId: string): Promise<{ readonly bookmarks: string[]; readonly folders: string[] }> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return {
      bookmarks: (await tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`).map((row) => row.id),
      folders: (await tx<{ id: string }[]>`SELECT id FROM folders WHERE workspace_id = ${workspaceId} ORDER BY id`).map((row) => row.id),
    };
  });
}

interface DeletionEvent {
  readonly workspace_id: string;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly metadata: Record<string, string>;
  readonly row: string;
}

async function deletionEvents(workspaceId: string): Promise<DeletionEvent[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<DeletionEvent[]>`
      SELECT workspace_id, actor_type::text AS actor_type, actor_account_id, entity_type, entity_id, metadata, e::text AS row
      FROM audit_events e WHERE workspace_id = ${workspaceId} AND action = 'member.former_content_deleted' ORDER BY created_at, id`;
  });
  return [...rows];
}

async function referencesOf(workspaceId: string): Promise<Record<"filings" | "bookmarkShares" | "folderShares", number>> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? Number.NaN;
    return {
      filings: await count(tx<{ n: number }[]>`SELECT count(*)::int AS n FROM folder_bookmarks WHERE workspace_id = ${workspaceId}`),
      bookmarkShares: await count(tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_shares WHERE workspace_id = ${workspaceId}`),
      folderShares: await count(tx<{ n: number }[]>`SELECT count(*)::int AS n FROM folder_shares WHERE workspace_id = ${workspaceId}`),
    };
  });
}

describe("deleting the former members' content", () => {
  it("deletes the named ownerless bookmarks and folders for an owner and for an admin, with their filings and shares, lowers the counter by the bookmarks and writes one event of counts alone", async () => {
    const { world, workspaceId, owner, admin, member } = await setup();
    const gone = [await seedBookmark({ workspaceId, title: "Private title one", slug: "gone-one" }), await seedBookmark({ workspaceId, title: "Private title two" })];
    const goneFolder = await seedFolder(workspaceId, "Private folder name");
    const keptBookmark = await seedBookmark({ workspaceId, title: "Ownerless, not named" });
    const keptFolder = await seedFolder(workspaceId, "Not named");
    const ownedBookmark = await seedBookmark({ workspaceId, ownerId: member.account.id, title: "A member's" });
    await file(workspaceId, goneFolder, gone[0] ?? "");
    await file(workspaceId, goneFolder, ownedBookmark);
    await file(workspaceId, keptFolder, keptBookmark);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id) VALUES (${nextId()}, ${workspaceId}, ${gone[1] ?? ""}, ${member.account.id})`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id) VALUES (${nextId()}, ${workspaceId}, ${keptBookmark}, ${member.account.id})`;
      await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id) VALUES (${nextId()}, ${workspaceId}, ${goneFolder}, ${member.account.id})`;
    });
    await syncCounter(workspaceId);
    await assertBookmarkCountMatches(database());

    const first = await send(world, "POST", DELETE, { cookie: admin.cookie }, { bookmarkIds: [gone[0], gone[0]], folderIds: [goneFolder] });
    expect(first.status).toBe(200);
    expect((await first.json()) as Deleted).toEqual({ bookmarksDeleted: 1, foldersDeleted: 1 });
    const second = await send(world, "POST", DELETE, { cookie: owner.cookie }, { bookmarkIds: [gone[1]] });
    expect(second.status).toBe(200);
    expect((await second.json()) as Deleted).toEqual({ bookmarksDeleted: 1, foldersDeleted: 0 });

    expect(await rowsOf(workspaceId)).toEqual({ bookmarks: [keptBookmark, ownedBookmark].sort(), folders: [keptFolder] });
    expect(await referencesOf(workspaceId)).toEqual({ filings: 1, bookmarkShares: 1, folderShares: 0 });
    await assertBookmarkCountMatches(database());
    const events = await deletionEvents(workspaceId);
    expect(events.map((event) => event.metadata)).toEqual([
      { bookmarks: "1", folders: "1" },
      { bookmarks: "1", folders: "0" },
    ]);
    expect(events.map((event) => [event.actor_type, event.actor_account_id, event.entity_type, event.entity_id])).toEqual([
      ["account", admin.account.id, null, null],
      ["account", owner.account.id, null, null],
    ]);
    for (const event of events) {
      for (const text of ["Private title", "Private folder", "example.com", "gone-one", ...gone, goneFolder]) {
        expect(event.row).not.toContain(text);
      }
    }
  });

  it("deletes nothing of a row a member owns, one a departure holds, a plan-archived bookmark, another workspace's row or an unknown one, answers 200 with zero counts and records no event", async () => {
    const { world, workspaceId, admin, member } = await setup();
    const other = await harness.workspaceOf([{ person: await harness.person(world), role: "owner" }]);
    const protectedBookmarks = [
      await seedBookmark({ workspaceId, ownerId: member.account.id, title: "A member's private bookmark" }),
      await seedBookmark({ workspaceId, ownerId: admin.account.id, title: "The admin's own bookmark" }),
      await seedBookmark({ workspaceId, departureId: DEPARTURE, title: "Waiting for its departure" }),
      await seedBookmark({ workspaceId, planArchivedAt: new Date(), title: "Plan-archived" }),
      await seedBookmark({ workspaceId: other.workspaceId, title: "Ownerless in another workspace" }),
      randomUUID(),
    ];
    const protectedFolders = [
      await seedFolder(workspaceId, "A member's folder", { ownerId: member.account.id }),
      await seedFolder(workspaceId, "Held by a departure", { departureId: DEPARTURE }),
      await seedFolder(other.workspaceId, "Ownerless in another workspace"),
      randomUUID(),
    ];
    await syncCounter(workspaceId);
    await syncCounter(other.workspaceId);
    const before = { here: await rowsOf(workspaceId), there: await rowsOf(other.workspaceId) };

    const response = await send(world, "POST", DELETE, { cookie: admin.cookie }, { bookmarkIds: protectedBookmarks, folderIds: protectedFolders });

    expect(response.status).toBe(200);
    expect((await response.json()) as Deleted).toEqual({ bookmarksDeleted: 0, foldersDeleted: 0 });
    expect({ here: await rowsOf(workspaceId), there: await rowsOf(other.workspaceId) }).toEqual(before);
    await assertBookmarkCountMatches(database());
    expect(await deletionEvents(workspaceId)).toEqual([]);
    expect(await deletionEvents(other.workspaceId)).toEqual([]);
  });

  it("refuses a plain member with 403 forbidden and deletes nothing, and a request without a session with 401", async () => {
    const { world, workspaceId, member } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    const folder = await seedFolder(workspaceId, "Ownerless folder");
    await syncCounter(workspaceId);
    const before = await rowsOf(workspaceId);

    const refused = await send(world, "POST", DELETE, { cookie: member.cookie }, { bookmarkIds: [bookmark], folderIds: [folder] });
    expect(refused.status).toBe(403);
    expect(await problemOf(refused)).toMatchObject({ code: "forbidden", status: 403 });
    expect((await send(world, "POST", DELETE, {}, { bookmarkIds: [bookmark] })).status).toBe(401);

    expect(await rowsOf(workspaceId)).toEqual(before);
    await assertBookmarkCountMatches(database());
    expect(await deletionEvents(workspaceId)).toEqual([]);
  });

  it("refuses an API token, a read token and a read-write token alike, even one of an admin, and an account in the export-only period with 403", async () => {
    const { world, workspaceId, admin } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    await syncCounter(workspaceId);
    for (const scope of ["read", "read-write"] as const) {
      const token = await harness.token(workspaceId, admin, scope);
      const refused = await send(world, "POST", DELETE, bearer(token), { bookmarkIds: [bookmark] });
      expect(refused.status, `${scope} token`).toBe(403);
      await problemOf(refused);
    }
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE accounts SET access_mode = 'export_only', export_only_until = now() + interval '3 days', export_only_end_action = 'delete' WHERE id = ${admin.account.id}`;
    });
    const exportOnly = await send(world, "POST", DELETE, { cookie: admin.cookie }, { bookmarkIds: [bookmark] });
    expect(exportOnly.status).toBe(403);
    expect(await problemOf(exportOnly)).toMatchObject({ code: "account_export_only", status: 403 });
    expect((await rowsOf(workspaceId)).bookmarks).toEqual([bookmark]);
    expect(await deletionEvents(workspaceId)).toEqual([]);
  });

  it("refuses a request from another site with 403 cross_site_request and deletes nothing", async () => {
    const { world, workspaceId, admin } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    await syncCounter(workspaceId);

    const refused = await send(world, "POST", DELETE, { cookie: admin.cookie, "sec-fetch-site": "cross-site", origin: "https://evil.example" }, { bookmarkIds: [bookmark] });

    expect(refused.status).toBe(403);
    expect(await problemOf(refused)).toMatchObject({ code: "cross_site_request", status: 403 });
    expect((await rowsOf(workspaceId)).bookmarks).toEqual([bookmark]);
  });

  it("refuses a body that names no list, an empty list, more than 1 000 identifiers, a malformed identifier or a field it does not declare with 422, and deletes nothing", async () => {
    const { world, workspaceId, admin } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    await syncCounter(workspaceId);
    const thousandAndOne = Array.from({ length: 1001 }, () => randomUUID());
    const bodies: unknown[] = [
      {},
      { bookmarkIds: [] },
      { folderIds: [] },
      { bookmarkIds: [bookmark], folderIds: [] },
      { bookmarkIds: thousandAndOne },
      { folderIds: thousandAndOne },
      { bookmarkIds: ["not-an-identifier"] },
      { bookmarkIds: [bookmark], extra: true },
      { bookmarkIds: null },
    ];
    for (const body of bodies) {
      const refused = await send(world, "POST", DELETE, { cookie: admin.cookie }, body);
      expect(refused.status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    // Exactly 1 000 in a list is allowed.
    const allowed = await send(world, "POST", DELETE, { cookie: admin.cookie }, { bookmarkIds: thousandAndOne.slice(0, 1000) });
    expect(allowed.status).toBe(200);
    expect((await rowsOf(workspaceId)).bookmarks).toEqual([bookmark]);
    expect(await deletionEvents(workspaceId)).toEqual([]);
  });

  it("answers 404 and deletes nothing when the workspace is being deleted", async () => {
    const { world, workspaceId, owner } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    await syncCounter(workspaceId);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspaceId}`;
    });

    const refused = await send(world, "POST", DELETE, { cookie: owner.cookie }, { bookmarkIds: [bookmark] });

    expect(refused.status).toBe(404);
    expect((await rowsOf(workspaceId)).bookmarks).toEqual([bookmark]);
  });

  it("keeps the deletion, the counter and the event one unit: when the event cannot be written the request fails and nothing is deleted", async () => {
    const { world, workspaceId, admin } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    const folder = await seedFolder(workspaceId, "Ownerless folder");
    await syncCounter(workspaceId);
    const before = await rowsOf(workspaceId);
    await database().owner`CREATE FUNCTION former_content_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the audit event cannot be written'; END $$`;
    await database().owner`CREATE TRIGGER former_content_test_refuse BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'member.former_content_deleted') EXECUTE FUNCTION former_content_test_refuse()`;
    try {
      const failed = await send(world, "POST", DELETE, { cookie: admin.cookie }, { bookmarkIds: [bookmark], folderIds: [folder] });
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      await database().owner`DROP TRIGGER former_content_test_refuse ON audit_events`;
      await database().owner`DROP FUNCTION former_content_test_refuse()`;
    }

    expect(await rowsOf(workspaceId)).toEqual(before);
    await assertBookmarkCountMatches(database());
    expect(await deletionEvents(workspaceId)).toEqual([]);
  });

  it("is idempotent: a repeated request finds nothing, answers zero counts and records no second event", async () => {
    const { world, workspaceId, admin } = await setup();
    const bookmark = await seedBookmark({ workspaceId, title: "Ownerless" });
    await syncCounter(workspaceId);
    const request = { bookmarkIds: [bookmark] };

    expect((await (await send(world, "POST", DELETE, { cookie: admin.cookie }, request)).json()) as Deleted).toEqual({ bookmarksDeleted: 1, foldersDeleted: 0 });
    expect((await (await send(world, "POST", DELETE, { cookie: admin.cookie }, request)).json()) as Deleted).toEqual({ bookmarksDeleted: 0, foldersDeleted: 0 });

    expect(await deletionEvents(workspaceId)).toHaveLength(1);
    await assertBookmarkCountMatches(database());
  });
});
