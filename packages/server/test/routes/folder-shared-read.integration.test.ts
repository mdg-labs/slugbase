import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Folders shared with a member (doc 02 sections 7.1 and 8.2, doc 04 section 10.7, doc 13 Q22, doc 10 T1 and T2), through the whole chain over the migrated
// database. The failure scenario: a member the owner shared a folder with, directly or through a team, renames it, restyles it, deletes it or files into it by
// its identifier, and each is answered 403 and changes nothing, while a member it is not shared with is answered 404 by the same requests (T2). Besides that:
// the scopes of the list (`mine`, `shared`, `all`) with the owner of a folder shared with the caller and the share summary of the caller's own; the read of
// the folder with its ETag; the signed cursor that is valid for the scope it was issued for only; and the bookmarks filed in the folder, listed by the folder filter.

const TEST_TIMEOUT_MS = 90_000;
const FOLDERS = "/api/v1/folders";
const BOOKMARKS = "/api/v1/bookmarks";
const TEAMS = "/api/v1/teams";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = {
  RATE_LIMIT_WRITE_IP: "10000/min",
  RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
  RATE_LIMIT_READ_IP: "10000/min",
  RATE_LIMIT_READ_ACCOUNT: "10000/min",
};
const SHARING = { entitlements: GRANTED, env: RELAXED } as const;

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
});

interface Folder {
  readonly id: string;
  readonly ownerId: string | null;
  readonly owner: { readonly accountId: string; readonly displayName: string } | null;
  readonly shareSummary: { readonly memberCount: number; readonly teams: readonly { readonly id: string; readonly name: string }[] } | null;
  readonly name: string;
  readonly bookmarkCount: number;
  readonly version: number;
}

interface FolderList {
  readonly items: readonly Folder[];
  readonly nextCursor: string | null;
  readonly total: number | null;
}

interface BookmarkPage {
  readonly items: readonly { readonly title: string; readonly sharedVia: string | null; readonly folders: readonly unknown[] }[];
  readonly total: number | null;
}

const as = (person: Person) => ({ cookie: person.cookie });

async function idOf(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(201);
  return ((await settled.json()) as { id: string }).id;
}

async function problemCode(response: Response): Promise<string> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return ((await response.json()) as { code: string }).code;
}

const folders = async (world: World, person: Person, query = ""): Promise<FolderList> => {
  const response = await send(world, "GET", `${FOLDERS}${query}`, as(person));
  expect(response.status).toBe(200);
  return (await response.json()) as FolderList;
};

const names = (page: FolderList): string[] => page.items.map((item) => item.name);

async function stored(table: "folders" | "folder_bookmarks" | "folder_shares"): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx.unsafe<{ row: string }[]>(`SELECT t::text AS row FROM ${table} t ORDER BY 1`);
  });
  return rows.map((row) => row.row).join("\n");
}

/** Workspace A: an owner; `direct`, who a folder is shared with; `viaTeam`, who is in a team it is shared with; and `outsider`, who has no access. Workspace B holds a stranger. */
async function setup(world: World) {
  const [owner, direct, viaTeam, outsider, stranger] = await Promise.all(Array.from({ length: 5 }, () => harness.person(world)));
  if (owner === undefined || direct === undefined || viaTeam === undefined || outsider === undefined || stranger === undefined) {
    throw new Error("people were not made");
  }
  const a = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: direct, role: "member" },
    { person: viaTeam, role: "member" },
    { person: outsider, role: "member" },
  ]);
  const b = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, direct, viaTeam, outsider, stranger, a, b };
}

/** The owner's folder "Reading", with one bookmark filed in it, shared with `direct` and, through the team "Readers", with `viaTeam`; and a private folder of the owner's. */
async function sharedFolder(world: World, people: Awaited<ReturnType<typeof setup>>) {
  const { owner, direct, viaTeam } = people;
  const folder = await idOf(send(world, "POST", FOLDERS, as(owner), { name: "Reading" }));
  const privateFolder = await idOf(send(world, "POST", FOLDERS, as(owner), { name: "Private" }));
  const bookmark = await idOf(send(world, "POST", BOOKMARKS, as(owner), { url: "https://example.com/filed", title: "Filed", folderIds: [folder] }));
  const team = await idOf(send(world, "POST", TEAMS, as(owner), { name: "Readers" }));
  expect((await send(world, "PUT", `${TEAMS}/${team}/members`, as(owner), { accountIds: [viaTeam.account.id] })).status).toBe(200);
  expect([200, 201]).toContain((await send(world, "POST", `${FOLDERS}/${folder}/shares`, as(owner), { accountId: direct.account.id })).status);
  expect([200, 201]).toContain((await send(world, "POST", `${FOLDERS}/${folder}/shares`, as(owner), { teamId: team })).status);
  return { folder, privateFolder, bookmark, team };
}

describe("the failure scenario", () => {
  it(
    "answers 403 to a rename, a restyle, a deletion and a filing into a folder by a member it is shared with, whichever route shares it, and 404 to a member it is not shared with, and changes nothing",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, viaTeam, outsider } = people;
      const { folder, bookmark } = await sharedFolder(world, people);
      const before = [await stored("folders"), await stored("folder_bookmarks"), await stored("folder_shares")];

      const attempts: readonly { readonly name: string; readonly method: string; readonly body?: unknown; readonly headers?: Record<string, string>; readonly suffix?: string }[] = [
        { name: "rename", method: "PATCH", body: { name: "Taken over" } },
        { name: "restyle", method: "PATCH", body: { icon: "star", color: 5 } },
        { name: "rename with an If-Match", method: "PATCH", body: { name: "Taken over" }, headers: { "if-match": '"1"' } },
        { name: "delete", method: "DELETE" },
        { name: "file the owner's bookmark", method: "POST", suffix: "/bookmarks", body: { bookmarkIds: [bookmark] } },
        { name: "unfile the owner's bookmark", method: "DELETE", suffix: "/bookmarks", body: { bookmarkIds: [bookmark] } },
      ];
      for (const recipient of [direct, viaTeam]) {
        const own = await idOf(send(world, "POST", BOOKMARKS, as(recipient), { url: "https://example.com/theirs", title: "Theirs" }));
        const all = [...attempts, { name: "file their own bookmark", method: "POST", suffix: "/bookmarks", body: { bookmarkIds: [own] } }, { name: "unfile their own bookmark", method: "DELETE", suffix: "/bookmarks", body: { bookmarkIds: [own] } }];
        const answers = [];
        for (const attempt of all) {
          const response = await send(world, attempt.method, `${FOLDERS}/${folder}${attempt.suffix ?? ""}`, { ...as(recipient), ...attempt.headers }, attempt.body);
          answers.push({ name: attempt.name, status: response.status, code: await problemCode(response) });
        }
        expect(answers).toEqual(all.map(({ name }) => ({ name, status: 403, code: "forbidden" })));
      }

      const refused = [];
      for (const attempt of attempts) {
        const response = await send(world, attempt.method, `${FOLDERS}/${folder}${attempt.suffix ?? ""}`, { ...as(outsider), ...attempt.headers }, attempt.body);
        refused.push({ name: attempt.name, status: response.status, code: await problemCode(response) });
      }
      expect(refused).toEqual(attempts.map(({ name }) => ({ name, status: 404, code: "not_found" })));

      expect([await stored("folders"), await stored("folder_bookmarks"), await stored("folder_shares")]).toEqual(before);
      // The refusal is the recipient's and not the folder's: the owner changes, files into and deletes the same folder.
      expect((await send(world, "PATCH", `${FOLDERS}/${folder}`, as(owner), { name: "Reading list", color: 4 })).status).toBe(200);
      expect((await send(world, "DELETE", `${FOLDERS}/${folder}`, as(owner))).status).toBe(204);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("listFolders and getFolder for a recipient", () => {
  it(
    "lists a shared folder in the scopes shared and all with its owner and no share summary, never in mine, and lists nothing for a member it is not shared with",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, viaTeam, outsider, stranger } = people;
      const { folder } = await sharedFolder(world, people);
      const theirs = await idOf(send(world, "POST", FOLDERS, as(direct), { name: "Direct's own" }));
      const ownerName = ((await (await send(world, "GET", `${FOLDERS}/${folder}`, as(owner))).json()) as Folder).name;
      expect(ownerName).toBe("Reading");

      for (const recipient of [direct, viaTeam]) {
        const shared = await folders(world, recipient, "?scope=shared");
        expect(shared.items).toHaveLength(1);
        expect(shared.items[0]).toMatchObject({ id: folder, name: "Reading", ownerId: owner.account.id, owner: { accountId: owner.account.id }, shareSummary: null, bookmarkCount: 1 });
        expect(typeof shared.items[0]?.owner?.displayName).toBe("string");
        expect(shared.total).toBe(1);
        expect(names(await folders(world, recipient, "?scope=mine"))).toEqual(recipient === direct ? ["Direct's own"] : []);
        expect(names(await folders(world, recipient))).toEqual(recipient === direct ? ["Direct's own", "Reading"] : ["Reading"]);
        expect(names(await folders(world, recipient, "?scope=all&q=read"))).toEqual(["Reading"]);
      }
      expect((await folders(world, direct, "?scope=mine")).items[0]).toMatchObject({ id: theirs, owner: null, shareSummary: { memberCount: 0, teams: [] } });
      for (const other of [outsider, stranger]) {
        for (const scope of ["shared", "all", "mine"]) {
          expect(await folders(world, other, `?scope=${scope}`)).toEqual({ items: [], nextCursor: null, total: 0 });
        }
      }
      // The owner lists the folder as theirs, with how it is shared, and has nothing shared with them.
      const own = await folders(world, owner, "?scope=mine");
      expect(names(own)).toEqual(["Private", "Reading"]);
      expect(own.items.map((item) => [item.name, item.owner, item.shareSummary])).toEqual([
        ["Private", null, { memberCount: 0, teams: [] }],
        ["Reading", null, { memberCount: 1, teams: [{ id: expect.any(String) as string, name: "Readers" }] }],
      ]);
      expect((await folders(world, owner, "?scope=shared")).items).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads a shared folder by its identifier with its version as the ETag, and answers 404 for a member it is not shared with and for the owner's private folder",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, outsider } = people;
      const { folder, privateFolder } = await sharedFolder(world, people);

      const read = await send(world, "GET", `${FOLDERS}/${folder}`, as(direct));
      expect(read.status).toBe(200);
      expect(read.headers.get("etag")).toBe('"1"');
      expect(await read.json()).toMatchObject({ id: folder, owner: { accountId: owner.account.id }, shareSummary: null, bookmarkCount: 1 });
      const refused = [await send(world, "GET", `${FOLDERS}/${folder}`, as(outsider)), await send(world, "GET", `${FOLDERS}/${privateFolder}`, as(direct))];
      expect(refused.map((response) => response.status)).toEqual([404, 404]);
      expect(await Promise.all(refused.map(problemCode))).toEqual(["not_found", "not_found"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends a recipient's access with the share: the folder is no longer listed or read, and a write by the former recipient is 404",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct } = people;
      const { folder } = await sharedFolder(world, people);
      const shares = (await (await send(world, "GET", `${FOLDERS}/${folder}/shares`, as(owner))).json()) as { items: { id: string; accountId: string | null }[] };
      const share = shares.items.find((item) => item.accountId === direct.account.id);
      expect(share).toBeDefined();
      expect((await send(world, "GET", `${FOLDERS}/${folder}`, as(direct))).status).toBe(200);

      expect((await send(world, "DELETE", `${FOLDERS}/${folder}/shares/${share?.id ?? ""}`, as(owner))).status).toBe(204);

      expect((await send(world, "GET", `${FOLDERS}/${folder}`, as(direct))).status).toBe(404);
      expect((await send(world, "PATCH", `${FOLDERS}/${folder}`, as(direct), { name: "Mine" })).status).toBe(404);
      expect((await send(world, "DELETE", `${FOLDERS}/${folder}`, as(direct))).status).toBe(404);
      expect((await folders(world, direct, "?scope=shared")).items).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pages the shared scope by a signed cursor that opens for that scope alone",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct } = people;
      for (const name of ["Alpha", "Bravo", "Charlie"]) {
        const id = await idOf(send(world, "POST", FOLDERS, as(owner), { name }));
        expect([200, 201]).toContain((await send(world, "POST", `${FOLDERS}/${id}/shares`, as(owner), { accountId: direct.account.id })).status);
      }

      const first = await folders(world, direct, "?scope=shared&limit=2");
      const cursor = first.nextCursor ?? "";
      const second = await folders(world, direct, `?scope=shared&limit=2&cursor=${encodeURIComponent(cursor)}`);

      expect([names(first), names(second), second.nextCursor]).toEqual([["Alpha", "Bravo"], ["Charlie"], null]);
      for (const scope of ["all", "mine"]) {
        const response = await send(world, "GET", `${FOLDERS}?scope=${scope}&limit=2&cursor=${encodeURIComponent(cursor)}`, as(direct));
        expect([response.status, await problemCode(response)]).toEqual([400, "bad_request"]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the bookmarks of a shared folder", () => {
  it(
    "are listed by the folder filter for the recipients in the scopes all and shared_with_me, read-only, and for nobody it is not shared with",
    async () => {
      const world = harness.serve(SHARING);
      const people = await setup(world);
      const { owner, direct, viaTeam, outsider, stranger } = people;
      const { folder, privateFolder } = await sharedFolder(world, people);
      await idOf(send(world, "POST", BOOKMARKS, as(owner), { url: "https://example.com/private", title: "Private one", folderIds: [privateFolder] }));

      const pageOf = async (person: Person, query: string): Promise<BookmarkPage> => {
        const response = await send(world, "GET", `${BOOKMARKS}${query}`, as(person));
        expect(response.status).toBe(200);
        return (await response.json()) as BookmarkPage;
      };
      for (const recipient of [direct, viaTeam]) {
        for (const query of [`?folderId=${folder}`, `?scope=all&folderId=${folder}`, `?scope=shared_with_me&folderId=${folder}`]) {
          const page = await pageOf(recipient, query);
          expect(page.items.map((item) => [item.title, item.sharedVia, item.folders])).toEqual([["Filed", "folder", []]]);
          expect(page.total).toBe(1);
        }
        expect((await pageOf(recipient, `?scope=mine&folderId=${folder}`)).items).toEqual([]);
        expect((await pageOf(recipient, `?scope=all&folderId=${privateFolder}`)).items).toEqual([]);
      }
      for (const other of [outsider, stranger]) {
        expect(await pageOf(other, `?scope=all&folderId=${folder}`)).toMatchObject({ items: [], total: 0 });
      }
      expect((await pageOf(owner, `?folderId=${folder}`)).items.map((item) => item.title)).toEqual(["Filed"]);
    },
    TEST_TIMEOUT_MS,
  );
});
