import type { BookmarkListFilter, BookmarkPosition } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository } from "../src/index.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import { listQuery, pageStatement } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The page after a cursor of a sort by title (doc 04 section 6.1, doc 05 sections 2.4 and 4, doc 10 T1 and T2) is read by the system operation `sys_bookmark_title_page`, which runs as `slugbase_system` and so is not held to the
// policy of `bookmarks`. The failure scenarios: a page that returns a bookmark of another owner, of another workspace or one that is plan-archived, because the function reads the table without the policy and states its scope
// wrongly; a page that skips or repeats a bookmark at a page boundary because the function orders or compares the cursor otherwise than the list does (titles that differ in case only, titles that sort alike in
// no collation but are different strings, a title that is one space); and a call that answers rows where the settings of the transaction name no account or no workspace. The list of the scope `all` (the default of the route) reads
// its own bookmarks from the function and the bookmarks shared with the account from the grants: the failure scenarios there are a page that repeats or skips a bookmark where an own and a shared bookmark of one title meet at a page
// boundary, and a shared bookmark that is plan-archived, not shared with the account or of another workspace appearing in a page.

const HOOK_TIMEOUT_MS = 300_000;
const PAGE = 3;

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
  await seedAccount(db, { id, email: `title-page${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

function inTenant<T>(tenant: { accountId: string; workspaceId: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "bookmarks-title-page-test" }, work);
}

// A title is 1 to 300 characters (`bookmarks_title_check`), so the shortest title is one space. The rest repeat what a library holds: a title in three cases, accents, a character that lower-cases to two, characters a
// pattern would treat as wildcards, a title of the length limit, and digits and symbols that sort before and after the letters.
const TITLES = [
  "Alpha", "alpha", "ALPHA", "Alpha 1", "alpha 1", " ", "  two spaces", "_underscore", "100", "Zebra", "zebra", "Éclair", "eclair", "ÉCLAIR", "ß", "İstanbul", "日本語", "emoji 🎉", "a%b", "a_b", "a'b", "Ünïcode",
  "x".repeat(300), "Alpha", "alpha", "Mango", "mango", "MANGO", "mango 2",
] as const;

interface World {
  readonly w1: string;
  readonly w2: string;
  readonly alice: string;
  readonly bob: string;
  /** The bookmarks of alice in w1: the ones every page of her list holds. */
  readonly own: ReadonlySet<string>;
  readonly foreign: ReadonlySet<string>;
  /** The bookmarks of bob in w1 that are shared with alice: the ones the list of the scope `all` holds besides her own. */
  readonly shared: ReadonlySet<string>;
}

let world: World;

async function insert(rows: readonly { workspaceId: string; ownerId: string | null; title: string; archived?: boolean }[]): Promise<string[]> {
  const ids: string[] = [];
  await asSystem(db, async (tx) => {
    for (const row of rows) {
      const id = freshId();
      ids.push(id);
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
        VALUES (${id}, ${row.workspaceId}, ${row.ownerId}, 'https://example.com/title-page', 'https://example.com/title-page', 'example.com', ${row.title}, ${row.archived === true ? "2026-01-01T00:00:00Z" : null}::text::timestamptz)`;
    }
  });
  return ids;
}

beforeAll(async () => {
  const alice = await account();
  const bob = await account();
  const w1 = await seedWorkspace(db, { name: "Title page one" });
  const w2 = await seedWorkspace(db, { name: "Title page two" });
  await seedMember(db, { workspaceId: w1, accountId: alice, role: "owner" });
  await seedMember(db, { workspaceId: w1, accountId: bob });
  await seedMember(db, { workspaceId: w2, accountId: alice, role: "owner" });
  const own = await insert(TITLES.map((title) => ({ workspaceId: w1, ownerId: alice, title })));
  // Everything that shares the titles of alice's and is hers to read in no page of hers: another member's bookmarks, her bookmarks in another workspace, one plan-archived and one with no owner.
  const bobs = await insert(TITLES.map((title) => ({ workspaceId: w1, ownerId: bob, title })));
  const foreign = [
    ...bobs,
    ...(await insert(TITLES.map((title) => ({ workspaceId: w2, ownerId: alice, title })))),
    ...(await insert([
      { workspaceId: w1, ownerId: alice, title: "Archived", archived: true },
      { workspaceId: w1, ownerId: null, title: "Ownerless" },
    ])),
  ];
  // Bob shares every second bookmark of his with alice, and the one he has plan-archived; he shares nothing in w2 and none of the rest.
  const [archivedOfBob] = await insert([{ workspaceId: w1, ownerId: bob, title: "Archived by bob", archived: true }]);
  const shared = bobs.filter((_, index) => index % 2 === 0);
  await asSystem(db, async (tx) => {
    for (const bookmarkId of [...shared, archivedOfBob ?? ""]) {
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${w1}, ${bookmarkId}, ${alice}, ${bob})`;
    }
  });
  world = { w1, w2, alice, bob, own: new Set(own), foreign: new Set([...foreign, archivedOfBob ?? ""]), shared: new Set(shared) };
}, HOOK_TIMEOUT_MS);

const dialect = new PgDialect({ casing: "snake_case" });

/**
 * Reads every page of the list, `PAGE` at a time, each from the place the one before ended at: the ids in order, the statement of each page, and how many page boundaries fall between two bookmarks of one title
 * (the boundaries a cursor of the key alone would get wrong).
 */
async function walk(
  tenant: { accountId: string; workspaceId: string },
  sort: "title_asc" | "title_desc",
  filter: Omit<BookmarkListFilter, "ownerId"> = {},
): Promise<{ ids: string[]; statements: string[]; ties: number }> {
  const ids: string[] = [];
  const statements: string[] = [];
  let ties = 0;
  let after: BookmarkPosition | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const request = { filter: { ownerId: tenant.accountId, ...filter }, sort, after, limit: PAGE };
    statements.push(
      await inTenant(tenant, (tx) => {
        if (filter.scope === "all") {
          const statement = pageStatement(tx, request);
          return Promise.resolve(statement === undefined ? "" : dialect.sqlToQuery(statement).sql);
        }
        return Promise.resolve(listQuery(tx, request).toSQL().sql);
      }),
    );
    const rows = await inTenant(tenant, (tx) => bookmarkRepository(tx).list(request));
    if (rows[0] !== undefined && after !== undefined && rows[0].key === after.key) {
      ties += 1;
    }
    ids.push(...rows.map((row) => row.bookmark.id));
    const last = rows.at(-1);
    if (rows.length < PAGE || last === undefined) {
      return { ids, statements, ties };
    }
    after = { key: last.key, id: last.bookmark.id };
  }
  throw new Error("a list of a few dozen bookmarks did not end");
}

/** The ids in the order of the sort, from the table itself. */
async function reference(workspaceId: string, ownerId: string, sort: "title_asc" | "title_desc"): Promise<string[]> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ id: string }[]>`
      SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId} AND plan_archived_at IS NULL
      ORDER BY lower(title) ${sort === "title_asc" ? tx`ASC` : tx`DESC`}, id ${sort === "title_asc" ? tx`ASC` : tx`DESC`}`,
  );
  return rows.map((row) => row.id);
}

describe.each(["title_asc", "title_desc"] as const)("the pages of the list sorted by %s", (sort) => {
  it("read every bookmark exactly once in the order of the table, with the pages after the first read by the function", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.w1 };

    const { ids, statements } = await walk(tenant, sort);

    expect(ids).toEqual(await reference(world.w1, world.alice, sort));
    expect(new Set(ids).size).toBe(TITLES.length);
    expect(statements[0]).not.toContain("sys_bookmark_title_page");
    expect(statements.slice(1).every((statement) => statement.includes("sys_bookmark_title_page"))).toBe(true);
    expect(statements.length).toBeGreaterThan(5);
  });

  it("are the pages the statement of the table reads, for a filter that holds every bookmark and so is not read by the function", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.w1 };

    const viaFunction = await walk(tenant, sort);
    const viaTable = await walk(tenant, sort, { pinned: false });

    expect(viaTable.statements.every((statement) => !statement.includes("sys_bookmark_title_page"))).toBe(true);
    expect(viaFunction.ids).toEqual(viaTable.ids);
  });

  it("hold no bookmark of another owner, of another workspace, plan-archived or ownerless", async () => {
    const { ids } = await walk({ accountId: world.alice, workspaceId: world.w1 }, sort);

    expect(ids.filter((id) => world.foreign.has(id))).toEqual([]);
    expect(new Set(ids)).toEqual(world.own);
  });

  it("hold the bookmarks of the account of the transaction in the workspace of the transaction, for every member and workspace", async () => {
    for (const tenant of [
      { accountId: world.bob, workspaceId: world.w1 },
      { accountId: world.alice, workspaceId: world.w2 },
    ]) {
      const { ids } = await walk(tenant, sort);

      expect(ids).toEqual(await reference(tenant.workspaceId, tenant.accountId, sort));
      expect(ids).toHaveLength(TITLES.length);
      expect(ids.filter((id) => world.own.has(id))).toEqual([]);
    }
  });
});

/** The ids in the order of the sort of the bookmarks the list of the scope `all` holds for alice in w1, from the table itself: her own, and the ones shared with her. */
async function referenceAll(sort: "title_asc" | "title_desc"): Promise<string[]> {
  const shared = [...world.shared];
  const rows = await asSystem(
    db,
    (tx) => tx<{ id: string }[]>`
      SELECT id FROM bookmarks
      WHERE workspace_id = ${world.w1} AND plan_archived_at IS NULL AND (owner_id = ${world.alice} OR id = ANY(${shared}::uuid[]))
      ORDER BY lower(title) ${sort === "title_asc" ? tx`ASC` : tx`DESC`}, id ${sort === "title_asc" ? tx`ASC` : tx`DESC`}`,
  );
  return rows.map((row) => row.id);
}

describe.each(["title_asc", "title_desc"] as const)("the pages of the list of the scope all sorted by %s", (sort) => {
  const tenant = () => ({ accountId: world.alice, workspaceId: world.w1 });

  it("read every own and every shared bookmark exactly once in the order of the table, across page boundaries between bookmarks of one title", async () => {
    const { ids, ties } = await walk(tenant(), sort, { scope: "all" });
    const expected = await referenceAll(sort);

    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(TITLES.length + world.shared.size);
    expect(ids.filter((id) => world.own.has(id))).toHaveLength(TITLES.length);
    expect(ids.filter((id) => world.shared.has(id))).toHaveLength(world.shared.size);
    // Own and shared bookmarks share titles, and three bookmarks of a page are fewer than the bookmarks of one title.
    expect(ties).toBeGreaterThan(3);
  });

  it("are the pages the statements of the tables read, for a filter that holds every bookmark and so is not read by the function", async () => {
    const viaFunction = await walk(tenant(), sort, { scope: "all" });
    const viaTable = await walk(tenant(), sort, { scope: "all", pinned: false });

    expect(viaFunction.statements[0]).not.toContain("sys_bookmark_title_page");
    expect(viaFunction.statements.slice(1).every((statement) => statement.includes("sys_bookmark_title_page"))).toBe(true);
    expect(viaTable.statements.every((statement) => !statement.includes("sys_bookmark_title_page"))).toBe(true);
    expect(viaFunction.ids).toEqual(viaTable.ids);
  });

  it("hold nothing of another owner or workspace that is not shared with the account, nothing plan-archived and nothing ownerless", async () => {
    const { ids } = await walk(tenant(), sort, { scope: "all" });

    expect(ids.filter((id) => world.foreign.has(id) && !world.shared.has(id))).toEqual([]);
    expect(new Set(ids)).toEqual(new Set([...world.own, ...world.shared]));
  });

  it("hold, for the member who shares with no one, only the bookmarks of their own", async () => {
    const { ids } = await walk({ accountId: world.bob, workspaceId: world.w1 }, sort, { scope: "all" });

    expect(ids).toEqual(await reference(world.w1, world.bob, sort));
  });
});

describe("a page of the scope all that the function does not read", () => {
  it("is read by the statements of the tables for each filter beyond the scope, and for a page with no cursor", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.w1 };
    const [first] = await inTenant(tenant, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice, scope: "all" }, sort: "title_asc", after: undefined, limit: 1 }));
    const after = { key: first?.key ?? null, id: first?.bookmark.id ?? "" };
    const statementOf = async (filter: Omit<BookmarkListFilter, "ownerId">, cursor: BookmarkPosition | undefined) => {
      const statement = await inTenant(tenant, (tx) => Promise.resolve(pageStatement(tx, { filter: { ownerId: world.alice, ...filter }, sort: "title_asc", after: cursor, limit: PAGE })));
      return statement === undefined ? "" : dialect.sqlToQuery(statement).sql;
    };

    expect(await statementOf({ scope: "all" }, after)).toContain("sys_bookmark_title_page");
    expect(await statementOf({ scope: "all" }, undefined)).not.toContain("sys_bookmark_title_page");
    for (const filter of [{ pinned: true }, { hasSlug: true }, { forwarding: false }, { urlCanonical: "https://example.com/title-page" }, { folderId: freshId() }, { tagIds: [freshId()] }]) {
      expect(await statementOf({ scope: "all", ...filter }, after), JSON.stringify(filter)).not.toContain("sys_bookmark_title_page");
    }
    expect(await statementOf({ scope: "shared_with_me" }, after)).not.toContain("sys_bookmark_title_page");
    expect(await statementOf({ scope: "shared_by_me" }, after)).not.toContain("sys_bookmark_title_page");
  });
});

describe("a page of no rows", () => {
  it("is read by the statement of the table and answers no rows, as it did before the function", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.w1 };
    const [first] = await inTenant(tenant, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: world.alice }, sort: "title_asc", after: undefined, limit: 1 }));
    const request = { filter: { ownerId: world.alice }, sort: "title_asc" as const, after: { key: first?.key ?? null, id: first?.bookmark.id ?? "" }, limit: 0 };

    expect(await inTenant(tenant, (tx) => Promise.resolve(listQuery(tx, request).toSQL().sql))).not.toContain("sys_bookmark_title_page");
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).list(request))).toEqual([]);
  });
});

describe("sys_bookmark_title_page", () => {
  const AFTER = { key: "alpha", id: "00000000-0000-7000-8000-000000000000" };

  /** Calls the function as `slugbase_app` with the settings given, which `withTenant` would set for a request. */
  async function call(settings: { accountId?: string; workspaceId?: string }, args: { descending?: boolean; key?: string | null; id?: string | null; limit?: number | null } = {}): Promise<{ id: string; title: string }[]> {
    return db.app.begin(async (tx) => {
      if (settings.accountId !== undefined) {
        await tx`SELECT set_config('app.account_id', ${settings.accountId}, true)`;
      }
      if (settings.workspaceId !== undefined) {
        await tx`SELECT set_config('app.workspace_id', ${settings.workspaceId}, true)`;
      }
      const { descending = false, key = AFTER.key, id = AFTER.id, limit = 100 } = args;
      return tx<{ id: string; title: string }[]>`SELECT id, title FROM sys_bookmark_title_page(${descending}, ${key}, ${id}::uuid, ${limit})`;
    });
  }

  /** The rows after `AFTER` for the account and the workspace, from the table itself, in the order of the sort. */
  async function expected(tenant: { accountId: string; workspaceId: string }, descending: boolean, limit: number): Promise<string[]> {
    const rows = await asSystem(
      db,
      (tx) => tx<{ id: string }[]>`
        SELECT id FROM bookmarks
        WHERE workspace_id = ${tenant.workspaceId} AND owner_id = ${tenant.accountId} AND plan_archived_at IS NULL
          AND ${descending ? tx`(lower(title), id) < (${AFTER.key}::text, ${AFTER.id}::uuid)` : tx`(lower(title), id) > (${AFTER.key}::text, ${AFTER.id}::uuid)`}
        ORDER BY lower(title) ${descending ? tx`DESC` : tx`ASC`}, id ${descending ? tx`DESC` : tx`ASC`} LIMIT ${limit}`,
    );
    return rows.map((row) => row.id);
  }

  it("answers the rows of the account and the workspace of the transaction after the place given, and nothing of any other", async () => {
    for (const tenant of [
      { accountId: world.alice, workspaceId: world.w1 },
      { accountId: world.alice, workspaceId: world.w2 },
      { accountId: world.bob, workspaceId: world.w1 },
    ]) {
      const rows = (await call(tenant)).map((row) => row.id);

      expect(rows.length).toBeGreaterThan(10);
      expect(rows).toEqual(await expected(tenant, false, 100));
    }
    expect((await call({ accountId: world.alice, workspaceId: world.w1 })).every((row) => world.own.has(row.id))).toBe(true);
  });

  it("answers nothing where the transaction names no account, no workspace or neither", async () => {
    expect(await call({ workspaceId: world.w1 })).toEqual([]);
    expect(await call({ accountId: world.alice })).toEqual([]);
    expect(await call({})).toEqual([]);
  });

  it("cuts the answer at the limit in the order of the sort, ascending or descending", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.w1 };

    expect((await call(tenant, { limit: 4 })).map((row) => row.id)).toEqual(await expected(tenant, false, 4));
    expect((await call(tenant, { descending: true, limit: 4 })).map((row) => row.id)).toEqual(await expected(tenant, true, 4));
    expect(await expected(tenant, true, 4)).toHaveLength(4);
  });

  it.each([
    ["a missing key", { key: null }],
    ["a missing identifier", { id: null }],
    ["a missing limit", { limit: null }],
    ["a limit of none", { limit: 0 }],
  ] as const)("refuses %s rather than answering a page that is not the one asked for", async (_name, args) => {
    await expect(call({ accountId: world.alice, workspaceId: world.w1 }, args)).rejects.toMatchObject({ code: "22023" });
  });

  it("is executable by slugbase_app and by no one else", async () => {
    const [row] = await db.owner<{ app: boolean; anon: boolean; owner: string }[]>`
      SELECT has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS anon, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p WHERE p.oid = 'public.sys_bookmark_title_page(boolean, text, uuid, integer)'::regprocedure`;

    expect(row).toEqual({ app: true, anon: false, owner: "slugbase_system" });
  });
});
