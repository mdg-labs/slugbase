import type { ArchivedBookmarkPosition } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Listing the plan-archived bookmarks of a member (doc 02 section 5.6, doc 04 section 6.1, doc 05 section 2.2, doc 10 T1 and T2). The failure scenarios: a bookmark that is not
// archived, another member's archived bookmark or one of another workspace that appears in a page or in the count; a page that resumes at a place the database ordered
// differently, so that bookmarks archived in the same instant are skipped or shown twice; and a caller that names whose archived bookmarks are read.

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
  await seedAccount(db, { id, email: `bookmarks-archived${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "bookmarks-archived-test" }, work);
}

interface Seed {
  readonly workspaceId: string;
  readonly ownerId: string | null;
  readonly title: string;
  /** The instant the bookmark was archived, as text with the precision the database keeps; not archived when left out. */
  readonly archivedAt?: string;
}

async function seed(rows: readonly Seed[]): Promise<string[]> {
  const ids: string[] = [];
  await asSystem(db, async (tx) => {
    for (const row of rows) {
      const id = freshId();
      ids.push(id);
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
        VALUES (${id}, ${row.workspaceId}, ${row.ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', ${row.title}, ${row.archivedAt ?? null}::text::timestamptz)`;
    }
  });
  return ids;
}

/** The ids of the archived bookmarks of the owner, from the table itself, newest archived first and the identifier as the tiebreak. */
async function reference(workspaceId: string, ownerId: string): Promise<string[]> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId} AND plan_archived_at IS NOT NULL ORDER BY plan_archived_at DESC, id DESC`,
  );
  return rows.map((row) => row.id);
}

/** Reads every page, `PAGE` at a time, each from the place the one before ended at; the ids in the order they came. */
async function walk(tenant: { accountId: string; workspaceId: string }): Promise<string[]> {
  const seen: string[] = [];
  let after: ArchivedBookmarkPosition | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    const rows = await inTenant(tenant, (tx) => bookmarkRepository(tx).listArchived({ after, limit: PAGE }));
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
  readonly carol: string;
  readonly aliceArchived: readonly string[];
  readonly bobArchived: readonly string[];
  readonly aliceLive: readonly string[];
  readonly aliceOther: readonly string[];
}

let world: World;

beforeAll(async () => {
  const alice = await account();
  const bob = await account();
  const carol = await account();
  const main = await seedWorkspace(db, { name: "Archived main" });
  const other = await seedWorkspace(db, { name: "Archived other" });
  await seedMember(db, { workspaceId: main, accountId: alice, role: "owner" });
  await seedMember(db, { workspaceId: main, accountId: bob });
  await seedMember(db, { workspaceId: main, accountId: carol });
  await seedMember(db, { workspaceId: other, accountId: alice, role: "owner" });
  // Ties on purpose: the same instant in groups of three, down to the microsecond the database keeps, so a keyset that compared the instant as a date (milliseconds) or alone would skip or repeat a row at a page boundary.
  const mine: Seed[] = [];
  for (let n = 0; n < 14; n += 1) {
    mine.push({ workspaceId: main, ownerId: alice, title: `Mine ${String(n)}`, archivedAt: `2026-03-01T10:00:${String(Math.floor(n / 3)).padStart(2, "0")}.123456Z` });
  }
  const bobs: Seed[] = Array.from({ length: 5 }, (_, n) => ({ workspaceId: main, ownerId: bob, title: `Bob ${String(n)}`, archivedAt: `2026-03-05T10:00:0${String(n)}Z` }));
  const live: Seed[] = Array.from({ length: 3 }, (_, n) => ({ workspaceId: main, ownerId: alice, title: `Live ${String(n)}` }));
  const elsewhere: Seed[] = Array.from({ length: 3 }, (_, n) => ({ workspaceId: other, ownerId: alice, title: `Elsewhere ${String(n)}`, archivedAt: `2026-03-09T10:00:0${String(n)}Z` }));
  const ownerless: Seed[] = [{ workspaceId: main, ownerId: null, title: "Ownerless", archivedAt: "2026-03-10T10:00:00Z" }];
  const ids = await seed([...mine, ...bobs, ...live, ...elsewhere, ...ownerless]);
  world = {
    main,
    other,
    alice,
    bob,
    carol,
    aliceArchived: ids.slice(0, 14),
    bobArchived: ids.slice(14, 19),
    aliceLive: ids.slice(19, 22),
    aliceOther: ids.slice(22, 25),
  };
}, HOOK_TIMEOUT_MS);

describe("listing the archived bookmarks of the account of the transaction", () => {
  it("lists the account's own archived bookmarks only, never a live one, another member's, another workspace's or one without an owner, newest archived first", async () => {
    const listed = await walk({ accountId: world.alice, workspaceId: world.main });

    expect(listed).toEqual(await reference(world.main, world.alice));
    expect(new Set(listed)).toEqual(new Set(world.aliceArchived));
    for (const id of [...world.bobArchived, ...world.aliceLive, ...world.aliceOther]) {
      expect(listed).not.toContain(id);
    }
    expect(await walk({ accountId: world.bob, workspaceId: world.main })).toEqual(await reference(world.main, world.bob));
    expect(new Set(await walk({ accountId: world.alice, workspaceId: world.other }))).toEqual(new Set(world.aliceOther));
  });

  it("reads each bookmark exactly once when many were archived in the same instant, with the instant as the database keeps it", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.main };
    const listed = await walk(tenant);
    const [first] = await inTenant(tenant, (tx) => bookmarkRepository(tx).listArchived({ after: undefined, limit: 1 }));

    expect(new Set(listed).size).toBe(14);
    expect(first?.key).toBe("2026-03-01 10:00:04.123456+00");
    expect(first?.archivedAt.toISOString()).toBe("2026-03-01T10:00:04.123Z");
    expect(first?.bookmark).toMatchObject({ ownerId: world.alice, title: expect.stringMatching(/^Mine /) as string, folders: [], tags: [], owner: null, sharedVia: null });
  });

  it("counts the same bookmarks, exactly up to the limit it is asked for", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.main };

    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).countArchived(1000))).toBe(14);
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).countArchived(5))).toBe(5);
    expect(await inTenant({ accountId: world.bob, workspaceId: world.main }, (tx) => bookmarkRepository(tx).countArchived(1000))).toBe(5);
    expect(await inTenant({ accountId: world.carol, workspaceId: world.main }, (tx) => bookmarkRepository(tx).countArchived(1000))).toBe(0);
    expect(await inTenant({ accountId: world.carol, workspaceId: world.main }, (tx) => bookmarkRepository(tx).listArchived({ after: undefined, limit: PAGE }))).toEqual([]);
  });

  it("lists nothing in a workspace the account is no member of, and reads nothing without a workspace", async () => {
    const stranger = await account();

    expect(await inTenant({ accountId: stranger, workspaceId: world.main }, (tx) => bookmarkRepository(tx).listArchived({ after: undefined, limit: PAGE }))).toEqual([]);
    expect(await inTenant({ accountId: stranger, workspaceId: world.main }, (tx) => bookmarkRepository(tx).countArchived(1000))).toBe(0);
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).listArchived({ after: undefined, limit: PAGE }))).rejects.toBeInstanceOf(TenantContextError);
    await expect(inTenant({ accountId: world.alice }, (tx) => bookmarkRepository(tx).countArchived(1000))).rejects.toBeInstanceOf(TenantContextError);
  });

  it("leaves a place that names another member's bookmark with no effect on whose bookmarks are read", async () => {
    const tenant = { accountId: world.alice, workspaceId: world.main };
    const [bobsFirst] = await inTenant({ accountId: world.bob, workspaceId: world.main }, (tx) => bookmarkRepository(tx).listArchived({ after: undefined, limit: 1 }));
    if (bobsFirst === undefined) {
      throw new Error("bob has archived bookmarks");
    }

    const rows = await inTenant(tenant, (tx) => bookmarkRepository(tx).listArchived({ after: { key: "2100-01-01 00:00:00+00", id: bobsFirst.bookmark.id }, limit: 100 }));

    expect(new Set(rows.map((row) => row.bookmark.id))).toEqual(new Set(world.aliceArchived));
  });
});
