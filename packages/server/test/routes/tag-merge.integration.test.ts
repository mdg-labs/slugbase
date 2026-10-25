import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/tags/{id}/merge and GET /api/v1/tags/stats (doc 04 section 10.7, doc 02 section 7.2, doc 05 section 2.4, doc 10 T1 and T2),
// through the whole chain over the migrated database: a merge moves the links of the source to the target in one transaction, leaves the
// bookmarks both tags are on with one link, deletes the source and answers the target with its new count; a tag of another member or of
// another workspace, as the source or as the target, is 404 and changes nothing; a tag merged into itself is 422; the statistics count the
// caller's own links, without the plan-archived bookmarks, most used first.

const TEST_TIMEOUT_MS = 60_000;
const TAGS = "/api/v1/tags";

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

interface Tag {
  readonly id: string;
  readonly name: string;
  readonly bookmarkCount: number;
  readonly createdAt: string;
}

interface TagStats {
  readonly items: readonly Tag[];
  readonly total: number | null;
  readonly totalAtLeast?: number;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const merge = (world: World, as: Person, id: string, body: unknown) => send(world, "POST", `${TAGS}/${id}/merge`, { cookie: as.cookie }, body);
const stats = (world: World, as: Person, query = "") => send(world, "GET", `${TAGS}/stats${query}`, { cookie: as.cookie });

async function created(world: World, as: Person, name: string): Promise<Tag> {
  const response = await send(world, "POST", TAGS, { cookie: as.cookie }, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Tag;
}

async function storedTags(): Promise<{ id: string; name: string }[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string; name: string }[]>`SELECT id, name FROM tags ORDER BY name, id`;
  });
}

/** The links of every tag, as `tag name -> bookmark titles`, sorted. */
async function storedLinks(): Promise<Record<string, string[]>> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ name: string; title: string }[]>`
      SELECT t.name, b.title FROM bookmark_tags l JOIN tags t ON t.id = l.tag_id JOIN bookmarks b ON b.id = l.bookmark_id ORDER BY t.name, b.title`;
  });
  const links: Record<string, string[]> = {};
  for (const row of rows) {
    (links[row.name] ??= []).push(row.title);
  }
  return links;
}

/** A bookmark of the owner titled `title`, linked to each of `tagIds`, as the system. */
async function bookmark(workspaceId: string, ownerId: string, title: string, tagIds: readonly string[], archived = false): Promise<string> {
  const bookmarkId = crypto.randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${bookmarkId}, ${workspaceId}, ${ownerId}, 'https://example.com/tagged', 'https://example.com/tagged', 'example.com', ${title}, ${archived ? new Date() : null})`;
    for (const tagId of tagIds) {
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`;
    }
  });
  return bookmarkId;
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

describe("mergeTag", () => {
  it(
    "moves the links of the source to the target, leaves a bookmark on both with one link, deletes the source and answers the target with its new count",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const source = await created(world, owner, "Source");
      const target = await created(world, owner, "Target");
      const bystander = await created(world, owner, "Bystander");
      await bookmark(shared.workspaceId, owner.account.id, "Only source", [source.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Both", [source.id, target.id, bystander.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Only target", [target.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Archived source", [source.id], true);

      const response = await merge(world, owner, source.id, { intoTagId: target.id });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: target.id, name: "Target", bookmarkCount: 3, createdAt: target.createdAt });
      expect((await storedTags()).map((row) => row.name)).toEqual(["Bystander", "Target"]);
      expect(await storedLinks()).toEqual({
        Bystander: ["Both"],
        Target: ["Archived source", "Both", "Only source", "Only target"],
      });
      expect((await merge(world, owner, source.id, { intoTagId: target.id })).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "merges a tag with no links, and leaves the links of the target as they were",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const source = await created(world, owner, "Empty");
      const target = await created(world, owner, "Target");
      await bookmark(shared.workspaceId, owner.account.id, "Mine", [target.id]);

      const response = await merge(world, owner, source.id, { intoTagId: target.id });

      expect(response.status).toBe(200);
      expect(((await response.json()) as Tag).bookmarkCount).toBe(1);
      expect(await storedLinks()).toEqual({ Target: ["Mine"] });
      expect((await storedTags()).map((row) => row.name)).toEqual(["Target"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for a target that is another member's, another workspace's or unknown, and for a source that is, and changes nothing",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger, shared, other } = await setup(world);
      const mine = await created(world, owner, "Mine");
      const members = await created(world, member, "Member's");
      const strangers = await created(world, stranger, "Stranger's");
      await bookmark(shared.workspaceId, owner.account.id, "Owner's", [mine.id]);
      await bookmark(shared.workspaceId, member.account.id, "Member's", [members.id]);
      await bookmark(other.workspaceId, stranger.account.id, "Stranger's", [strangers.id]);
      const before = [await storedTags(), await storedLinks()];

      const responses = [
        await merge(world, owner, mine.id, { intoTagId: members.id }),
        await merge(world, owner, mine.id, { intoTagId: strangers.id }),
        await merge(world, owner, mine.id, { intoTagId: crypto.randomUUID() }),
        await merge(world, owner, members.id, { intoTagId: mine.id }),
        await merge(world, owner, strangers.id, { intoTagId: mine.id }),
        await merge(world, owner, crypto.randomUUID(), { intoTagId: mine.id }),
        await merge(world, member, mine.id, { intoTagId: members.id }),
        await merge(world, stranger, mine.id, { intoTagId: strangers.id }),
        await merge(world, owner, members.id, { intoTagId: members.id }),
      ];

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404]);
      expect(await Promise.all(responses.map(async (response) => (await problemOf(response)).code))).toEqual(Array<string>(9).fill("not_found"));
      expect([await storedTags(), await storedLinks()]).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for a tag merged into itself, naming intoTagId, and changes nothing",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const tag = await created(world, owner, "Alpha");
      await bookmark(shared.workspaceId, owner.account.id, "Mine", [tag.id]);

      const response = await merge(world, owner, tag.id, { intoTagId: tag.id });

      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors).toEqual([{ path: "intoTagId", code: "same_tag" }]);
      expect(await storedLinks()).toEqual({ Alpha: ["Mine"] });
      expect((await storedTags()).map((row) => row.name)).toEqual(["Alpha"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for an identifier that is not a UUID and for a body that is empty, names no UUID or declares another field",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const source = await created(world, owner, "Source");
      const target = await created(world, owner, "Target");

      expect((await merge(world, owner, "not-a-uuid", { intoTagId: target.id })).status).toBe(422);
      for (const body of [{}, { intoTagId: "nope" }, { intoTagId: target.id, extra: true }, { intoTagId: null }]) {
        const response = await merge(world, owner, source.id, body);
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect((await storedTags()).map((row) => row.name)).toEqual(["Source", "Target"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets one of two merges of a pair in opposite directions at the same time through and answers the other 404, leaving one tag with every link",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const left = await created(world, owner, "Left");
      const right = await created(world, owner, "Right");
      await bookmark(shared.workspaceId, owner.account.id, "One", [left.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Two", [right.id]);

      const responses = await Promise.all([merge(world, owner, left.id, { intoTagId: right.id }), merge(world, owner, right.id, { intoTagId: left.id })]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
      const remaining = await storedTags();
      expect(remaining).toHaveLength(1);
      expect(Object.values(await storedLinks())).toEqual([["One", "Two"]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and changes nothing; a read-write token merges",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const source = await created(world, owner, "Source");
      const target = await created(world, owner, "Target");
      await bookmark(shared.workspaceId, owner.account.id, "Mine", [source.id]);
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
      const url = `${TAGS}/${source.id}/merge`;
      const body = { intoTagId: target.id };

      expect((await send(world, "POST", url, {}, body)).status).toBe(401);
      const crossSite = await send(world, "POST", url, { cookie: owner.cookie, origin: "https://evil.example" }, body);
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "POST", url, bearer(readOnly), body);
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect((await storedTags()).map((row) => row.name)).toEqual(["Source", "Target"]);
      expect(await storedLinks()).toEqual({ Source: ["Mine"] });

      expect((await send(world, "POST", url, bearer(readWrite), body)).status).toBe(200);
      expect(await storedLinks()).toEqual({ Target: ["Mine"] });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("getTagStats", () => {
  it(
    "lists the caller's tags most used first, then by name, with the number of bookmarks that are not plan-archived and the number of tags",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      const popular = await created(world, owner, "Popular");
      const alpha = await created(world, owner, "Alpha");
      const beta = await created(world, owner, "Beta");
      const unused = await created(world, owner, "Unused");
      const archivedOnly = await created(world, owner, "Archived only");
      const theirs = await created(world, member, "Theirs");
      await bookmark(shared.workspaceId, owner.account.id, "One", [popular.id, alpha.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Two", [popular.id, beta.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Three", [popular.id]);
      await bookmark(shared.workspaceId, owner.account.id, "Four", [archivedOnly.id], true);
      await bookmark(shared.workspaceId, member.account.id, "Theirs", [theirs.id]);

      const response = await stats(world, owner);

      expect(response.status).toBe(200);
      const body = (await response.json()) as TagStats;
      expect(body.items.map((tag) => [tag.name, tag.bookmarkCount])).toEqual([["Popular", 3], ["Alpha", 1], ["Beta", 1], ["Archived only", 0], ["Unused", 0]]);
      expect(body.items[0]).toEqual({ id: popular.id, name: "Popular", bookmarkCount: 3, createdAt: popular.createdAt });
      expect(body.total).toBe(5);
      expect(body.totalAtLeast).toBeUndefined();
      expect(unused.id).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns the top N of them, 50 when the limit is left out, and the total of all of the caller's tags",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      for (let index = 0; index < 55; index += 1) {
        await created(world, owner, `Tag ${String(index).padStart(2, "0")}`);
      }

      const byDefault = (await (await stats(world, owner)).json()) as TagStats;
      const three = (await (await stats(world, owner, "?limit=3")).json()) as TagStats;

      expect(byDefault.items).toHaveLength(50);
      expect(byDefault.total).toBe(55);
      expect(three.items.map((tag) => tag.name)).toEqual(["Tag 00", "Tag 01", "Tag 02"]);
      expect(three.total).toBe(55);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "holds none of another member's or another workspace's tags, and an empty list for a caller with none",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      await created(world, member, "Member's");
      await created(world, stranger, "Stranger's");

      const response = await stats(world, owner);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], total: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for a limit outside 1 to 100 or an unknown parameter, 401 without a session, and is read by a read-only token",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const readOnly = await harness.token(shared.workspaceId, owner, "read");

      for (const query of ["?limit=0", "?limit=101", "?limit=x", "?sort=name"]) {
        const response = await stats(world, owner, query);
        expect(response.status, query).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect((await send(world, "GET", `${TAGS}/stats`, {})).status).toBe(401);
      expect((await send(world, "GET", `${TAGS}/stats`, bearer(readOnly))).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );
});
