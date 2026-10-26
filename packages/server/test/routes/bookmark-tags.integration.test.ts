import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Tagging bookmarks (doc 04 sections 10.6 and 10.7, doc 02 sections 7.2 and 8.2, doc 13 Q22, doc 10 T1 and T2): `tagIds` and `tagNames` on the
// creation and the change of a bookmark, `tag` on the list, the `tags` every bookmark carries and the counts of GET /tags, through the whole chain over
// the migrated database. The failure scenario: member B passes member A's tag to the change of B's own bookmark and gets 404, B's tags never hold A's,
// and a read of the links as B returns none of A's.

const BOOKMARKS = "/api/v1/bookmarks";
const TAGS = "/api/v1/tags";
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

interface TagRef {
  readonly id: string;
  readonly name: string;
}

interface Bookmark {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly tags: readonly TagRef[];
}

interface Tag extends TagRef {
  readonly bookmarkCount: number;
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

async function createdBookmark(world: World, as: Person, title: string, tags: { tagIds?: readonly string[]; tagNames?: readonly string[] } = {}): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...tags });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function createdTag(world: World, as: Person, name: string): Promise<Tag> {
  const response = await send(world, "POST", TAGS, { cookie: as.cookie }, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Tag;
}

const patch = (world: World, as: Person, id: string, body: unknown, headers: Record<string, string> = {}) => send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: as.cookie, ...headers }, body);
const readBookmark = async (world: World, as: Person, id: string): Promise<Bookmark> => (await (await send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie })).json()) as Bookmark;
const tagsOf = async (world: World, as: Person): Promise<Tag[]> => ((await (await send(world, "GET", `${TAGS}?sort=name`, { cookie: as.cookie })).json()) as { items: Tag[] }).items;

async function listed(world: World, as: Person, query: string): Promise<BookmarkList> {
  const response = await send(world, "GET", `${BOOKMARKS}?${query}`, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as BookmarkList;
}

async function storedLinks(): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ link: string }[]>`SELECT bookmark_id || '/' || tag_id AS link FROM bookmark_tags ORDER BY 1`;
  });
  return rows.map((row) => row.link);
}

async function storedTagNames(): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ name: string }[]>`SELECT name::text AS name FROM tags ORDER BY lower(name::text)`;
  });
  return rows.map((row) => row.name);
}

async function storedBookmarkRows(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks`;
  });
  return rows[0]?.n ?? -1;
}

/** The links of the table as one account's session reads it, with no application layer: row-level security only. */
async function linksReadAs(accountId: string, workspaceId: string): Promise<number> {
  const rows = await database().app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx`SELECT bookmark_id FROM bookmark_tags`;
  });
  return rows.length;
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

describe("the failure scenario: member B tags with member A's tag (T1, T2)", () => {
  it("answers 404 when B passes A's tag to the change of B's own bookmark, and B's tags never hold A's", async () => {
    const world = harness.serve();
    const { owner: a, member: b, shared } = await setup(world);
    const tagOfA = await createdTag(world, a, "Of A");
    const ownTagOfB = await createdTag(world, b, "Of B");
    const bookmarkOfA = await createdBookmark(world, a, "Of A", { tagIds: [tagOfA.id] });
    const bookmarkOfB = await createdBookmark(world, b, "Of B");

    for (const body of [{ tagIds: [tagOfA.id] }, { tagIds: [ownTagOfB.id, tagOfA.id], tagNames: ["Brand new"] }, { title: "Changed", tagIds: [tagOfA.id] }]) {
      const response = await patch(world, b, bookmarkOfB.id, body);
      expect(response.status, JSON.stringify(body)).toBe(404);
      expect((await problemOf(response)).code).toBe("not_found");
    }

    expect(await readBookmark(world, b, bookmarkOfB.id)).toMatchObject({ title: "Of B", version: 1, tags: [] });
    expect((await tagsOf(world, b)).map((tag) => tag.id)).toEqual([ownTagOfB.id]);
    expect(await storedTagNames()).toEqual(["Of A", "Of B"]);
    expect(await storedLinks()).toEqual([`${bookmarkOfA.id}/${tagOfA.id}`]);
    // A direct read of the links as B returns no link of A's, and the same read as A returns A's.
    expect(await linksReadAs(b.account.id, shared.workspaceId)).toBe(0);
    expect(await linksReadAs(a.account.id, shared.workspaceId)).toBe(1);
  });

  it("answers 404 and creates nothing when a creation names A's tag, a tag of another workspace or an unknown one", async () => {
    const world = harness.serve();
    const { owner: a, member: b, stranger } = await setup(world);
    const tagOfA = await createdTag(world, a, "Of A");
    const tagThere = await createdTag(world, stranger, "There");

    for (const tagId of [tagOfA.id, tagThere.id, UNKNOWN]) {
      const response = await send(world, "POST", BOOKMARKS, { cookie: b.cookie }, { url: "https://example.com/x", title: "X", tagIds: [tagId], tagNames: ["Brand new"] });
      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe("not_found");
    }

    expect(await storedBookmarkRows()).toBe(0);
    expect(await storedTagNames()).toEqual(["Of A", "There"]);
    expect(await storedLinks()).toEqual([]);
  });

  it("answers 404 for a bookmark of another member or workspace whatever the tags, and creates no tag for it", async () => {
    const world = harness.serve();
    const { owner: a, member: b, stranger } = await setup(world);
    const bookmarkOfB = await createdBookmark(world, b, "Of B");
    const bookmarkThere = await createdBookmark(world, stranger, "There");

    for (const id of [bookmarkOfB.id, bookmarkThere.id, UNKNOWN]) {
      expect((await patch(world, a, id, { tagNames: ["Never created"] })).status).toBe(404);
    }

    expect(await storedTagNames()).toEqual([]);
    expect(await storedLinks()).toEqual([]);
  });
});

describe("tagIds and tagNames on the creation and the change of a bookmark, and tags on its body", () => {
  it("tags a new bookmark with the tags it names, creating the missing ones by name in any case, and carries them in the order of their names", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const zebra = await createdTag(world, owner, "zebra");

    const bookmark = await createdBookmark(world, owner, "Tagged", { tagIds: [zebra.id, zebra.id], tagNames: ["Apple", " ZEBRA ", "mango", "Mango"] });

    expect(bookmark.tags.map((tag) => tag.name)).toEqual(["Apple", "mango", "zebra"]);
    expect(bookmark.tags.find((tag) => tag.name === "zebra")?.id).toBe(zebra.id);
    expect((await readBookmark(world, owner, bookmark.id)).tags).toEqual(bookmark.tags);
    expect((await listed(world, owner, "")).items[0]?.tags).toEqual(bookmark.tags);
    expect((await tagsOf(world, owner)).map((tag) => [tag.name, tag.bookmarkCount])).toEqual([["Apple", 1], ["mango", 1], ["zebra", 1]]);
    expect((await createdBookmark(world, owner, "Loose")).tags).toEqual([]);
  });

  it("replaces the tags on a change, keeps the version and the ETag when only the tags change, and clears them with an empty list", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const [one, two] = [await createdTag(world, owner, "One"), await createdTag(world, owner, "Two")];
    const bookmark = await createdBookmark(world, owner, "Tagged", { tagIds: [one.id] });
    const ifMatch = { "if-match": `"${String(bookmark.version)}"` };

    const replaced = await patch(world, owner, bookmark.id, { tagIds: [two.id], tagNames: ["three"] }, ifMatch);
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("etag")).toBe(`"${String(bookmark.version)}"`);
    expect(((await replaced.json()) as Bookmark).tags.map((tag) => tag.name)).toEqual(["three", "Two"]);

    const retitled = await patch(world, owner, bookmark.id, { title: "Renamed", tagNames: ["Three"] }, ifMatch);
    expect(retitled.status).toBe(200);
    expect(await retitled.json()).toMatchObject({ title: "Renamed", version: bookmark.version + 1, tags: [{ name: "three" }] });

    const left = await patch(world, owner, bookmark.id, { description: "kept" });
    expect(((await left.json()) as Bookmark).tags.map((tag) => tag.name)).toEqual(["three"]);
    const cleared = await patch(world, owner, bookmark.id, { tagIds: [] });
    expect(((await cleared.json()) as Bookmark).tags).toEqual([]);
    expect(await storedLinks()).toEqual([]);
    // Taking the tags off a bookmark leaves them: they are still the owner's tags.
    expect((await tagsOf(world, owner)).map((tag) => [tag.name, tag.bookmarkCount])).toEqual([["One", 0], ["three", 0], ["Two", 0]]);
  });

  it("answers 200 with the unchanged ETag for a patch that names the tags the bookmark has", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const bookmark = await createdBookmark(world, owner, "Tagged", { tagNames: ["One"] });

    const response = await patch(world, owner, bookmark.id, { tagNames: ["one"] });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${String(bookmark.version)}"`);
    expect(await storedTagNames()).toEqual(["One"]);
  });

  it("answers 412 for a stale If-Match and creates no tag, and 422 for more than 100 tags, a malformed identifier and a name that is empty or over 40 characters, on both operations", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const bookmark = await createdBookmark(world, owner, "Tagged");

    expect((await patch(world, owner, bookmark.id, { tagNames: ["Stale"] }, { "if-match": '"9"' })).status).toBe(412);
    expect(await storedTagNames()).toEqual([]);

    const bodies = [
      { tagIds: Array.from({ length: 101 }, () => UNKNOWN) },
      { tagIds: ["nope"] },
      { tagNames: Array.from({ length: 101 }, (_, index) => `tag ${String(index)}`) },
      { tagNames: [""] },
      { tagNames: ["   "] },
      { tagNames: ["t".repeat(41)] },
      { tagNames: [1] },
    ];
    for (const body of bodies) {
      expect((await send(world, "POST", BOOKMARKS, { cookie: owner.cookie }, { url: "https://example.com/x", title: "X", ...body })).status, JSON.stringify(body).slice(0, 40)).toBe(422);
      expect((await patch(world, owner, bookmark.id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect(await storedBookmarkRows()).toBe(1);
    expect(await storedTagNames()).toEqual([]);
  });

  it("is refused to a read-only token (403 token_scope) and from another site (403 cross_site_request); a read-write token tags", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const bookmark = await createdBookmark(world, owner, "Tagged");
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
    const path = `${BOOKMARKS}/${bookmark.id}`;

    const scoped = await send(world, "PATCH", path, bearer(readOnly), { tagNames: ["One"] });
    expect(scoped.status).toBe(403);
    expect((await problemOf(scoped)).code).toBe("token_scope");
    const crossSite = await send(world, "PATCH", path, { cookie: owner.cookie, origin: "https://evil.example" }, { tagNames: ["One"] });
    expect(crossSite.status).toBe(403);
    expect(await storedTagNames()).toEqual([]);

    const tagged = await send(world, "PATCH", path, bearer(readWrite), { tagNames: ["One"] });
    expect(tagged.status).toBe(200);
    expect(((await tagged.json()) as Bookmark).tags.map((tag) => tag.name)).toEqual(["One"]);
  });
});

describe("a bookmark never carries the tags of another member, and the counts of GET /tags are the caller's", () => {
  it("shows each member their own tags only, and counts only their own links", async () => {
    const world = harness.serve();
    const { owner: a, member: b } = await setup(world);
    const tagOfA = await createdTag(world, a, "Shared name");
    const tagOfB = await createdTag(world, b, "Shared name");
    const bookmarkOfA = await createdBookmark(world, a, "Of A", { tagIds: [tagOfA.id] });
    await createdBookmark(world, a, "Also of A", { tagIds: [tagOfA.id] });
    await createdBookmark(world, b, "Of B", { tagIds: [tagOfB.id] });

    expect((await readBookmark(world, a, bookmarkOfA.id)).tags).toEqual([{ id: tagOfA.id, name: "Shared name" }]);
    expect((await listed(world, b, "")).items.flatMap((bookmark) => bookmark.tags.map((tag) => tag.id))).toEqual([tagOfB.id]);
    expect(await tagsOf(world, a)).toMatchObject([{ id: tagOfA.id, bookmarkCount: 2 }]);
    expect(await tagsOf(world, b)).toMatchObject([{ id: tagOfB.id, bookmarkCount: 1 }]);
    // B does not read A's bookmark, and its body is never the way to learn A's tags.
    expect((await send(world, "GET", `${BOOKMARKS}/${bookmarkOfA.id}`, { cookie: b.cookie })).status).toBe(404);
  });
});

describe("GET /bookmarks?tag=", () => {
  async function library(world: World, owner: Person) {
    const reading = await createdTag(world, owner, "Reading");
    const later = await createdTag(world, owner, "Later");
    const work = await createdTag(world, owner, "Work");
    const both = await createdBookmark(world, owner, "Both", { tagIds: [reading.id, later.id] });
    const onlyReading = await createdBookmark(world, owner, "Only reading", { tagIds: [reading.id] });
    await createdBookmark(world, owner, "None");
    return { reading, later, work, both, onlyReading };
  }

  it("lists the bookmarks that carry every tag named (AND), counts them, and a rename of a tag breaks no filter", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const { reading, later, both, onlyReading } = await library(world, owner);

    expect((await listed(world, owner, `tag=${reading.id}&sort=title_asc`)).items.map((bookmark) => bookmark.id)).toEqual([both.id, onlyReading.id]);
    const anded = await listed(world, owner, `tag=${reading.id}&tag=${later.id}`);
    expect(anded.items.map((bookmark) => bookmark.id)).toEqual([both.id]);
    expect(anded.total).toBe(1);
    expect(anded.items[0]?.tags.map((tag) => tag.name)).toEqual(["Later", "Reading"]);

    const renamed = await send(world, "PATCH", `${TAGS}/${reading.id}`, { cookie: owner.cookie }, { name: "To read" });
    expect(renamed.status).toBe(200);
    expect((await listed(world, owner, `tag=${reading.id}&tag=${later.id}`)).items.map((bookmark) => bookmark.id)).toEqual([both.id]);
  });

  it("pages through a tag with a cursor bound to the tags, and refuses the cursor for other tags", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const { reading, later } = await library(world, owner);

    const first = await listed(world, owner, `tag=${reading.id}&sort=title_asc&limit=1`);
    expect(first.items.map((bookmark) => bookmark.title)).toEqual(["Both"]);
    const second = await listed(world, owner, `tag=${reading.id}&sort=title_asc&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(second.items.map((bookmark) => bookmark.title)).toEqual(["Only reading"]);
    for (const other of [`tag=${later.id}`, `tag=${reading.id}&tag=${later.id}`, ""]) {
      const forged = await send(world, "GET", `${BOOKMARKS}?${other}&sort=title_asc&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, { cookie: owner.cookie });
      expect(forged.status, other).toBe(400);
    }
  });

  it("answers an empty page when one of the tags is another member's, another workspace's, unknown or carried by none, not an error and not a row", async () => {
    const world = harness.serve();
    const { owner, member, stranger } = await setup(world);
    const { reading, work } = await library(world, owner);
    const tagOfB = await createdTag(world, member, "Of B");
    const tagThere = await createdTag(world, stranger, "There");
    await createdBookmark(world, member, "Of B", { tagIds: [tagOfB.id] });

    for (const tags of [[tagOfB.id], [tagThere.id], [UNKNOWN], [reading.id, tagOfB.id], [work.id]]) {
      expect(await listed(world, owner, tags.map((id) => `tag=${id}`).join("&")), tags.join()).toMatchObject({ items: [], nextCursor: null, total: 0 });
    }
  });

  it("answers 422 for a tag that is not an identifier and for more than 10 tags", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    for (const query of ["tag=nope", `tag=${UNKNOWN}&tag=nope`, Array.from({ length: 11 }, () => `tag=${UNKNOWN}`).join("&")]) {
      expect((await send(world, "GET", `${BOOKMARKS}?${query}`, { cookie: owner.cookie })).status, query.slice(0, 40)).toBe(422);
    }
    expect((await send(world, "GET", `${BOOKMARKS}?${Array.from({ length: 10 }, () => `tag=${UNKNOWN}`).join("&")}`, { cookie: owner.cookie })).status).toBe(200);
  });
});
