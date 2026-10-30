import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/bookmarks/bulk with the folder and tag actions, POST /api/v1/bookmarks/bulk/preview, and the folderId and tag filters of
// GET /api/v1/bookmarks/ids and of the bulk filter (doc 04 sections 6.2 and 10.6, doc 02 sections 5.7 and 5.8, doc 10 T1 and T2), through the whole
// chain over the migrated database. The failure scenario: a member who bulk-tags ids that include another member's bookmarks tags their own with their
// own tag, skips the others as not found, and leaves the other member's bookmarks without a tag; and the ones around it: a folder or a tag that is
// another member's refused with nothing written, a filing that moves a version, a selection under a folder or tag filter that is not exactly the
// filtered bookmarks, and a preview that writes.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const BULK = `${BOOKMARKS}/bulk`;
const PREVIEW = `${BULK}/preview`;
const IDS = `${BOOKMARKS}/ids`;
const UNKNOWN_ID = "0192f3a0-9999-7000-8000-00000000dead";

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
  readonly errors?: readonly { readonly path: string; readonly code: string }[];
}

interface Result {
  readonly requested: number;
  readonly affected: number;
  readonly skipped: number;
  readonly skippedReasons: { readonly not_owner: number; readonly not_found: number };
}

interface Preview extends Result {
  readonly tags: readonly { readonly id: string; readonly name: string; readonly bookmarkCount: number; readonly added: number }[];
  readonly audience: null;
}

interface Bookmark {
  readonly id: string;
  readonly version: number;
  readonly folders: readonly { readonly id: string }[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
}

interface Listed {
  readonly ids: readonly string[];
  readonly truncated: boolean;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const relaxed = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour" };

const bulk = (world: World, as: Person, body: unknown) => send(world, "POST", BULK, { cookie: as.cookie }, body);
const preview = (world: World, as: Person, body: unknown) => send(world, "POST", PREVIEW, { cookie: as.cookie }, body);

async function done(response: Response): Promise<Result> {
  expect(response.status).toBe(200);
  return (await response.json()) as Result;
}

async function createdBookmark(world: World, as: Person, title: string): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function createdFolder(world: World, as: Person, name: string): Promise<string> {
  const response = await send(world, "POST", "/api/v1/folders", { cookie: as.cookie }, { name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function createdTag(world: World, as: Person, name: string): Promise<string> {
  const response = await send(world, "POST", "/api/v1/tags", { cookie: as.cookie }, { name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const readBookmark = async (world: World, as: Person, id: string): Promise<Bookmark> => (await (await send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie })).json()) as Bookmark;

async function idsOf(world: World, as: Person, query: string): Promise<Listed> {
  const response = await send(world, "GET", `${IDS}?${query}`, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

async function listedIds(world: World, as: Person, query: string): Promise<string[]> {
  const response = await send(world, "GET", `${BOOKMARKS}?${query}&limit=100`, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
}

async function storedLinks(): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ link: string }[]>`
      SELECT 'f:' || bookmark_id || '/' || folder_id AS link FROM folder_bookmarks
      UNION ALL SELECT 't:' || bookmark_id || '/' || tag_id FROM bookmark_tags ORDER BY 1`;
  });
  return rows.map((row) => row.link).join("\n");
}

async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  return { owner, member, shared };
}

describe("the failure scenario: a bulk add_tags over ids that include another member's bookmarks", () => {
  it(
    "tags the caller's own with the caller's tag, skips the others as not found, and leaves the other member's bookmarks without a tag",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, member } = await setup(world);
      const own = [await createdBookmark(world, owner, "own one"), await createdBookmark(world, owner, "own two")];
      const theirs = [await createdBookmark(world, member, "their one"), await createdBookmark(world, member, "their two")];
      const tag = await createdTag(world, owner, "mine");
      const theirsBefore = await Promise.all(theirs.map((bookmark) => readBookmark(world, member, bookmark.id)));

      const result = await done(await bulk(world, owner, { action: "add_tags", ids: [...own, ...theirs, { id: UNKNOWN_ID }].map((bookmark) => bookmark.id), tagIds: [tag] }));

      expect(result).toEqual({ requested: 5, affected: 2, skipped: 3, skippedReasons: { not_owner: 0, not_found: 3 } });
      for (const bookmark of own) {
        expect((await readBookmark(world, owner, bookmark.id)).tags).toEqual([{ id: tag, name: "mine" }]);
      }
      expect(await Promise.all(theirs.map((bookmark) => readBookmark(world, member, bookmark.id)))).toEqual(theirsBefore);
      expect(theirsBefore.every((bookmark) => bookmark.tags.length === 0)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("bulk tagging", () => {
  it("puts tags on and takes them off, without moving a version, and counts a bookmark that was in the wanted state as affected", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);
    const [first, second] = [await createdBookmark(world, owner, "first"), await createdBookmark(world, owner, "second")];
    const [one, two] = [await createdTag(world, owner, "one"), await createdTag(world, owner, "two")];
    await done(await bulk(world, owner, { action: "add_tags", ids: [first.id], tagIds: [one] }));

    const added = await done(await bulk(world, owner, { action: "add_tags", ids: [first.id, second.id], tagIds: [one, two] }));
    expect(added).toEqual({ requested: 2, affected: 2, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } });
    expect((await readBookmark(world, owner, first.id)).tags.map((tag) => tag.name)).toEqual(["one", "two"]);
    expect((await readBookmark(world, owner, second.id)).tags.map((tag) => tag.name)).toEqual(["one", "two"]);

    const removed = await done(await bulk(world, owner, { action: "remove_tags", ids: [first.id, second.id], tagIds: [one] }));
    expect(removed).toMatchObject({ affected: 2 });
    expect((await readBookmark(world, owner, first.id)).tags.map((tag) => tag.name)).toEqual(["two"]);
    expect((await readBookmark(world, owner, first.id)).version).toBe(first.version);
    expect((await readBookmark(world, owner, second.id)).version).toBe(second.version);
  });

  it("refuses a tag that is another member's or unknown with 404 and writes nothing", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member } = await setup(world);
    const own = await createdBookmark(world, owner, "own");
    const [mine, theirs] = [await createdTag(world, owner, "mine"), await createdTag(world, member, "theirs")];
    const before = await storedLinks();

    for (const action of ["add_tags", "remove_tags"]) {
      for (const wrong of [theirs, UNKNOWN_ID]) {
        const refused = await bulk(world, owner, { action, ids: [own.id], tagIds: [mine, wrong] });
        expect(refused.status).toBe(404);
        expect((await problemOf(refused)).code).toBe("not_found");
      }
    }
    expect(await storedLinks()).toBe(before);
  });

  it("acts on the bookmarks a filter with a folder and a tag matches, and on no other", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const [marked, extra] = [await createdTag(world, owner, "marked"), await createdTag(world, owner, "extra")];
    const bookmarks = await Promise.all(["a", "b", "c", "d"].map((title) => createdBookmark(world, owner, title)));
    const [a, b, c, d] = bookmarks.map((bookmark) => bookmark.id);
    await send(world, "POST", `/api/v1/folders/${folder}/bookmarks`, { cookie: owner.cookie }, { bookmarkIds: [a, b, c] });
    await done(await bulk(world, owner, { action: "add_tags", ids: [b, c, d], tagIds: [marked] }));

    const result = await done(await bulk(world, owner, { action: "add_tags", filter: { folderId: folder, tag: [marked] }, tagIds: [extra] }));

    expect(result).toMatchObject({ requested: 2, affected: 2 });
    const tagged = async (id: string | undefined) => (await readBookmark(world, owner, id ?? "")).tags.map((tag) => tag.name);
    expect(await tagged(a)).toEqual([]);
    expect(await tagged(b)).toEqual(["extra", "marked"]);
    expect(await tagged(c)).toEqual(["extra", "marked"]);
    expect(await tagged(d)).toEqual(["marked"]);
  });
});

describe("bulk filing", () => {
  it("adds to, moves to and removes from a folder, leaving versions as they were", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);
    const [first, second] = [await createdBookmark(world, owner, "first"), await createdBookmark(world, owner, "second")];
    const [target, other] = [await createdFolder(world, owner, "Target"), await createdFolder(world, owner, "Other")];
    await done(await bulk(world, owner, { action: "add_to_folder", ids: [first.id], folderId: other }));

    expect(await done(await bulk(world, owner, { action: "add_to_folder", ids: [first.id, second.id], folderId: target }))).toMatchObject({ requested: 2, affected: 2, skipped: 0 });
    expect((await readBookmark(world, owner, first.id)).folders.map((folder) => folder.id).toSorted()).toEqual([target, other].toSorted());

    expect(await done(await bulk(world, owner, { action: "move_to_folder", ids: [first.id, second.id], folderId: target }))).toMatchObject({ affected: 2 });
    expect((await readBookmark(world, owner, first.id)).folders.map((folder) => folder.id)).toEqual([target]);
    expect((await readBookmark(world, owner, second.id)).folders.map((folder) => folder.id)).toEqual([target]);

    expect(await done(await bulk(world, owner, { action: "remove_from_folder", ids: [first.id, second.id], folderId: target }))).toMatchObject({ affected: 2 });
    expect((await readBookmark(world, owner, first.id)).folders).toEqual([]);
    expect((await readBookmark(world, owner, first.id)).version).toBe(first.version);
  });

  it("files the caller's own bookmarks only, and refuses a folder that is another member's or unknown with 404, writing nothing", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member } = await setup(world);
    const own = await createdBookmark(world, owner, "own");
    const theirs = await createdBookmark(world, member, "theirs");
    const [mine, ofMember] = [await createdFolder(world, owner, "Mine"), await createdFolder(world, member, "Theirs")];

    expect(await done(await bulk(world, owner, { action: "move_to_folder", ids: [own.id, theirs.id], folderId: mine }))).toEqual({
      requested: 2,
      affected: 1,
      skipped: 1,
      skippedReasons: { not_owner: 0, not_found: 1 },
    });
    expect((await readBookmark(world, member, theirs.id)).folders).toEqual([]);
    const before = await storedLinks();

    for (const action of ["add_to_folder", "move_to_folder", "remove_from_folder"]) {
      for (const wrong of [ofMember, UNKNOWN_ID]) {
        const refused = await bulk(world, owner, { action, ids: [own.id], folderId: wrong });
        expect(refused.status).toBe(404);
        expect((await problemOf(refused)).code).toBe("not_found");
      }
    }
    expect(await storedLinks()).toBe(before);
  });
});

describe("the body of a bulk request", () => {
  it.each([
    ["a folder action without folderId", { action: "add_to_folder" }, "folderId"],
    ["a tag action without tagIds", { action: "add_tags" }, "tagIds"],
    ["a tag action with no tag", { action: "remove_tags", tagIds: [] }, "tagIds"],
    ["a tag action that also names a folder", { action: "add_tags", tagIds: [UNKNOWN_ID], folderId: UNKNOWN_ID }, "folderId"],
    ["a folder action that also names tags", { action: "move_to_folder", folderId: UNKNOWN_ID, tagIds: [UNKNOWN_ID] }, "tagIds"],
    ["a pin that names a folder", { action: "pin", folderId: UNKNOWN_ID }, "folderId"],
    ["a delete that names tags", { action: "delete", tagIds: [UNKNOWN_ID] }, "tagIds"],
  ] as const)("refuses %s with 422 and writes nothing", async (_name, extra, path) => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);
    const own = await createdBookmark(world, owner, "own");
    const before = await storedLinks();

    const refused = await bulk(world, owner, { ids: [own.id], ...extra });

    expect(refused.status).toBe(422);
    const problem = await problemOf(refused);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors?.map((error) => error.path)).toContain(path);
    expect(await storedLinks()).toBe(before);
    expect((await send(world, "GET", `${BOOKMARKS}/${own.id}`, { cookie: owner.cookie })).status).toBe(200);
  });

  it("refuses more than 100 tags", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);
    const own = await createdBookmark(world, owner, "own");

    const refused = await bulk(world, owner, { action: "add_tags", ids: [own.id], tagIds: Array.from({ length: 101 }, () => UNKNOWN_ID) });

    expect(refused.status).toBe(422);
  });

  it("answers 403 token_scope to a read-only token on a filing and 200 to a read-write one", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await createdBookmark(world, owner, "own");
    const folder = await createdFolder(world, owner, "Mine");
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    const refused = await send(world, "POST", BULK, bearer(readOnly), { action: "add_to_folder", ids: [own.id], folderId: folder });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("token_scope");
    expect(await done(await send(world, "POST", BULK, bearer(readWrite), { action: "add_to_folder", ids: [own.id], folderId: folder }))).toMatchObject({ affected: 1 });
  });
});

describe("select all under a folder or tag filter", () => {
  it("returns exactly the bookmarks the list shows for the same folderId and tag, and nothing of another member's", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const [one, two] = [await createdTag(world, owner, "one"), await createdTag(world, owner, "two")];
    const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((title) => createdBookmark(world, owner, title)));
    const theirs = await createdBookmark(world, member, "theirs");
    await send(world, "POST", `/api/v1/folders/${folder}/bookmarks`, { cookie: owner.cookie }, { bookmarkIds: [a?.id, b?.id, c?.id] });
    await done(await bulk(world, owner, { action: "add_tags", ids: [b?.id, c?.id, d?.id], tagIds: [one] }));
    await done(await bulk(world, owner, { action: "add_tags", ids: [c?.id, d?.id], tagIds: [two] }));

    for (const query of [`folderId=${folder}`, `tag=${one}`, `folderId=${folder}&tag=${one}`, `tag=${one}&tag=${two}`, `folderId=${folder}&tag=${one}&tag=${two}`]) {
      const selected = await idsOf(world, owner, query);
      expect(selected.ids.toSorted(), query).toEqual((await listedIds(world, owner, query)).toSorted());
      expect(selected.truncated).toBe(false);
      expect(selected.ids).not.toContain(theirs.id);
    }
    expect((await idsOf(world, owner, `folderId=${folder}&tag=${one}&tag=${two}`)).ids).toEqual([c?.id]);
    expect((await idsOf(world, owner, `tag=${UNKNOWN_ID}`)).ids).toEqual([]);
    expect((await idsOf(world, member, `folderId=${folder}`)).ids).toEqual([]);
  });

  it("refuses a malformed folderId and more than ten tags with 422", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);

    expect((await send(world, "GET", `${IDS}?folderId=nope`, { cookie: owner.cookie })).status).toBe(422);
    expect((await send(world, "GET", `${IDS}?${Array.from({ length: 11 }, () => `tag=${UNKNOWN_ID}`).join("&")}`, { cookie: owner.cookie })).status).toBe(422);
  });
});

describe("the preview of adding tags", () => {
  it(
    "answers the resulting tag set with the counts of the bulk request, writes nothing, and counts another member's bookmarks as not found",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, member } = await setup(world);
      const [first, second] = [await createdBookmark(world, owner, "first"), await createdBookmark(world, owner, "second")];
      const theirs = await createdBookmark(world, member, "theirs");
      const [beta, alpha] = [await createdTag(world, owner, "beta"), await createdTag(world, owner, "Alpha")];
      await done(await bulk(world, owner, { action: "add_tags", ids: [first.id], tagIds: [beta] }));
      const before = await storedLinks();

      const response = await preview(world, owner, { action: "add_tags", ids: [first.id, second.id, theirs.id], tagIds: [alpha, beta] });

      expect(response.status).toBe(200);
      expect((await response.json()) as Preview).toEqual({
        requested: 3,
        affected: 2,
        skipped: 1,
        skippedReasons: { not_owner: 0, not_found: 1 },
        tags: [
          { id: alpha, name: "Alpha", bookmarkCount: 2, added: 2 },
          { id: beta, name: "beta", bookmarkCount: 2, added: 1 },
        ],
        audience: null,
      });
      expect(await storedLinks()).toBe(before);
      const applied = await done(await bulk(world, owner, { action: "add_tags", ids: [first.id, second.id, theirs.id], tagIds: [alpha, beta] }));
      expect(applied).toMatchObject({ requested: 3, affected: 2, skipped: 1 });
    },
    TEST_TIMEOUT_MS,
  );

  it("resolves a filter like the bulk request and refuses a tag that is another member's or unknown with 404", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member } = await setup(world);
    const folder = await createdFolder(world, owner, "Reading");
    const [a, b] = await Promise.all([createdBookmark(world, owner, "a"), createdBookmark(world, owner, "b")]);
    await send(world, "POST", `/api/v1/folders/${folder}/bookmarks`, { cookie: owner.cookie }, { bookmarkIds: [a.id] });
    const [mine, theirs] = [await createdTag(world, owner, "mine"), await createdTag(world, member, "theirs")];

    const byFilter = (await (await preview(world, owner, { action: "add_tags", filter: { folderId: folder }, tagIds: [mine] })).json()) as Preview;
    expect(byFilter).toMatchObject({ requested: 1, affected: 1, tags: [{ id: mine, bookmarkCount: 1, added: 1 }] });
    for (const wrong of [theirs, UNKNOWN_ID]) {
      const refused = await preview(world, owner, { action: "add_tags", ids: [a.id, b.id], tagIds: [mine, wrong] });
      expect(refused.status).toBe(404);
    }
  });

  it("refuses any action but add_tags, a body naming both ids and filter, and no tag, with 422", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);

    for (const body of [
      { action: "remove_tags", ids: [UNKNOWN_ID], tagIds: [UNKNOWN_ID] },
      { action: "add_tags", ids: [UNKNOWN_ID], filter: {}, tagIds: [UNKNOWN_ID] },
      { action: "add_tags", tagIds: [UNKNOWN_ID] },
      { action: "add_tags", ids: [UNKNOWN_ID], tagIds: [] },
      { action: "add_tags", ids: [UNKNOWN_ID] },
    ]) {
      expect((await preview(world, owner, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it("answers 403 token_scope to a read-only token, 200 to a read-write one and 401 without a session", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await createdBookmark(world, owner, "own");
    const tag = await createdTag(world, owner, "mine");
    const readOnly = await harness.token(shared.workspaceId, owner, "read");

    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    const refused = await send(world, "POST", PREVIEW, bearer(readOnly), { action: "add_tags", ids: [own.id], tagIds: [tag] });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("token_scope");
    expect((await send(world, "POST", PREVIEW, bearer(readWrite), { action: "add_tags", ids: [own.id], tagIds: [tag] })).status).toBe(200);
    expect((await send(world, "POST", PREVIEW, {}, { action: "add_tags", ids: [own.id], tagIds: [tag] })).status).toBe(401);
  });
});
