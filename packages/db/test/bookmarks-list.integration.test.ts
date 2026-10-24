import { BOOKMARK_SORTS, type BookmarkListFilter, type BookmarkPosition, type BookmarkSort } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Listing the bookmarks of a member (doc 04 section 6.1, doc 05 section 2.4, doc 10 T1 and T2). The failure scenarios: a page that
// resumes at a key the database ordered differently, so a bookmark that shares its sort key with the last one of the page before is
// skipped or shown twice; a never-opened bookmark that sorts among the opened ones; a bookmark of another owner, of another workspace
// or one that is plan-archived that appears in a page or in the count; and a count that reads the whole library.

const HOOK_TIMEOUT_MS = 300_000;
const PAGE = 4;

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
  await seedAccount(db, { id, email: `bookmarks-list${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "bookmarks-list-test" }, work);
}

interface Seed {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly openCount?: number;
  readonly lastOpenedAt?: string | null;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly canonical?: string;
}

async function seed(rows: readonly Seed[]): Promise<string[]> {
  const ids: string[] = [];
  await asSystem(db, async (tx) => {
    for (const row of rows) {
      const id = freshId();
      ids.push(id);
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, plan_archived_at, open_count, last_opened_at, created_at)
        VALUES (${id}, ${row.workspaceId}, ${row.ownerId}, ${row.canonical ?? "https://example.com/seed"}, ${row.canonical ?? "https://example.com/seed"}, 'example.com',
                ${row.title}, ${row.slug ?? null}, ${row.forwarding ?? false}, ${row.pinned === true ? "2026-01-01T00:00:00Z" : null},
                ${row.archived === true ? "2026-01-01T00:00:00Z" : null}, ${row.openCount ?? 0}, ${row.lastOpenedAt ?? null}::text::timestamptz, ${row.createdAt}::text::timestamptz)`;
    }
  });
  return ids;
}

const ORDER_BY: Readonly<Record<BookmarkSort, string>> = {
  recent: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  title_asc: "lower(title) ASC, id ASC",
  title_desc: "lower(title) DESC, id DESC",
  most_used: "open_count DESC, id DESC",
  recently_opened: "last_opened_at DESC NULLS LAST, id DESC",
};

/** The ids in the order of the sort, from the table itself, for the filter given as SQL. */
async function reference(workspaceId: string, ownerId: string, sort: BookmarkSort, where = "true"): Promise<string[]> {
  const rows = await asSystem(
    db,
    (tx) => tx.unsafe<{ id: string }[]>(
      `SELECT id FROM bookmarks WHERE workspace_id = $1 AND owner_id = $2 AND plan_archived_at IS NULL AND ${where} ORDER BY ${ORDER_BY[sort]}`,
      [workspaceId, ownerId],
    ),
  );
  return rows.map((row) => row.id);
}

/** Reads every page of the list, `PAGE` at a time, each from the place the one before ended at; the ids in the order they came. */
async function walk(tenant: { accountId: string; workspaceId: string }, sort: BookmarkSort, filter: Omit<BookmarkListFilter, "ownerId"> = {}): Promise<string[]> {
  const seen: string[] = [];
  let after: BookmarkPosition | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const rows = await inTenant(tenant, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: tenant.accountId, ...filter }, sort, after, limit: PAGE }));
    seen.push(...rows.map((row) => row.bookmark.id));
    const last = rows.at(-1);
    if (rows.length < PAGE || last === undefined) {
      return seen;
    }
    after = { key: last.key, id: last.bookmark.id };
  }
  throw new Error("a list of a few dozen bookmarks did not end");
}

interface World {
  readonly main: string;
  readonly other: string;
  readonly alice: string;
  readonly bob: string;
  readonly aliceIds: readonly string[];
}

let world: World;

beforeAll(async () => {
  const alice = await account();
  const bob = await account();
  const main = await seedWorkspace(db, { name: "List main" });
  const other = await seedWorkspace(db, { name: "List other" });
  await seedMember(db, { workspaceId: main, accountId: alice, role: "owner" });
  await seedMember(db, { workspaceId: main, accountId: bob });
  await seedMember(db, { workspaceId: other, accountId: alice, role: "owner" });
  // Ties on purpose: the same created_at in groups of three, the same open_count and titles that differ in case only, so a keyset that
  // compared the key alone, or compared it in another collation than it sorted by, would skip or repeat a row at a page boundary.
  const rows: Seed[] = [];
  for (let n = 0; n < 30; n += 1) {
    rows.push({
      workspaceId: main,
      ownerId: alice,
      title: n % 2 === 0 ? `Alpha ${String(n % 5)}` : `alpha ${String(n % 5)}`,
      createdAt: `2026-03-01T10:00:${String(Math.floor(n / 3)).padStart(2, "0")}.123456Z`,
      openCount: n % 4,
      lastOpenedAt: n % 3 === 0 ? null : `2026-03-02T10:00:${String(Math.floor(n / 4)).padStart(2, "0")}.654321Z`,
      slug: n % 5 === 0 ? `slug-${String(n)}` : null,
      forwarding: n % 10 === 0,
      pinned: n % 6 === 0,
      canonical: n % 7 === 0 ? "https://dup.example/page" : `https://example.com/${String(n)}`,
    });
  }
  rows.push({ workspaceId: main, ownerId: alice, title: "Archived", createdAt: "2026-03-01T10:00:00Z", archived: true, openCount: 99, lastOpenedAt: "2026-04-01T00:00:00Z", pinned: true });
  rows.push({ workspaceId: main, ownerId: bob, title: "Bob's", createdAt: "2026-03-01T10:00:00Z", openCount: 99, lastOpenedAt: "2026-04-01T00:00:00Z", pinned: true });
  rows.push({ workspaceId: other, ownerId: alice, title: "In the other workspace", createdAt: "2026-03-01T10:00:00Z", openCount: 99, lastOpenedAt: "2026-04-01T00:00:00Z", pinned: true });
  const ids = await seed(rows);
  world = { main, other, alice, bob, aliceIds: ids.slice(0, 30) };
}, HOOK_TIMEOUT_MS);

describe("paging", () => {
  it.each(BOOKMARK_SORTS)("reads every bookmark exactly once, in the order of the database, when the sort is %s", async (sort) => {
    const pages = await walk({ accountId: world.alice, workspaceId: world.main }, sort);

    expect(pages).toEqual(await reference(world.main, world.alice, sort));
    expect(new Set(pages).size).toBe(30);
  });

  it("puts a bookmark that was never opened after every opened one, however the opened ones are paged", async () => {
    const pages = await walk({ accountId: world.alice, workspaceId: world.main }, "recently_opened");
    const opened = await asSystem(db, (tx) => tx<{ id: string; last_opened_at: Date | null }[]>`SELECT id, last_opened_at FROM bookmarks WHERE workspace_id = ${world.main} AND owner_id = ${world.alice}`);
    const never = new Set(opened.filter((row) => row.last_opened_at === null).map((row) => row.id));

    expect(never.size).toBe(10);
    expect(pages.slice(0, 20).some((id) => never.has(id))).toBe(false);
    expect(pages.slice(20).every((id) => never.has(id))).toBe(true);
  });

  it("gives each bookmark its sort key as text with the precision the database keeps", async () => {
    const [first] = await inTenant({ accountId: world.alice, workspaceId: world.main }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice }, sort: "recent", after: undefined, limit: 1 }));

    expect(first?.key).toMatch(/^2026-03-01 10:00:09\.123456\+00$/);
  });
});

describe("filters", () => {
  const cases: readonly { name: string; filter: Omit<BookmarkListFilter, "ownerId">; where: string }[] = [
    { name: "pinned only", filter: { pinned: true }, where: "pinned_at IS NOT NULL" },
    { name: "unpinned only", filter: { pinned: false }, where: "pinned_at IS NULL" },
    { name: "with a slug", filter: { hasSlug: true }, where: "slug IS NOT NULL" },
    { name: "without a slug", filter: { hasSlug: false }, where: "slug IS NULL" },
    { name: "forwarding", filter: { forwarding: true }, where: "forwarding" },
    { name: "not forwarding", filter: { forwarding: false }, where: "NOT forwarding" },
    { name: "of a canonical URL", filter: { urlCanonical: "https://dup.example/page" }, where: "url_canonical = 'https://dup.example/page'" },
    { name: "pinned with a slug and forwarding", filter: { pinned: true, hasSlug: true, forwarding: true }, where: "pinned_at IS NOT NULL AND slug IS NOT NULL AND forwarding" },
  ];

  it.each(cases)("lists the bookmarks that are $name, paged by every sort, and counts them", async ({ filter, where }) => {
    for (const sort of BOOKMARK_SORTS) {
      expect(await walk({ accountId: world.alice, workspaceId: world.main }, sort, filter)).toEqual(await reference(world.main, world.alice, sort, where));
    }
    const expected = (await reference(world.main, world.alice, "recent", where)).length;
    expect(expected).toBeGreaterThan(0);

    expect(await inTenant({ accountId: world.alice, workspaceId: world.main }, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, ...filter }, 1000))).toBe(expected);
  });

  it("never lists a plan-archived bookmark, another owner's bookmark or a bookmark of another workspace, and does not count them", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.main };
    const everything = await walk(tenant, "most_used");

    expect(everything).toHaveLength(30);
    expect(new Set(everything)).toEqual(new Set(world.aliceIds));
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice }, 1000))).toBe(30);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice, pinned: true }, 1000))).toBe(5);
  });

  it("counts no further than the limit it is given", async () => {
    expect(await inTenant({ accountId: world.alice, workspaceId: world.main }, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice }, 7))).toBe(7);
  });
});

describe("the workspace and the owner of the transaction", () => {
  it("lists the bookmarks of the workspace the transaction acts in, even for an account that holds bookmarks in two", async () => {
    const inOther = await walk({ accountId: world.alice, workspaceId: world.other }, "recent");

    expect(inOther).toHaveLength(1);
    expect(inOther).not.toContainEqual(expect.stringMatching(new RegExp(world.aliceIds.join("|"))));
  });

  it("lists the bookmarks of the owner the filter names, and of no one else", async () => {
    const rows = await inTenant({ accountId: world.alice, workspaceId: world.main }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.bob }, sort: "recent", after: undefined, limit: 10 }));

    expect(rows.map((row) => row.bookmark.ownerId)).toEqual([world.bob]);
  });

  it("lists nothing for a member of the workspace of the transaction who owns no bookmark there", async () => {
    const rows = await inTenant({ accountId: world.alice, workspaceId: world.other }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.bob }, sort: "recent", after: undefined, limit: 10 }));

    expect(rows).toEqual([]);
  });

  it("refuses to list or count in a transaction opened without a workspace", async () => {
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice }, sort: "recent", after: undefined, limit: 1 }))).rejects.toBeInstanceOf(TenantContextError);
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).count({ ownerId: world.alice }, 1))).rejects.toBeInstanceOf(TenantContextError);
  });
});
