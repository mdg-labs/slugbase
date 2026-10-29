import { createUsageStore } from "@slugbase/db";
import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsageBuffer, type UsageBuffer } from "../../src/usage/buffer.ts";
import { appUrl } from "../contract/support.ts";
import { recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Reading through shares (doc 02 sections 5.5, 5.7 and 8.2, doc 04 sections 2.4 and 10.6, doc 05 section 4, doc 13 Q22, doc 10 T1 and T2), through the whole
// chain over the migrated database. The failure scenario: a member the owner shared a bookmark with, directly, through a team or through a folder, attempts every
// write and every listing of its shares by the bookmark's identifier, and each is answered 403 and changes nothing, while a member it is not shared with is
// answered 404 by the same requests (T2). Besides that: the list covers the scope it is asked for and shows a bookmark readable through two routes once; a
// recipient reads and opens the bookmark, sees its owner and how it is shared with them and nothing of the owner's tags, folders, pin or other recipients; an
// open counts on the shared bookmark; and a plan-archived bookmark is read, listed and opened by nobody.

const TEST_TIMEOUT_MS = 90_000;
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const TEAMS = "/api/v1/teams";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = {
  RATE_LIMIT_BULK_IP: "10000/hour",
  RATE_LIMIT_BULK_ACCOUNT: "10000/hour",
  RATE_LIMIT_WRITE_IP: "10000/min",
  RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
  RATE_LIMIT_READ_IP: "10000/min",
  RATE_LIMIT_READ_ACCOUNT: "10000/min",
};
const SHARING = { entitlements: GRANTED, env: RELAXED } as const;
const UNKNOWN = "0192f3a0-ffff-7000-8000-000000000001";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Bookmark {
  readonly id: string;
  readonly ownerId: string | null;
  readonly title: string;
  readonly pinned: boolean;
  readonly openCount: number;
  readonly owner: { readonly accountId: string; readonly displayName: string } | null;
  readonly sharedVia: "direct" | "team" | "folder" | null;
  readonly folders: readonly { readonly id: string }[];
  readonly tags: readonly { readonly id: string }[];
  readonly version: number;
}

interface Page {
  readonly items: readonly Bookmark[];
  readonly nextCursor: string | null;
  readonly total: number | null;
}

interface Problem {
  readonly code: string;
}

const as = (person: Person) => ({ cookie: person.cookie });

async function created(world: World, person: Person, title: string, extra: Record<string, unknown> = {}): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, as(person), { url: `https://example.com/${encodeURIComponent(title)}`, title, ...extra });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function idOf(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(201);
  return ((await settled.json()) as { id: string }).id;
}

async function teamOf(world: World, person: Person, name: string, members: readonly Person[]): Promise<string> {
  const id = await idOf(send(world, "POST", TEAMS, as(person), { name }));
  expect((await send(world, "PUT", `${TEAMS}/${id}/members`, as(person), { accountIds: members.map((member) => member.account.id) })).status).toBe(200);
  return id;
}

async function shared(world: World, person: Person, path: string, target: { accountId: string } | { teamId: string }): Promise<void> {
  const response = await send(world, "POST", `${path}/shares`, as(person), target);
  expect([200, 201]).toContain(response.status);
}

const list = async (world: World, person: Person, query = ""): Promise<Page> => {
  const response = await send(world, "GET", `${BOOKMARKS}${query}`, as(person));
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
};

const titles = (page: Page): string[] => page.items.map((item) => item.title);

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

/** Runs one statement as slugbase_system, which stands for the operations that write in ways a request may not. */
async function system(statement: string, parameters: readonly string[] = []): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx.unsafe(statement, [...parameters]);
  });
}

async function displayNameOf(accountId: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ display_name: string }[]>`SELECT display_name FROM accounts WHERE id = ${accountId}`;
  });
  return rows[0]?.display_name ?? "";
}

async function rowsOf(table: "bookmarks" | "tags" | "bookmark_tags" | "folder_bookmarks" | "bookmark_shares"): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx.unsafe<{ row: string }[]>(`SELECT t::text AS row FROM ${table} t ORDER BY 1`);
  });
  return rows.map((row) => row.row).join("\n");
}

/**
 * Workspace A: an owner; `direct`, who the bookmark is shared with; `viaTeam`, who is in a team it is shared with; `viaFolder`, who a folder it is filed in is shared
 * with; `twice`, who it is shared with directly and through a team; and `outsider`, who has no access. Workspace B holds a stranger.
 */
async function setup(world: World) {
  const [owner, direct, viaTeam, viaFolder, twice, outsider, stranger] = await Promise.all(Array.from({ length: 7 }, () => harness.person(world)));
  if (owner === undefined || direct === undefined || viaTeam === undefined || viaFolder === undefined || twice === undefined || outsider === undefined || stranger === undefined) {
    throw new Error("people were not made");
  }
  const a = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: direct, role: "member" },
    { person: viaTeam, role: "member" },
    { person: viaFolder, role: "member" },
    { person: twice, role: "member" },
    { person: outsider, role: "member" },
  ]);
  const b = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, direct, viaTeam, viaFolder, twice, outsider, stranger, a, b };
}

/** The owner's bookmark, pinned, tagged and filed in a folder, shared by every route the people of `setup` stand for. */
async function sharedEverywhere(world: World, people: Awaited<ReturnType<typeof setup>>) {
  const { owner, direct, viaTeam, viaFolder, twice } = people;
  const tag = await idOf(send(world, "POST", TAGS, as(owner), { name: "private-tag" }));
  const folder = await idOf(send(world, "POST", FOLDERS, as(owner), { name: "Private folder" }));
  const bookmark = await created(world, owner, "Shared bookmark", { pinned: true, slug: "shared", tagIds: [tag], folderIds: [folder] });
  const path = `${BOOKMARKS}/${bookmark.id}`;
  await shared(world, owner, path, { accountId: direct.account.id });
  await shared(world, owner, path, { accountId: twice.account.id });
  await shared(world, owner, path, { teamId: await teamOf(world, owner, "Readers", [viaTeam, twice]) });
  await shared(world, owner, `${FOLDERS}/${folder}`, { accountId: viaFolder.account.id });
  return { bookmark, tag, folder, path };
}

describe("the failure scenario", () => {
  it(
    "answers 403 to every write and every listing of shares by a member the bookmark is shared with, whichever route shares it, and 404 to a member it is not shared with, and changes nothing",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, viaTeam, viaFolder, twice, outsider } = people;
      const { bookmark, tag, folder, path } = await sharedEverywhere(world, people);
      const own = await created(world, owner, "Owned by the owner, shared with nobody");
      const spare = await idOf(send(world, "POST", FOLDERS, as(owner), { name: "Spare" }));
      const shareId = ((await (await send(world, "GET", `${path}/shares`, as(owner))).json()) as { items: { id: string }[] }).items[0]?.id ?? "";
      expect(shareId).not.toBe("");
      const before = [await rowsOf("bookmarks"), await rowsOf("tags"), await rowsOf("bookmark_tags"), await rowsOf("folder_bookmarks"), await rowsOf("bookmark_shares")];

      const attempts: readonly { readonly name: string; readonly method: string; readonly path: string; readonly body?: unknown; readonly headers?: Record<string, string> }[] = [
        { name: "update", method: "PATCH", path, body: { title: "Taken over" } },
        { name: "update with an If-Match", method: "PATCH", path, body: { title: "Taken over" }, headers: { "if-match": `"${String(bookmark.version)}"` } },
        { name: "pin", method: "PATCH", path, body: { pinned: false } },
        { name: "slug", method: "PATCH", path, body: { slug: "mine-now", forwarding: true } },
        { name: "tag by identifier", method: "PATCH", path, body: { tagIds: [tag] } },
        { name: "tag by name", method: "PATCH", path, body: { tagNames: ["mine"] } },
        { name: "file in a folder", method: "PATCH", path, body: { folderIds: [folder] } },
        { name: "delete", method: "DELETE", path },
        { name: "list shares", method: "GET", path: `${path}/shares` },
        { name: "share with a member", method: "POST", path: `${path}/shares`, body: { accountId: outsider.account.id } },
        { name: "share with a team", method: "POST", path: `${path}/shares`, body: { teamId: UNKNOWN } },
        { name: "revoke a share", method: "DELETE", path: `${path}/shares/${shareId}` },
        { name: "file through the folder of the owner", method: "POST", path: `${FOLDERS}/${spare}/bookmarks`, body: { bookmarkIds: [bookmark.id] } },
        { name: "unfile through the folder of the owner", method: "DELETE", path: `${FOLDERS}/${spare}/bookmarks`, body: { bookmarkIds: [bookmark.id] } },
      ];
      const bulk = [
        { action: "delete" },
        { action: "pin" },
        { action: "unpin" },
        { action: "add_to_folder", folderId: spare },
        { action: "move_to_folder", folderId: spare },
        { action: "remove_from_folder", folderId: spare },
        { action: "add_tags", tagIds: [tag] },
        { action: "remove_tags", tagIds: [tag] },
      ] as const;

      for (const recipient of [direct, viaTeam, viaFolder, twice]) {
        const answers = [];
        for (const attempt of attempts) {
          const response = await send(world, attempt.method, attempt.path, { ...as(recipient), ...attempt.headers }, attempt.body);
          answers.push({ name: attempt.name, status: response.status, code: (await problemOf(response)).code });
        }
        expect(answers).toEqual(attempts.map(({ name }) => ({ name, status: 403, code: "forbidden" })));

        const mine = await idOf(send(world, "POST", FOLDERS, as(recipient), { name: "Mine" }));
        for (const method of ["POST", "DELETE"]) {
          for (const bookmarkIds of [[bookmark.id], [bookmark.id, own.id]]) {
            const filing = await send(world, method, `${FOLDERS}/${mine}/bookmarks`, as(recipient), { bookmarkIds });
            expect([method, bookmarkIds.length, filing.status, (await problemOf(filing)).code]).toEqual([method, bookmarkIds.length, 403, "forbidden"]);
          }
        }

        for (const request of bulk) {
          const named = await send(world, "POST", `${BOOKMARKS}/bulk`, as(recipient), { ...request, ids: [own.id, bookmark.id] });
          const matched = await send(world, "POST", `${BOOKMARKS}/bulk`, as(recipient), { ...request, filter: { scope: "shared_with_me" } });
          expect([request.action, named.status, (await problemOf(named)).code]).toEqual([request.action, 403, "forbidden"]);
          expect([request.action, matched.status, (await problemOf(matched)).code]).toEqual([request.action, 403, "forbidden"]);
        }
        const preview = await send(world, "POST", `${BOOKMARKS}/bulk/preview`, as(recipient), { action: "add_tags", ids: [bookmark.id], tagIds: [tag] });
        expect([preview.status, (await problemOf(preview)).code]).toEqual([403, "forbidden"]);
      }

      const refused = [];
      for (const attempt of attempts) {
        const response = await send(world, attempt.method, attempt.path, { ...as(outsider), ...attempt.headers }, attempt.body);
        refused.push({ name: attempt.name, status: response.status, code: (await problemOf(response)).code });
      }
      expect(refused).toEqual(attempts.map(({ name }) => ({ name, status: 404, code: "not_found" })));
      for (const request of bulk) {
        const response = await send(world, "POST", `${BOOKMARKS}/bulk`, as(outsider), { ...request, ids: [bookmark.id] });
        expect(response.status).toBe(request.action.endsWith("_folder") || request.action.endsWith("_tags") ? 404 : 200);
        if (response.status === 200) {
          expect(await response.json()).toMatchObject({ requested: 1, affected: 0, skippedReasons: { not_owner: 0, not_found: 1 } });
        }
      }

      expect([await rowsOf("bookmarks"), await rowsOf("tags"), await rowsOf("bookmark_tags"), await rowsOf("folder_bookmarks"), await rowsOf("bookmark_shares")]).toEqual(before);
      const owners = (await (await send(world, "GET", path, as(owner))).json()) as Bookmark;
      expect(owners).toMatchObject({ title: "Shared bookmark", pinned: true, version: bookmark.version });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets the owner do everything the recipients are refused, so the refusal is the recipient's and not the bookmark's",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner } = people;
      const { bookmark, path } = await sharedEverywhere(world, people);

      const changed = await send(world, "PATCH", path, as(owner), { title: "Renamed by the owner" });
      const filed = await send(world, "POST", `${FOLDERS}/${await idOf(send(world, "POST", FOLDERS, as(owner), { name: "Owner's own" }))}/bookmarks`, as(owner), { bookmarkIds: [bookmark.id] });
      const bulk = await send(world, "POST", `${BOOKMARKS}/bulk`, as(owner), { action: "unpin", ids: [bookmark.id] });
      const deleted = await send(world, "DELETE", path, as(owner));

      expect([changed.status, filed.status, bulk.status, deleted.status]).toEqual([200, 200, 200, 204]);
      expect(await bulk.json()).toMatchObject({ requested: 1, affected: 1, skipped: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("reading a bookmark that is shared", () => {
  it(
    "shows it to each recipient with its owner and how it is shared with them, and with nothing of the owner's tags, folders or pin, and no list of the other recipients",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, viaTeam, viaFolder, twice, outsider } = people;
      const { bookmark, path } = await sharedEverywhere(world, people);
      expect(await (await send(world, "GET", path, as(owner))).json()).toMatchObject({ owner: null, sharedVia: null, pinned: true });
      const ownerName = await displayNameOf(owner.account.id);
      expect(ownerName).not.toBe("");

      for (const [recipient, via] of [
        [direct, "direct"],
        [viaTeam, "team"],
        [viaFolder, "folder"],
        [twice, "direct"],
      ] as const) {
        const response = await send(world, "GET", path, as(recipient));
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe(`"${String(bookmark.version)}"`);
        const body = (await response.json()) as Bookmark & Record<string, unknown>;
        expect(body).toMatchObject({ id: bookmark.id, title: "Shared bookmark", slug: "shared", ownerId: owner.account.id, sharedVia: via, pinned: false, folders: [], tags: [] });
        expect(body.owner).toEqual({ accountId: owner.account.id, displayName: ownerName });
        expect(Object.keys(body).sort()).toEqual(Object.keys(bookmark).sort());
        expect(JSON.stringify(body)).not.toContain(recipient === direct ? viaTeam.account.id : direct.account.id);
        expect(JSON.stringify(body)).not.toContain("private-tag");
        expect(JSON.stringify(body)).not.toContain("Private folder");
      }

      expect((await send(world, "GET", path, as(outsider))).status).toBe(404);
      expect((await send(world, "GET", `${BOOKMARKS}/${UNKNOWN}`, as(direct))).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names no owner for a bookmark whose owner has left the workspace, and still reads it to the members it is shared with",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { direct, outsider } = people;
      const { bookmark, path } = await sharedEverywhere(world, people);
      await system("UPDATE bookmarks SET owner_id = NULL WHERE id = $1", [bookmark.id]);

      const response = await send(world, "GET", path, as(direct));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ownerId: null, owner: null, sharedVia: "direct" });
      expect((await send(world, "GET", path, as(outsider))).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads, lists and opens a plan-archived bookmark for nobody, the people it is shared with included",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, viaFolder } = people;
      const { bookmark, path } = await sharedEverywhere(world, people);
      await system("UPDATE bookmarks SET plan_archived_at = now() WHERE id = $1", [bookmark.id]);

      for (const recipient of [direct, viaFolder]) {
        expect((await send(world, "GET", path, as(recipient))).status).toBe(404);
        expect((await send(world, "POST", `${path}/open`, as(recipient))).status).toBe(404);
        for (const scope of ["all", "shared_with_me"]) {
          expect((await list(world, recipient, `?scope=${scope}`)).items).toEqual([]);
        }
      }
      expect(titles(await list(world, owner, "?scope=shared_by_me"))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the scopes of the list", () => {
  it(
    "lists the caller's own, the shared with them, the shared by them and both of the first two, and a bookmark readable through two routes once",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, twice, outsider } = people;
      await sharedEverywhere(world, people);
      await created(world, owner, "Owner only");
      await created(world, twice, "Twice's own");

      const expected: readonly (readonly [Person, string, string[]])[] = [
        [owner, "all", ["Owner only", "Shared bookmark"]],
        [owner, "mine", ["Owner only", "Shared bookmark"]],
        [owner, "shared_with_me", []],
        [owner, "shared_by_me", ["Shared bookmark"]],
        [direct, "all", ["Shared bookmark"]],
        [direct, "mine", []],
        [direct, "shared_with_me", ["Shared bookmark"]],
        [direct, "shared_by_me", []],
        [twice, "all", ["Shared bookmark", "Twice's own"]],
        [twice, "mine", ["Twice's own"]],
        [twice, "shared_with_me", ["Shared bookmark"]],
        [twice, "shared_by_me", []],
        [outsider, "all", []],
        [outsider, "shared_with_me", []],
      ];
      for (const [person, scope, wanted] of expected) {
        const page = await list(world, person, `?scope=${scope}&sort=title_asc`);
        expect([scope, titles(page), page.total]).toEqual([scope, wanted, wanted.length]);
      }
      expect(titles(await list(world, direct, "?sort=title_asc"))).toEqual(["Shared bookmark"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pages through the own and the shared bookmarks together in the order asked for, each once, and refuses a cursor under another scope",
    async () => {
      const world = harness.serve(SHARING);
      const { owner, direct } = await setup(world);
      for (const title of ["Alpha", "Charlie", "Echo"]) {
        await created(world, direct, title);
      }
      for (const title of ["Bravo", "Delta", "Foxtrot"]) {
        const bookmark = await created(world, owner, title);
        await shared(world, owner, `${BOOKMARKS}/${bookmark.id}`, { accountId: direct.account.id });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page = await list(world, direct, `?scope=all&sort=title_asc&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
        expect(page.total).toBe(6);
        seen.push(...titles(page));
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]);
      const first = await list(world, direct, "?scope=all&sort=title_asc&limit=2");
      const wrongScope = await send(world, "GET", `${BOOKMARKS}?scope=shared_with_me&sort=title_asc&limit=2&cursor=${first.nextCursor ?? ""}`, as(direct));
      expect(wrongScope.status).toBe(400);
      const newest = await list(world, direct, "?scope=shared_with_me&sort=recent&limit=2");
      expect(titles(newest)).toEqual(["Foxtrot", "Delta"]);
      expect(newest.nextCursor).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the filters that name the caller's own things to the caller's own bookmarks, and means by pinned what the caller pinned",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct } = people;
      const { bookmark, folder, tag } = await sharedEverywhere(world, people);

      const answers = {
        pinnedByOwner: titles(await list(world, owner, "?scope=all&pinned=true")),
        pinnedByRecipient: titles(await list(world, direct, "?scope=all&pinned=true")),
        unpinnedByRecipient: titles(await list(world, direct, "?scope=all&pinned=false")),
        sharedInOwnersFolder: titles(await list(world, direct, `?scope=all&folderId=${folder}`)),
        sharedWithOwnersTag: titles(await list(world, direct, `?scope=all&tag=${tag}`)),
        duplicateWarning: titles(await list(world, direct, `?url=${encodeURIComponent(`https://example.com/${encodeURIComponent("Shared bookmark")}`)}`)),
        owner: titles(await list(world, owner, `?url=${encodeURIComponent(`https://example.com/${encodeURIComponent("Shared bookmark")}`)}`)),
        bySlug: titles(await list(world, direct, "?scope=shared_with_me&hasSlug=true&forwarding=true")),
        selectAll: ((await (await send(world, "GET", `${BOOKMARKS}/ids?scope=shared_with_me`, as(direct))).json()) as { ids: string[] }).ids,
      };

      expect(answers).toEqual({
        pinnedByOwner: ["Shared bookmark"],
        pinnedByRecipient: [],
        unpinnedByRecipient: ["Shared bookmark"],
        sharedInOwnersFolder: [],
        sharedWithOwnersTag: [],
        duplicateWarning: [],
        owner: ["Shared bookmark"],
        bySlug: ["Shared bookmark"],
        selectAll: [bookmark.id],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "narrows the own and the shared bookmarks together by a text query, and answers the caller's own matches",
    async () => {
      const world = harness.serve(SHARING);
      const { owner, direct } = await setup(world);
      await created(world, direct, "Zebra notes");
      const bookmark = await created(world, owner, "Zebra manual");
      await shared(world, owner, `${BOOKMARKS}/${bookmark.id}`, { accountId: direct.account.id });

      const page = await list(world, direct, "?scope=all&q=zebra");

      expect(titles(page)).toContain("Zebra notes");
      expect(page.total).toBe(page.items.length);
      expect((await list(world, direct, "?scope=mine&q=zebra")).items.map((item) => item.title)).toEqual(["Zebra notes"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a scope outside the four with 422",
    async () => {
      const world = harness.serve(SHARING);
      const { direct } = await setup(world);

      expect((await send(world, "GET", `${BOOKMARKS}?scope=shared`, as(direct))).status).toBe(422);
      expect((await send(world, "GET", `${BOOKMARKS}/ids?scope=everything`, as(direct))).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("opening a bookmark that is shared", () => {
  function observedBuffer(): { readonly usage: UsageBuffer; readonly close: () => Promise<void> } {
    const store = createUsageStore({ url: appUrl(database()), poolSize: 2 });
    return { usage: createUsageBuffer({ store, logger: recordingLogger() }), close: () => store.close() };
  }

  it(
    "answers the destination to each recipient and counts the open on the shared bookmark, so the owner sees the total, and counts nothing for a member it is not shared with",
    async () => {
      const { usage, close } = observedBuffer();
      const world = harness.serve({ ...SHARING, usage });
      const people = await setup(world);
      const { owner, direct, viaTeam, viaFolder, outsider } = people;
      const { bookmark, path } = await sharedEverywhere(world, people);

      for (const recipient of [direct, viaTeam, viaFolder]) {
        const opened = await send(world, "POST", `${path}/open`, as(recipient));
        expect(opened.status).toBe(200);
        expect(await opened.json()).toEqual({ url: "https://example.com/Shared%20bookmark" });
      }
      expect((await send(world, "POST", `${path}/open`, as(outsider))).status).toBe(404);
      await send(world, "POST", `${path}/open`, as(owner));
      await usage.flush();

      const total = (await (await send(world, "GET", path, as(owner))).json()) as Bookmark;
      expect(total.openCount).toBe(4);
      expect(total.version).toBe(bookmark.version);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );
});
