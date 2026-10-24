import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST and GET /api/v1/tags, PATCH and DELETE /api/v1/tags/{id} (doc 04 sections 2.4 and 10.7, doc 02 section 7.2, doc 05 section 2.4,
// doc 10 T1 and T2), through the whole chain over the migrated database: the creation (name 1 to 40 characters, stored as entered,
// unique per owner without regard to case, 409 name_taken), the list with the number of bookmarks of each tag by name or by count, the
// rename (a collision is 409 name_taken), the deletion with its links, that a tag is its owner's alone and another member's, another
// workspace's and an unknown tag are the same 404, and that a token needs the write scope to change tags and the read scope to list them.

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

interface TagList {
  readonly items: readonly Tag[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly totalAtLeast?: number;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const create = (world: World, as: Person, body: unknown) => send(world, "POST", TAGS, { cookie: as.cookie }, body);
const list = (world: World, as: Person, query = "") => send(world, "GET", `${TAGS}${query}`, { cookie: as.cookie });
const rename = (world: World, as: Person, id: string, body: unknown) => send(world, "PATCH", `${TAGS}/${id}`, { cookie: as.cookie }, body);
const remove = (world: World, as: Person, id: string) => send(world, "DELETE", `${TAGS}/${id}`, { cookie: as.cookie });

async function created(world: World, as: Person, name: string): Promise<Tag> {
  const response = await create(world, as, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Tag;
}

async function namesOf(world: World, as: Person, query = ""): Promise<readonly string[]> {
  const response = await list(world, as, query);
  expect(response.status).toBe(200);
  return ((await response.json()) as TagList).items.map((tag) => tag.name);
}

async function storedTags(): Promise<{ id: string; owner_id: string; workspace_id: string; name: string }[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string; owner_id: string; workspace_id: string; name: string }[]>`SELECT id, owner_id, workspace_id, name FROM tags ORDER BY name`;
  });
}

/** Links a tag to a bookmark of the owner, the way the operation that attaches tags will: as the system, since a request may not yet. */
async function attach(workspaceId: string, ownerId: string, tagId: string, archived = false): Promise<string> {
  const bookmarkId = crypto.randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${bookmarkId}, ${workspaceId}, ${ownerId}, 'https://example.com/tagged', 'https://example.com/tagged', 'example.com', 'Tagged', ${archived ? new Date() : null})`;
    await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`;
  });
  return bookmarkId;
}

/** Gives the owner `count` tags named `Bulk 00001` and on, as the system: far more than a request creates in a test. */
async function seedTags(workspaceId: string, ownerId: string, count: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO tags (id, workspace_id, owner_id, name)
      SELECT gen_random_uuid(), ${workspaceId}, ${ownerId}, 'Bulk ' || lpad(n::text, 5, '0') FROM generate_series(1, ${count}::int) AS n`;
  });
}

async function storedLinks(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmark_tags`;
  });
  return Number(rows[0]?.n);
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

describe("createTag", () => {
  it(
    "answers 201 with the tag as entered and no bookmarks, and stores it for the caller in the workspace of the request",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);

      const response = await create(world, owner, { name: "  Read Later  " });

      expect(response.status).toBe(201);
      const tag = (await response.json()) as Tag;
      expect(tag).toEqual({ id: tag.id, name: "Read Later", bookmarkCount: 0, createdAt: tag.createdAt });
      expect(new Date(tag.createdAt).toISOString()).toBe(tag.createdAt);
      expect(await storedTags()).toEqual([{ id: tag.id, owner_id: owner.account.id, workspace_id: shared.workspaceId, name: "Read Later" }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 409 name_taken for a name the caller has in any case, writing nothing, and lets another member use the name",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      await created(world, owner, "Read Later");

      for (const name of ["Read Later", "read later", "READ LATER", " Read Later "]) {
        const refused = await create(world, owner, { name });
        expect(refused.status).toBe(409);
        const problem = await problemOf(refused);
        expect(problem.code).toBe("name_taken");
        expect(problem.errors).toEqual([{ path: "name", code: "name_taken" }]);
      }
      expect(await storedTags()).toHaveLength(1);

      expect((await create(world, member, { name: "read later" })).status).toBe(201);
      expect((await storedTags()).map((tag) => [tag.name, tag.owner_id]).sort()).toEqual(
        [["Read Later", owner.account.id], ["read later", member.account.id]].sort(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes one tag of the creations of one name at the same time and answers the others 409 name_taken",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      const responses = await Promise.all([1, 2, 3, 4].map(() => create(world, owner, { name: "Race" })));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await storedTags()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for a name that is missing, blank or longer than 40 characters, and for a field it does not declare, writing nothing",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(41) }, { name: 5 }, { name: "ok", color: "red" }]) {
        const response = await create(world, owner, body);
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect((await create(world, owner, { name: "x".repeat(40) })).status).toBe(201);
      expect((await create(world, owner, { name: "😀".repeat(40) })).status).toBe(201);
      expect(await storedTags()).toHaveLength(2);
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

      expect((await send(world, "POST", TAGS, {}, { name: "Anonymous" })).status).toBe(401);
      const crossSite = await send(world, "POST", TAGS, { cookie: owner.cookie, origin: "https://evil.example" }, { name: "Cross site" });
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "POST", TAGS, bearer(readOnly), { name: "Read-only" });
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect(await storedTags()).toEqual([]);

      const made = await send(world, "POST", TAGS, bearer(readWrite), { name: "By token" });
      expect(made.status).toBe(201);
      expect((await storedTags()).map((tag) => [tag.name, tag.owner_id])).toEqual([["By token", owner.account.id]]);
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
      expect(await storedTags()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("listTags", () => {
  it(
    "lists the caller's tags with their counts by name, and by count and then name, leaving out plan-archived bookmarks",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const busy = await created(world, owner, "Busy");
      const quiet = await created(world, owner, "quiet");
      await created(world, owner, "Apple");
      await attach(shared.workspaceId, owner.account.id, busy.id);
      await attach(shared.workspaceId, owner.account.id, busy.id);
      await attach(shared.workspaceId, owner.account.id, busy.id, true);
      await attach(shared.workspaceId, owner.account.id, quiet.id);

      const byName = await list(world, owner);
      const byCount = await list(world, owner, "?sort=count");

      expect(byName.status).toBe(200);
      const named = (await byName.json()) as TagList;
      expect(named.items.map((tag) => [tag.name, tag.bookmarkCount])).toEqual([["Apple", 0], ["Busy", 2], ["quiet", 1]]);
      expect(named.total).toBe(3);
      expect(((await byCount.json()) as TagList).items.map((tag) => [tag.name, tag.bookmarkCount])).toEqual([["Busy", 2], ["quiet", 1], ["Apple", 0]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pages the list by keyset in both sorts: every tag once, a nextCursor until the last page, and the total of all pages on each",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      for (const [name, links] of [["Delta", 2], ["alpha", 0], ["Charlie", 2], ["Bravo", 1], ["Echo", 0]] as const) {
        const tag = await created(world, owner, name);
        for (let link = 0; link < links; link += 1) {
          await attach(shared.workspaceId, owner.account.id, tag.id);
        }
      }

      for (const [sort, expected] of [
        ["name", ["alpha", "Bravo", "Charlie", "Delta", "Echo"]],
        ["count", ["Charlie", "Delta", "Bravo", "alpha", "Echo"]],
      ] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const response = await list(world, owner, `?sort=${sort}&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
          expect(response.status).toBe(200);
          const page = (await response.json()) as TagList;
          expect(page.total).toBe(5);
          expect(page.totalAtLeast).toBeUndefined();
          seen.push(...page.items.map((tag) => tag.name));
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
    "refuses a cursor that was forged, altered, issued for another sort or another account with 400, and reads nothing of another member's tags through one",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      await created(world, owner, "One");
      await created(world, owner, "Two");
      await created(world, member, "Member's");
      const first = (await (await list(world, owner, "?limit=1")).json()) as TagList;
      const cursor = first.nextCursor;
      expect(cursor).not.toBeNull();
      const query = (sort: string, value: string) => `?sort=${sort}&limit=1&cursor=${encodeURIComponent(value)}`;

      expect((await list(world, owner, query("name", cursor ?? ""))).status).toBe(200);
      expect((await list(world, owner, query("count", cursor ?? ""))).status).toBe(400);
      expect((await list(world, member, query("name", cursor ?? ""))).status).toBe(400);
      expect((await list(world, owner, query("name", `${cursor ?? ""}x`))).status).toBe(400);
      expect((await list(world, owner, query("name", "forged"))).status).toBe(400);
      const refused = await list(world, owner, query("name", "forged"));
      expect((await problemOf(refused)).code).toBe("bad_request");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives the exact total up to 10 000 tags and null with totalAtLeast above, counting only the caller's tags",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      await seedTags(shared.workspaceId, member.account.id, 5);
      await seedTags(shared.workspaceId, owner.account.id, 10_000);

      const atTheCap = (await (await list(world, owner, "?limit=1")).json()) as TagList;
      expect(atTheCap.total).toBe(10_000);
      expect(atTheCap.totalAtLeast).toBeUndefined();
      expect(atTheCap.items).toHaveLength(1);
      expect(atTheCap.nextCursor).not.toBeNull();

      await created(world, owner, "One more");
      const above = (await (await list(world, owner, "?limit=1")).json()) as TagList;
      expect(above.total).toBeNull();
      expect(above.totalAtLeast).toBe(10_000);
      expect(above.items).toHaveLength(1);
    },
    TEST_TIMEOUT_MS * 2,
  );

  it(
    "lists nothing of another member's tags or of another workspace's, whoever asks",
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
    "answers 422 for a sort or a parameter it does not declare, and answers an empty list for a caller with no tags",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      expect((await list(world, owner, "?sort=newest")).status).toBe(422);
      expect((await list(world, owner, "?offset=5")).status).toBe(422);
      expect((await list(world, owner, "?limit=0")).status).toBe(422);
      expect((await list(world, owner, "?limit=101")).status).toBe(422);
      const empty = await list(world, owner);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ items: [], nextCursor: null, total: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401) and lets a read-only token list the tags of the account it is bound to",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      await created(world, owner, "Owner's");
      await created(world, member, "Member's");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");

      expect((await send(world, "GET", TAGS, {})).status).toBe(401);
      const response = await send(world, "GET", TAGS, bearer(readOnly));
      expect(response.status).toBe(200);
      expect(((await response.json()) as TagList).items.map((tag) => tag.name)).toEqual(["Owner's"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("renameTag", () => {
  it(
    "renames the caller's tag, keeps its count, answers the tag as it now is, and renames it to the same name in another case",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const tag = await created(world, owner, "Alpha");
      await attach(shared.workspaceId, owner.account.id, tag.id);

      const renamed = await rename(world, owner, tag.id, { name: "  Beta " });
      const recased = await rename(world, owner, tag.id, { name: "BETA" });

      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ id: tag.id, name: "Beta", bookmarkCount: 1, createdAt: tag.createdAt });
      expect(recased.status).toBe(200);
      expect(((await recased.json()) as Tag).name).toBe("BETA");
      expect((await storedTags()).map((row) => row.name)).toEqual(["BETA"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the tag unchanged for the name it has, and 409 name_taken for a name another tag of the caller has, writing nothing",
    async () => {
      const world = harness.serve();
      const { owner, member } = await setup(world);
      const alpha = await created(world, owner, "Alpha");
      await created(world, owner, "Beta");
      await created(world, member, "Gamma");

      const same = await rename(world, owner, alpha.id, { name: "Alpha" });
      expect(same.status).toBe(200);
      expect(await same.json()).toEqual(alpha);

      for (const name of ["Beta", "beta", " BETA "]) {
        const refused = await rename(world, owner, alpha.id, { name });
        expect(refused.status).toBe(409);
        const problem = await problemOf(refused);
        expect(problem.code).toBe("name_taken");
        expect(problem.errors).toEqual([{ path: "name", code: "name_taken" }]);
      }
      // Another member's tag of that name is no collision.
      expect((await rename(world, owner, alpha.id, { name: "Gamma" })).status).toBe(200);
      expect((await storedTags()).map((row) => row.name)).toEqual(["Beta", "Gamma", "Gamma"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets one of two renames to one name at the same time through and answers the other 409 name_taken",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const [first, second, third] = [await created(world, owner, "One"), await created(world, owner, "Two"), await created(world, owner, "Three")];

      const responses = await Promise.all([first, second, third].map((tag) => rename(world, owner, tag.id, { name: "Contested" })));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
      expect((await storedTags()).filter((row) => row.name === "Contested")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for another member's tag, another workspace's and an unknown one alike, and changes nothing",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      const tag = await created(world, owner, "Owner's");
      const theirs = await created(world, stranger, "Stranger's");

      const responses = [
        await rename(world, member, tag.id, { name: "Taken over" }),
        await rename(world, stranger, tag.id, { name: "Taken over" }),
        await rename(world, owner, theirs.id, { name: "Taken over" }),
        await rename(world, owner, crypto.randomUUID(), { name: "Taken over" }),
      ];

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect(await Promise.all(responses.map(async (response) => (await problemOf(response)).code))).toEqual(["not_found", "not_found", "not_found", "not_found"]);
      expect((await storedTags()).map((row) => row.name)).toEqual(["Owner's", "Stranger's"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for an identifier that is not a UUID and for a name that is blank, over-long or missing, writing nothing",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const tag = await created(world, owner, "Alpha");

      expect((await rename(world, owner, "not-a-uuid", { name: "Beta" })).status).toBe(422);
      for (const body of [{}, { name: "" }, { name: "  " }, { name: "x".repeat(41) }, { name: "Beta", extra: true }]) {
        const response = await rename(world, owner, tag.id, body);
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect((await storedTags()).map((row) => row.name)).toEqual(["Alpha"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and writes nothing; a read-write token renames",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const tag = await created(world, owner, "Alpha");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await send(world, "PATCH", `${TAGS}/${tag.id}`, {}, { name: "Anonymous" })).status).toBe(401);
      const crossSite = await send(world, "PATCH", `${TAGS}/${tag.id}`, { cookie: owner.cookie, origin: "https://evil.example" }, { name: "Cross site" });
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "PATCH", `${TAGS}/${tag.id}`, bearer(readOnly), { name: "Read-only" });
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect((await storedTags()).map((row) => row.name)).toEqual(["Alpha"]);

      expect((await send(world, "PATCH", `${TAGS}/${tag.id}`, bearer(readWrite), { name: "By token" })).status).toBe(200);
      expect((await storedTags()).map((row) => row.name)).toEqual(["By token"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("deleteTag", () => {
  it(
    "answers 204, deletes the tag with its links, keeps the bookmarks and the caller's other tags, and answers the repeat 404",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const doomed = await created(world, owner, "Doomed");
      const kept = await created(world, owner, "Kept");
      const bookmarkId = await attach(shared.workspaceId, owner.account.id, doomed.id);
      await attach(shared.workspaceId, owner.account.id, kept.id);

      const deleted = await remove(world, owner, doomed.id);
      const repeated = await remove(world, owner, doomed.id);

      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe("");
      expect(repeated.status).toBe(404);
      expect((await problemOf(repeated)).code).toBe("not_found");
      expect((await storedTags()).map((row) => row.name)).toEqual(["Kept"]);
      expect(await storedLinks()).toBe(1);
      const bookmarks = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE id = ${bookmarkId}`;
      });
      expect(bookmarks).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for another member's tag, another workspace's and an unknown one alike, and deletes nothing",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger, shared } = await setup(world);
      const tag = await created(world, owner, "Owner's");
      const theirs = await created(world, stranger, "Stranger's");
      await attach(shared.workspaceId, owner.account.id, tag.id);

      const responses = [
        await remove(world, member, tag.id),
        await remove(world, stranger, tag.id),
        await remove(world, owner, theirs.id),
        await remove(world, owner, crypto.randomUUID()),
      ];

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect((await storedTags()).map((row) => row.name)).toEqual(["Owner's", "Stranger's"]);
      expect(await storedLinks()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for an identifier that is not a UUID",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      expect((await remove(world, owner, "not-a-uuid")).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and deletes nothing; a read-write token deletes",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const tag = await created(world, owner, "Alpha");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await send(world, "DELETE", `${TAGS}/${tag.id}`, {})).status).toBe(401);
      const crossSite = await send(world, "DELETE", `${TAGS}/${tag.id}`, { cookie: owner.cookie, origin: "https://evil.example" });
      expect(crossSite.status).toBe(403);
      expect((await problemOf(crossSite)).code).toBe("cross_site_request");
      const scoped = await send(world, "DELETE", `${TAGS}/${tag.id}`, bearer(readOnly));
      expect(scoped.status).toBe(403);
      expect((await problemOf(scoped)).code).toBe("token_scope");
      expect(await storedTags()).toHaveLength(1);

      expect((await send(world, "DELETE", `${TAGS}/${tag.id}`, bearer(readWrite))).status).toBe(204);
      expect(await storedTags()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a tag leaves with its owner", () => {
  it(
    "is deleted with the membership of the member who made it, and the other members' tags stay",
    async () => {
      const world = harness.serve();
      const { owner, member, shared } = await setup(world);
      await created(world, owner, "Owner's");
      const theirs = await created(world, member, "Member's");
      await attach(shared.workspaceId, member.account.id, theirs.id);

      const removed = await send(world, "DELETE", `/api/v1/members/${member.account.id}`, { cookie: owner.cookie }, { content: "delete" });

      expect(removed.status).toBe(200);
      expect((await storedTags()).map((row) => row.name)).toEqual(["Owner's"]);
      expect(await storedLinks()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
