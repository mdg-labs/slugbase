import { BOOKMARK_SORTS, type BookmarkListFilter, type BookmarkPosition, type BookmarkSort } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, TenantContextError } from "../src/index.ts";
import { listQuery } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { shareBookmark } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The list of the bookmarks of a member narrowed by a text (doc 02 section 5.7, doc 04 section 6.2, doc 05 sections 2.4 and 3.3, doc 10 T1 and T2). The matches come from the system operation
// `sys_bookmark_match`, and the list keeps the sort and the keyset of a list without a text. The failure scenarios: a page that resumes at a key the database ordered differently, so a
// bookmark that shares its sort key with the last one of the page before is skipped or shown twice, in the read of a few matches (each is probed) and in the read of many (the sort index is walked);
// a bookmark of another owner, of another workspace, a plan-archived or an ownerless one that is listed or counted; and a filter of the list that the text widens instead of narrowing.

const HOOK_TIMEOUT_MS = 300_000;
const SMALL_PAGE = 4;
const BIG_PAGE = 500;
// More matches than the list probes one by one (`FEW_MATCHES` of src/repositories/bookmarks.ts).
const MANY = 10_100;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `bookmarks-list-search${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "bookmarks-list-search-test" }, work);
}

const ORDER_BY: Readonly<Record<BookmarkSort, string>> = {
  recent: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  title_asc: "lower(title) ASC, id ASC",
  title_desc: "lower(title) DESC, id DESC",
  most_used: "open_count DESC, id DESC",
  recently_opened: "last_opened_at DESC NULLS LAST, id DESC",
};

/** The ids in the order of the sort, from the table itself, for the bookmarks of the owner whose title starts with `prefix` and that match the filter given as SQL. */
async function reference(workspaceId: string, ownerId: string, sort: BookmarkSort, prefix: string, where = "true"): Promise<string[]> {
  const rows = await asSystem(
    db,
    (tx) => tx.unsafe<{ id: string }[]>(
      `SELECT id FROM bookmarks WHERE workspace_id = $1 AND owner_id = $2 AND plan_archived_at IS NULL AND title ILIKE $3 AND ${where} ORDER BY ${ORDER_BY[sort]}`,
      [workspaceId, ownerId, `${prefix}%`],
    ),
  );
  return rows.map((row) => row.id);
}

/** Reads every page of the list, `limit` at a time, each from the place the one before ended at; the ids in the order they came. */
async function walk(tenant: { accountId: string; workspaceId: string }, sort: BookmarkSort, filter: Omit<BookmarkListFilter, "ownerId">, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let after: BookmarkPosition | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const rows = await inTenant(tenant, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: tenant.accountId, ...filter }, sort, after, limit }));
    seen.push(...rows.map((row) => row.bookmark.id));
    const last = rows.at(-1);
    if (rows.length < limit || last === undefined) {
      return seen;
    }
    after = { key: last.key, id: last.bookmark.id };
  }
  throw new Error("a list of a few thousand bookmarks did not end");
}

interface World {
  readonly alice: string;
  readonly bob: string;
  /** The workspace with 40 matches of `widget` and the bookmarks around them. */
  readonly few: string;
  /** The workspace with `MANY` matches of `gizmo`. */
  readonly many: string;
  readonly other: string;
  readonly folderId: string;
  readonly tagId: string;
}

let world: World;

/** The bookmarks of the owner with a title `${word} ${n}` that tie in the groups the sorts have to break: created in groups of three, the open count repeating and the last opening missing for a third. */
async function seedMatches(workspaceId: string, ownerId: string, word: string, count: number): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, open_count, last_opened_at, created_at)
      SELECT gen_random_uuid(), ${workspaceId}, ${ownerId}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com',
             CASE WHEN n % 2 = 0 THEN initcap(${word}::text) || ' ' || (n % 9) ELSE ${word}::text || ' ' || (n % 9) END,
             CASE WHEN n % 5 = 0 THEN ${word}::text || '-' || n END, n % 10 = 0, CASE WHEN n % 6 = 0 THEN now() END, n % 4,
             CASE WHEN n % 3 = 0 THEN NULL ELSE timestamptz '2026-03-02 10:00:00' + (n / 4) * interval '1 second' + interval '654321 microseconds' END,
             timestamptz '2026-03-01 10:00:00' + (n / 3) * interval '1 second' + interval '123456 microseconds'
      FROM generate_series(1, ${count}) AS n`,
  );
}

async function seedRow(workspaceId: string, ownerId: string | null, title: string, archived = false): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, plan_archived_at)
      VALUES (${freshId()}, ${workspaceId}, ${ownerId}, 'https://example.com/x', 'https://example.com/x', 'example.com', ${title}, ${title.toLowerCase().replaceAll(" ", "-")}, ${archived ? new Date() : null})`,
  );
}

beforeAll(async () => {
  const alice = await account();
  const bob = await account();
  const few = await seedWorkspace(db, { name: "List search few" });
  const many = await seedWorkspace(db, { name: "List search many" });
  const other = await seedWorkspace(db, { name: "List search other" });
  for (const workspaceId of [few, many]) {
    await seedMember(db, { workspaceId, accountId: alice, role: "owner" });
    await seedMember(db, { workspaceId, accountId: bob });
  }
  await seedMember(db, { workspaceId: other, accountId: alice, role: "owner" });

  await seedMatches(few, alice, "widget", 40);
  await seedMatches(many, alice, "gizmo", MANY);
  await seedMatches(other, alice, "widget", 5);
  // Bookmarks that match and that no list of alice's may hold, in each of the two workspaces: bob's, a plan-archived one and one without an owner.
  for (const [workspaceId, word] of [[few, "Widget"], [many, "Gizmo"]] as const) {
    await seedRow(workspaceId, bob, `${word} of bob`);
    await seedRow(workspaceId, alice, `${word} archived`, true);
    await seedRow(workspaceId, null, `${word} ownerless`);
  }
  // Bookmarks that do not match.
  await seedRow(few, alice, "Gadget one");
  await seedRow(few, alice, "Gadget two");

  const folderId = freshId();
  const tagId = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folderId}, ${few}, ${alice}, 'Search folder')`;
    await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${tagId}, ${few}, ${alice}, 'search-tag')`;
    await tx`
      INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id)
      SELECT workspace_id, ${folderId}, id FROM (SELECT id, workspace_id, row_number() OVER (ORDER BY id) AS r FROM bookmarks WHERE workspace_id = ${few} AND owner_id = ${alice}) b WHERE r % 3 = 0`;
    await tx`
      INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id)
      SELECT workspace_id, id, ${tagId} FROM (SELECT id, workspace_id, row_number() OVER (ORDER BY id) AS r FROM bookmarks WHERE workspace_id = ${few} AND owner_id = ${alice}) b WHERE r % 4 = 0`;
  });
  await db.owner.unsafe("ANALYZE bookmarks");
  world = { alice, bob, few, many, other, folderId, tagId };
}, HOOK_TIMEOUT_MS);

describe("the pages of a list with a text", () => {
  it.each(BOOKMARK_SORTS)("reads every match exactly once, in the order of the database, when the sort is %s and the matches are few", async (sort) => {
    const pages = await walk({ accountId: world.alice, workspaceId: world.few }, sort, { q: "widget" }, SMALL_PAGE);

    expect(pages).toEqual(await reference(world.few, world.alice, sort, "widget"));
    expect(new Set(pages).size).toBe(40);
  });

  it.each(BOOKMARK_SORTS)("reads every match exactly once, in the order of the database, when the sort is %s and the matches are many", async (sort) => {
    const pages = await walk({ accountId: world.alice, workspaceId: world.many }, sort, { q: "gizmo" }, BIG_PAGE);

    expect(pages).toEqual(await reference(world.many, world.alice, sort, "gizmo"));
    expect(new Set(pages).size).toBe(MANY);
  });

  it("gives each bookmark its sort key as text with the precision the database keeps, as a list without a text does", async () => {
    const [first] = await inTenant({ accountId: world.alice, workspaceId: world.few }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice, q: "widget" }, sort: "recent", after: undefined, limit: 1 }));

    expect(first?.key).toMatch(/^2026-03-01 10:00:13\.123456\+00$/);
  });

  it("answers the bookmark records of a list, with the folders and the tags they carry", async () => {
    const rows = await inTenant({ accountId: world.alice, workspaceId: world.few }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice, q: "widget", folderId: world.folderId, tagIds: [world.tagId] }, sort: "recent", after: undefined, limit: 40 }));

    expect(rows.length).toBeGreaterThan(0);
    for (const { bookmark } of rows) {
      expect(bookmark.folders.map((folder) => folder.id)).toContain(world.folderId);
      expect(bookmark.tags.map((tag) => tag.id)).toContain(world.tagId);
      expect(bookmark.title.toLowerCase()).toContain("widget");
    }
  });

  it("matches the word of a text by its prefix in any case, and a title, a slug, a host or a description holds it", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.few };

    expect((await walk(tenant, "recent", { q: "WIDG" }, 100)).length).toBe(40);
    expect(await walk(tenant, "recent", { q: "widget-5" }, 100)).toHaveLength(1);
    expect(await walk(tenant, "recent", { q: "nothing matches this" }, 100)).toEqual([]);
  });
});

describe("the filters of a list with a text", () => {
  const cases: readonly { name: string; filter: (ids: { folderId: string; tagId: string }) => Omit<BookmarkListFilter, "ownerId">; where: (ids: { folderId: string; tagId: string }) => string }[] = [
    { name: "pinned only", filter: () => ({ pinned: true }), where: () => "pinned_at IS NOT NULL" },
    { name: "unpinned only", filter: () => ({ pinned: false }), where: () => "pinned_at IS NULL" },
    { name: "with a slug", filter: () => ({ hasSlug: true }), where: () => "slug IS NOT NULL" },
    { name: "without a slug", filter: () => ({ hasSlug: false }), where: () => "slug IS NULL" },
    { name: "forwarding", filter: () => ({ forwarding: true }), where: () => "forwarding" },
    { name: "with a slug and forwarding", filter: () => ({ hasSlug: true, forwarding: true }), where: () => "slug IS NOT NULL AND forwarding" },
    { name: "filed in a folder", filter: ({ folderId }) => ({ folderId }), where: ({ folderId }) => `EXISTS (SELECT 1 FROM folder_bookmarks f WHERE f.bookmark_id = bookmarks.id AND f.folder_id = '${folderId}')` },
    { name: "carrying a tag", filter: ({ tagId }) => ({ tagIds: [tagId] }), where: ({ tagId }) => `EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = bookmarks.id AND t.tag_id = '${tagId}')` },
    { name: "filed in a folder and carrying a tag", filter: ({ folderId, tagId }) => ({ folderId, tagIds: [tagId] }), where: ({ folderId, tagId }) => `EXISTS (SELECT 1 FROM folder_bookmarks f WHERE f.bookmark_id = bookmarks.id AND f.folder_id = '${folderId}') AND EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = bookmarks.id AND t.tag_id = '${tagId}')` },
  ];

  it.each(cases)("narrows the matches to the bookmarks that are $name, paged by every sort, and counts them", async ({ filter, where }) => {
    const tenant = { accountId: world.alice, workspaceId: world.few };
    for (const sort of ["recent", "title_desc", "recently_opened"] as const) {
      expect(await walk(tenant, sort, { q: "widget", ...filter(world) }, SMALL_PAGE), sort).toEqual(await reference(world.few, world.alice, sort, "widget", where(world)));
    }
    const expected = (await reference(world.few, world.alice, "recent", "widget", where(world))).length;
    expect(expected).toBeGreaterThan(0);

    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "widget", ...filter(world) }, 1000))).toBe(expected);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).ids({ ownerId: world.alice, q: "widget", ...filter(world) }, 1000))).toEqual(await reference(world.few, world.alice, "recent", "widget", where(world)));
  });

  it("narrows the matches to the pinned bookmarks when the matches are many", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.many };
    const filter = { q: "gizmo", pinned: true } as const;

    expect(await walk(tenant, "title_asc", filter, 100)).toEqual(await reference(world.many, world.alice, "title_asc", "gizmo", "pinned_at IS NOT NULL"));
  });
});

describe("the count and the identifiers of a list with a text", () => {
  it("count the matches, up to the limit, whether they are few or many", async () => {
    const few = { accountId: world.alice, workspaceId: world.few };
    const many = { accountId: world.alice, workspaceId: world.many };

    expect(await inTenant(few, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "widget" }, 1000))).toBe(40);
    expect(await inTenant(few, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "widget" }, 7))).toBe(7);
    expect(await inTenant(few, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "gadget" }, 1000))).toBe(2);
    expect(await inTenant(few, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "zzzqqq" }, 1000))).toBe(0);
    expect(await inTenant(many, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "gizmo" }, 20_000))).toBe(MANY);
    expect(await inTenant(many, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "gizmo" }, 10_001))).toBe(10_001);
    expect(await inTenant(many, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "gizmo" }, 100))).toBe(100);
  });

  it("list the identifiers of the matches, newest first, up to the limit", async () => {
    const many = { accountId: world.alice, workspaceId: world.many };
    const everything = await reference(world.many, world.alice, "recent", "gizmo");

    expect(await inTenant(many, (tx) => bookmarkRepository(tx).ids({ ownerId: world.alice, q: "gizmo" }, 20_000))).toEqual(everything);
    expect(await inTenant(many, (tx) => bookmarkRepository(tx).ids({ ownerId: world.alice, q: "gizmo" }, 10_000))).toEqual(everything.slice(0, 10_000));
    expect(await inTenant(many, (tx) => bookmarkRepository(tx).ids({ ownerId: world.alice, q: "gizmo" }, 25))).toEqual(everything.slice(0, 25));
  });
});

describe("the page and the count of a list with a text, read together", () => {
  const request = (filter: BookmarkListFilter, limit: number, after?: BookmarkPosition) => ({ filter, sort: "recent" as const, after, limit });

  it("answer what the page and the count answer apart, for a text alone, whether the matches are few or many, and at the cap", async () => {
    const cases = [
      { tenant: { accountId: world.alice, workspaceId: world.few }, q: "widget", cap: 1000, expected: 40 },
      { tenant: { accountId: world.alice, workspaceId: world.few }, q: "widget", cap: 7, expected: 7 },
      { tenant: { accountId: world.alice, workspaceId: world.few }, q: "zzzqqq", cap: 1000, expected: 0 },
      { tenant: { accountId: world.alice, workspaceId: world.many }, q: "gizmo", cap: 20_000, expected: MANY },
      { tenant: { accountId: world.alice, workspaceId: world.many }, q: "gizmo", cap: 10_001, expected: 10_001 },
    ];
    for (const { tenant, q, cap, expected } of cases) {
      const filter = { ownerId: world.alice, q };
      const together = await inTenant(tenant, (tx) => bookmarkRepository(tx).listWithCount(request(filter, 5), cap));

      expect(together.count, `${q} ${String(cap)}`).toBe(expected);
      expect(together.rows).toEqual(await inTenant(tenant, (tx) => bookmarkRepository(tx).list(request(filter, 5))));
      expect(together.count).toBe(await inTenant(tenant, (tx) => bookmarkRepository(tx).count(filter, cap)));
    }
  });

  it("count the matches of a page that resumes after a place, and of one that starts after the last match", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.few };
    const filter = { ownerId: world.alice, q: "widget" };
    const all = await inTenant(tenant, (tx) => bookmarkRepository(tx).list(request(filter, 100)));
    const place = (index: number): BookmarkPosition => ({ key: all[index]?.key ?? null, id: all[index]?.bookmark.id ?? "" });

    const middle = await inTenant(tenant, (tx) => bookmarkRepository(tx).listWithCount(request(filter, 5, place(9)), 1000));
    const end = await inTenant(tenant, (tx) => bookmarkRepository(tx).listWithCount(request(filter, 5, place(39)), 1000));

    expect(middle.rows.map((row) => row.bookmark.id)).toEqual(all.slice(10, 15).map((row) => row.bookmark.id));
    expect(middle.count).toBe(40);
    expect(end).toEqual({ rows: [], count: 40 });
  });

  it.each([
    { name: "with a slug", filter: { hasSlug: true } },
    { name: "pinned", filter: { pinned: true } },
    { name: "forwarding", filter: { forwarding: true } },
    { name: "filed in a folder", filter: () => ({ folderId: world.folderId }) },
    { name: "carrying a tag", filter: () => ({ tagIds: [world.tagId] }) },
  ] as const)("count only the matches that are $name when the text has a filter beside it", async ({ filter }) => {
    const tenant = { accountId: world.alice, workspaceId: world.few };
    const narrow = { ownerId: world.alice, q: "widget", ...(typeof filter === "function" ? filter() : filter) };
    const apart = await inTenant(tenant, (tx) => bookmarkRepository(tx).count(narrow, 1000));

    const together = await inTenant(tenant, (tx) => bookmarkRepository(tx).listWithCount(request(narrow, 100), 1000));

    expect(apart).toBeGreaterThan(0);
    expect(apart).toBeLessThan(40);
    expect(together.count).toBe(apart);
    expect(together.rows).toHaveLength(apart);
  });

  it("count the matches of the account of the transaction only, whoever the filter names as the owner, and none for a blank text", async () => {
    const asAlice = { accountId: world.alice, workspaceId: world.few };

    expect(await inTenant(asAlice, (tx) => bookmarkRepository(tx).listWithCount(request({ ownerId: world.bob, q: "widget" }, 10), 100))).toEqual({ rows: [], count: 0 });
    expect(await inTenant(asAlice, (tx) => bookmarkRepository(tx).listWithCount(request({ ownerId: world.alice.toUpperCase(), q: "widget" }, 10), 100))).toMatchObject({ count: 40 });
    expect(await inTenant(asAlice, (tx) => bookmarkRepository(tx).listWithCount(request({ ownerId: world.alice, q: "  " }, 10), 100))).toEqual({ rows: [], count: 0 });
    expect(await inTenant({ accountId: world.bob, workspaceId: world.few }, (tx) => bookmarkRepository(tx).listWithCount(request({ ownerId: world.bob, q: "widget" }, 10), 100))).toMatchObject({ count: 1 });
  });

  it("refuse to read in a transaction opened without a workspace", async () => {
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).listWithCount(request({ ownerId: world.alice, q: "widget" }, 1), 10))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the bookmarks no list of a member may hold (T1, T2)", () => {
  it.each([
    { name: "few", workspace: () => world.few, text: "widget", word: "Widget", total: 40 },
    { name: "many", workspace: () => world.many, text: "gizmo", word: "Gizmo", total: MANY },
  ])("never lists, counts or names another member's, a plan-archived, an ownerless or another workspace's bookmark when the matches are $name", async ({ workspace, text, word, total }) => {
    const tenant = { accountId: world.alice, workspaceId: workspace() };
    const listed = await walk(tenant, "recent", { q: text }, BIG_PAGE);
    const titles = await asSystem(db, (tx) => tx<{ title: string }[]>`SELECT title FROM bookmarks WHERE id = ANY (${`{${listed.join(",")}}`}::uuid[])`);

    expect(listed).toHaveLength(total);
    expect(titles.map((row) => row.title)).not.toContain(`${word} of bob`);
    expect(titles.map((row) => row.title)).not.toContain(`${word} archived`);
    expect(titles.map((row) => row.title)).not.toContain(`${word} ownerless`);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: text }, 20_000))).toBe(total);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).ids({ ownerId: world.alice, q: text }, 20_000))).toHaveLength(total);
  });

  it("lists the matches of the workspace the transaction acts in, even for an account that holds matches in two", async () => {
    const inOther = await walk({ accountId: world.alice, workspaceId: world.other }, "recent", { q: "widget" }, 100);
    const inFew = await walk({ accountId: world.alice, workspaceId: world.few }, "recent", { q: "widget" }, 100);

    expect(inOther).toHaveLength(5);
    expect(inFew).toHaveLength(40);
    expect(inOther.filter((id) => inFew.includes(id))).toEqual([]);
  });

  it("lists nothing for the owner a filter names when that is not the account of the transaction", async () => {
    const asAlice = { accountId: world.alice, workspaceId: world.few };
    const rows = await inTenant(asAlice, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.bob, q: "widget" }, sort: "recent", after: undefined, limit: 10 }));

    expect(rows).toEqual([]);
    expect(await inTenant(asAlice, (tx) => bookmarkRepository(tx).count({ ownerId: world.bob, q: "widget" }, 100))).toBe(0);
    expect(await inTenant(asAlice, (tx) => bookmarkRepository(tx).ids({ ownerId: world.bob, q: "widget" }, 100))).toEqual([]);
  });

  it("lists to bob his own bookmark and not alice's", async () => {
    const asBob = { accountId: world.bob, workspaceId: world.few };
    const rows = await inTenant(asBob, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.bob, q: "widget" }, sort: "recent", after: undefined, limit: 100 }));

    expect(rows.map((row) => row.bookmark.title)).toEqual(["Widget of bob"]);
  });

  it("lists, counts and names nothing for a blank text, so a filter that lost its text never widens a list or a bulk action", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.few };

    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice, q: "" }, sort: "recent", after: undefined, limit: 10 }))).toEqual([]);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice, q: "   " }, sort: "recent", after: undefined, limit: 10 }))).toEqual([]);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "" }, 100))).toBe(0);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).ids({ ownerId: world.alice, q: "" }, 100))).toEqual([]);
  });

  it("refuses to list or count in a transaction opened without a workspace", async () => {
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice, q: "widget" }, sort: "recent", after: undefined, limit: 1 }))).rejects.toBeInstanceOf(TenantContextError);
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, q: "widget" }, 1))).rejects.toBeInstanceOf(TenantContextError);
  });

  it("never plans a list without a text for a filter that has one, so a text is never accepted and ignored", async () => {
    await expect(inTenant({ accountId: world.alice, workspaceId: world.few }, (tx) => Promise.resolve().then(() => listQuery(tx, { filter: { ownerId: world.alice, q: "widget" }, sort: "recent", after: undefined, limit: 1 })))).rejects.toThrow(/sys_bookmark_match/);
  });
});

describe("a list with a text and the bookmarks shared with the caller", () => {
  const request = (filter: BookmarkListFilter) => ({ filter, sort: "title_asc" as const, after: undefined, limit: 50 });

  async function sharedWorld() {
    const me = await account();
    const owner = await account();
    const w = await seedWorkspace(db, { name: "List search shared" });
    await seedMember(db, { workspaceId: w, accountId: me });
    await seedMember(db, { workspaceId: w, accountId: owner });
    const rows = await asSystem(
      db,
      (tx) => tx<{ id: string; owner_id: string }[]>`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        VALUES (${freshId()}, ${w}, ${me}, 'https://example.com/m', 'https://example.com/m', 'example.com', 'Zebra planner mine'),
               (${freshId()}, ${w}, ${owner}, 'https://example.com/s', 'https://example.com/s', 'example.com', 'Zebra planner shared'),
               (${freshId()}, ${w}, ${owner}, 'https://example.com/p', 'https://example.com/p', 'example.com', 'Zebra planner private')
        RETURNING id, owner_id`,
    );
    const own = rows.find((row) => row.owner_id === me)?.id ?? "";
    const [shared, unshared] = rows.filter((row) => row.owner_id === owner).map((row) => row.id);
    await shareBookmark(db, w, shared ?? "", owner, { accountId: me });
    return { me, workspaceId: w, own, shared: shared ?? "", unshared: unshared ?? "" };
  }

  it("lists and counts the shared matches in the scopes all and shared_with_me and only the caller's own in mine", async () => {
    const { me, workspaceId, own, shared, unshared } = await sharedWorld();
    const tenant = { accountId: me, workspaceId };
    const idsOf = async (scope?: "all" | "mine" | "shared_with_me") => {
      const filter: BookmarkListFilter = { ownerId: me, q: "zebra", ...(scope === undefined ? {} : { scope }) };
      const together = await inTenant(tenant, (tx) => bookmarkRepository(tx).listWithCount(request(filter), 100));
      const apart = await inTenant(tenant, (tx) => bookmarkRepository(tx).list(request(filter)));
      expect(together.rows.map((row) => row.bookmark.id)).toEqual(apart.map((row) => row.bookmark.id));
      expect(together.count).toBe(together.rows.length);
      expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).count(filter, 100))).toBe(together.count);
      return together.rows.map((row) => row.bookmark.id);
    };

    expect(await idsOf("all")).toEqual([own, shared]);
    expect(await idsOf("shared_with_me")).toEqual([shared]);
    expect(await idsOf("mine")).toEqual([own]);
    expect(await idsOf()).toEqual([own]);
    expect(await idsOf("all")).not.toContain(unshared);
  });

  it("keeps a list narrowed to the caller's folder, tags or pin to the caller's own bookmarks", async () => {
    const { me, workspaceId, own } = await sharedWorld();
    const tenant = { accountId: me, workspaceId };
    const folderId = freshId();
    await asSystem(db, async (tx) => {
      await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folderId}, ${workspaceId}, ${me}, 'Mine')`;
      await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${own})`;
    });
    const filter: BookmarkListFilter = { ownerId: me, q: "zebra", scope: "all", folderId };

    const page = await inTenant(tenant, (tx) => bookmarkRepository(tx).listWithCount(request(filter), 100));

    expect(page.rows.map((row) => row.bookmark.id)).toEqual([own]);
    expect(page.count).toBe(1);
  });
});
