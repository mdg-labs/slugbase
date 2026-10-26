import type { BookmarkTagName, NewBookmark } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, listRepositoryMethods, tagRepository } from "../src/index.ts";
import { tagsOfBookmarksQuery } from "../src/repositories/tag-links.ts";
import { listQuery } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Tagging bookmarks (doc 05 section 2.4, doc 02 sections 7.2 and 8.2, doc 13 Q22, doc 10 T1 and T2). The failure scenario: member B names member A's tag
// on B's own bookmark, through the repository and with the application layer left out, and nothing is tagged: the repository answers `tag_not_found`, the
// policies of `bookmark_tags` refuse the statement, B's tags never hold A's, and a read of `bookmark_tags` as B returns no link of A's. Besides that: a
// request that names one tag too many tags none, a bookmark carries the tags its creation and its change name (a name the owner has no tag of creates
// one, in any case), a bookmark shows its caller's tags only, the counts of the tags count the caller's links only, and a list can be narrowed to the
// bookmarks that carry every one of several tags of the caller's.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";

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
  await seedAccount(db, { id, email: `tagging${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(members: readonly string[]): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Tagging test" });
  for (const [index, accountId] of members.entries()) {
    await seedMember(db, { workspaceId: id, accountId, role: index === 0 ? "owner" : "member" });
  }
  return { id, members };
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "tagging-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

async function seedTag(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function seedBookmark(workspaceId: string, ownerId: string, archived = false): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed', ${archived ? new Date() : null})`,
  );
  return id;
}

async function link(workspaceId: string, bookmarkId: string, tagId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`);
}

async function linksOf(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ link: string }[]>`SELECT bookmark_id || '/' || tag_id AS link FROM bookmark_tags WHERE workspace_id = ${workspaceId} ORDER BY 1`);
  return rows.map((row) => row.link);
}

async function tagNamesOf(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ name: string }[]>`SELECT name::text AS name FROM tags WHERE workspace_id = ${workspaceId} ORDER BY lower(name::text)`);
  return rows.map((row) => row.name);
}

function newBookmark(ownerId: string, title = "Tagged"): NewBookmark {
  return { id: freshId(), ownerId, url: "https://example.com/tagged", urlCanonical: "https://example.com/tagged", host: "example.com", title, description: null, pinned: false };
}

function named(...names: string[]): BookmarkTagName[] {
  return names.map((name) => ({ name, newId: freshId() }));
}

describe("the failure scenario: member B tags with member A's tag (T1, T2)", () => {
  it("answers tag_not_found when B puts A's tag on B's own bookmark, and neither a link nor a tag nor a version moves", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const tagOfA = await seedTag(workspace.id, a, "Of A");
    const ownTagOfB = await seedTag(workspace.id, b, "Of B");
    const bookmarkOfB = await seedBookmark(workspace.id, b);
    const asB = { accountId: b, workspaceId: workspace.id };
    const update = (tags: { ids: string[]; names: BookmarkTagName[] }) =>
      inTenant(asB, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmarkOfB, ownerId: b, changes: { title: "Changed", tags }, expectedVersions: undefined }));

    expect(await update({ ids: [tagOfA], names: [] })).toEqual({ kind: "tag_not_found" });
    expect(await update({ ids: [ownTagOfB, tagOfA], names: named("Brand new") })).toEqual({ kind: "tag_not_found" });

    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await tagNamesOf(workspace.id)).toEqual(["Of A", "Of B"]);
    const read = await inTenant(asB, (tx) => bookmarkRepository(tx).find(bookmarkOfB));
    expect(read).toMatchObject({ title: "Seed", version: 1, tags: [] });
    // B's list of tags never holds A's, and a read of the links as B returns none of A's.
    expect((await inTenant(asB, (tx) => tagRepository(tx).list({ ownerId: b, sort: "name", after: undefined, limit: 10 }))).map((tag) => tag.id)).toEqual([ownTagOfB]);
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    await link(workspace.id, bookmarkOfA, tagOfA);
    expect(await appAs(asB, (tx) => tx`SELECT bookmark_id, tag_id FROM bookmark_tags`)).toHaveLength(0);
    expect(await appAs({ accountId: a, workspaceId: workspace.id }, (tx) => tx`SELECT bookmark_id, tag_id FROM bookmark_tags`)).toHaveLength(1);
  });

  it("creates no bookmark, takes no place under the ceiling and creates no tag when a creation names A's tag", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const other = await workspaceOf([b]);
    const tagOfA = await seedTag(workspace.id, a, "Of A");
    const own = await seedTag(workspace.id, b, "Own");
    const asB = { accountId: b, workspaceId: workspace.id };

    for (const foreign of [tagOfA, await seedTag(other.id, b, "Elsewhere"), freshId()]) {
      const bookmark = newBookmark(b);
      expect(await inTenant(asB, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: 5, jobs: [], tags: { ids: [own, foreign], names: named("Brand new") } }))).toEqual({ kind: "tag_not_found" });
    }

    expect(await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${workspace.id}`)).toEqual([{ n: 0 }]);
    expect(await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT bookmark_count AS n FROM workspaces WHERE id = ${workspace.id}`)).toEqual([{ n: 0 }]);
    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await tagNamesOf(workspace.id)).toEqual(["Of A", "Own"]);
  });

  it("refuses the same statements with the application layer left out: the policies of bookmark_tags stand alone", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const other = await workspaceOf([a]);
    const tagOfA = await seedTag(workspace.id, a, "Of A");
    const tagOfB = await seedTag(workspace.id, b, "Of B");
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    const bookmarkOfB = await seedBookmark(workspace.id, b);
    const tagElsewhere = await seedTag(other.id, a, "Elsewhere");
    const bookmarkElsewhere = await seedBookmark(other.id, a);
    const asB = { accountId: b, workspaceId: workspace.id };
    const asA = { accountId: a, workspaceId: workspace.id };
    const insert = (as: { accountId: string; workspaceId: string }, workspaceId: string, bookmarkId: string, tagId: string) =>
      appAs(as, (tx) => tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`);

    // B's own bookmark with A's tag, A's bookmark with B's tag, and the mix the other way round.
    expect(await refusedWith(insert(asB, workspace.id, bookmarkOfB, tagOfA))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(asB, workspace.id, bookmarkOfA, tagOfB))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(asA, workspace.id, bookmarkOfB, tagOfA))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(asA, workspace.id, bookmarkOfA, tagOfB))).toBe(INSUFFICIENT_PRIVILEGE);
    // The workspace of the row is not the active one.
    expect(await refusedWith(insert(asA, other.id, bookmarkElsewhere, tagElsewhere))).toBe(INSUFFICIENT_PRIVILEGE);
    // The row names the active workspace but a tag or a bookmark that is in another: the policy cannot see it.
    expect(await refusedWith(insert(asA, workspace.id, bookmarkOfA, tagElsewhere))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(asA, workspace.id, bookmarkElsewhere, tagOfA))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await linksOf(other.id)).toEqual([]);

    await insert(asA, workspace.id, bookmarkOfA, tagOfA);
    expect(await linksOf(workspace.id)).toEqual([`${bookmarkOfA}/${tagOfA}`]);
  });

  it("lets another member delete none of a member's links, and refuses to update one", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const tagOfA = await seedTag(workspace.id, a, "Of A");
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    await link(workspace.id, bookmarkOfA, tagOfA);

    const asB = { accountId: b, workspaceId: workspace.id };
    expect(await appAs(asB, (tx) => tx`DELETE FROM bookmark_tags WHERE tag_id = ${tagOfA} RETURNING tag_id`)).toHaveLength(0);
    expect(await linksOf(workspace.id)).toEqual([`${bookmarkOfA}/${tagOfA}`]);

    const asA = { accountId: a, workspaceId: workspace.id };
    expect(await refusedWith(appAs(asA, (tx) => tx`UPDATE bookmark_tags SET tag_id = tag_id`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await appAs(asA, (tx) => tx`DELETE FROM bookmark_tags WHERE tag_id = ${tagOfA} RETURNING tag_id`)).toHaveLength(1);
    expect(await linksOf(workspace.id)).toEqual([]);
  });
});

describe("the scoped repository of the links, as the cross-tenant matrix runs it", () => {
  function method(name: "select" | "insert" | "delete") {
    const found = listRepositoryMethods().find((entry) => entry.repository === "bookmark_tags" && entry.method === name);
    if (found === undefined) {
      throw new Error(`the registry has no bookmark_tags.${name}`);
    }
    return found;
  }

  it("is in the registry with the methods the application role may run, and reads a link back by its composite key", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const tag = await seedTag(workspace.id, a, "Matrix");
    const bookmark = await seedBookmark(workspace.id, a);
    const as = { accountId: a, workspaceId: workspace.id };

    const inserted = await inTenant(as, (tx) => method("insert").invoke(tx, { values: { bookmarkId: bookmark, tagId: tag } }));

    expect(listRepositoryMethods().filter((entry) => entry.repository === "bookmark_tags").map((entry) => entry.method)).toEqual(["select", "insert", "delete"]);
    expect(inserted).toMatchObject([{ workspaceId: workspace.id, bookmarkId: bookmark, tagId: tag }]);
    expect(await linksOf(workspace.id)).toEqual([`${bookmark}/${tag}`]);
  });

  it("is refused by the policy alone when the row names another workspace than the active one", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const other = await workspaceOf([a]);
    const tag = await seedTag(workspace.id, a, "Matrix");
    const bookmark = await seedBookmark(workspace.id, a);

    const refused = await refusedWith(
      inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => method("insert").invokeRlsOnly(tx, { values: { workspaceId: other.id, bookmarkId: bookmark, tagId: tag } })),
    );

    expect(refused).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await linksOf(other.id)).toEqual([]);
  });
});

describe("the tags of a bookmark", () => {
  it("tags a new bookmark with the tags its creation names, by identifier and by name, and answers them in the order of their names", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const existing = await seedTag(workspace.id, a, "zebra");
    const as = { accountId: a, workspaceId: workspace.id };
    const bookmark = newBookmark(a);

    const created = await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], tags: { ids: [existing], names: named("Apple", "ZEBRA", "mango") } }));

    expect(created).toMatchObject({ kind: "created", bookmark: { id: bookmark.id, tags: [{ name: "Apple" }, { name: "mango" }, { id: existing, name: "zebra" }] } });
    // The tag the name ZEBRA would have created is the owner's tag zebra, whatever the case; the other two are new.
    expect(await tagNamesOf(workspace.id)).toEqual(["Apple", "mango", "zebra"]);
    expect(await linksOf(workspace.id)).toHaveLength(3);
    expect((await inTenant(as, (tx) => bookmarkRepository(tx).find(bookmark.id)))?.tags.map((tag) => tag.name)).toEqual(["Apple", "mango", "zebra"]);
  });

  it("replaces the tags on a change, keeps the version when only the tags change, and clears them with an empty selection", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const [one, two] = [await seedTag(workspace.id, a, "One"), await seedTag(workspace.id, a, "Two")];
    const as = { accountId: a, workspaceId: workspace.id };
    const bookmark = newBookmark(a);
    await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], tags: { ids: [one], names: [] } }));
    const update = (tags: { ids: string[]; names: BookmarkTagName[] }, extra: Record<string, unknown> = {}) =>
      inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { tags, ...extra }, expectedVersions: undefined }));

    const same = await update({ ids: [one], names: named("one") });
    const replaced = await update({ ids: [two], names: named("Three") });
    const withTitle = await update({ ids: [two], names: named("three") }, { title: "Renamed" });
    const cleared = await update({ ids: [], names: [] });

    expect(same).toMatchObject({ kind: "unchanged", bookmark: { version: 1, tags: [{ id: one }] } });
    expect(replaced).toMatchObject({ kind: "updated", bookmark: { version: 1, tags: [{ name: "Three" }, { id: two }] } });
    expect(withTitle).toMatchObject({ kind: "updated", bookmark: { version: 2, title: "Renamed", tags: [{ name: "Three" }, { id: two }] } });
    expect(cleared).toMatchObject({ kind: "updated", bookmark: { tags: [] } });
    expect(await linksOf(workspace.id)).toEqual([]);
    // Taking tags off a bookmark deletes the links only: the tags stay.
    expect(await tagNamesOf(workspace.id)).toEqual(["One", "Three", "Two"]);
  });

  it("leaves a patch without tags alone, and leaves the bookmark, its tags and the tags of the owner as they were on a stale version or a tag that is not the owner's", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const own = await seedTag(workspace.id, a, "Own");
    const foreign = await seedTag(workspace.id, b, "Of B");
    const as = { accountId: a, workspaceId: workspace.id };
    const bookmark = newBookmark(a);
    await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], tags: { ids: [own], names: [] } }));

    const untouched = await inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { title: "Retitled" }, expectedVersions: undefined }));
    const stale = await inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { tags: { ids: [], names: named("Created by a stale request") } }, expectedVersions: [9] }));
    const refused = await inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { tags: { ids: [foreign], names: named("Created by a refused request") } }, expectedVersions: undefined }));

    expect(untouched).toMatchObject({ kind: "updated", bookmark: { title: "Retitled", tags: [{ id: own }] } });
    expect(stale).toEqual({ kind: "stale" });
    expect(refused).toEqual({ kind: "tag_not_found" });
    expect(await linksOf(workspace.id)).toEqual([`${bookmark.id}/${own}`]);
    expect(await tagNamesOf(workspace.id)).toEqual(["Of B", "Own"]);
  });

  it("answers not_found, and creates no tag, for a bookmark the owner does not own or that is plan-archived", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const theirs = await seedBookmark(workspace.id, b);
    const archived = await seedBookmark(workspace.id, a, true);
    const as = { accountId: a, workspaceId: workspace.id };

    for (const bookmarkId of [theirs, archived, freshId()]) {
      expect(await inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId, ownerId: a, changes: { tags: { ids: [], names: named("Never created") } }, expectedVersions: undefined }))).toEqual({ kind: "not_found" });
    }

    expect(await tagNamesOf(workspace.id)).toEqual([]);
    expect(await linksOf(workspace.id)).toEqual([]);
  });

  it("makes one tag when two requests create one name at the same time, and links both bookmarks to it", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const as = { accountId: a, workspaceId: workspace.id };
    const [first, second] = [newBookmark(a, "First"), newBookmark(a, "Second")];

    const [one, two] = await Promise.all([
      inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark: first, ceiling: null, jobs: [], tags: { ids: [], names: named("Shared") } })),
      inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark: second, ceiling: null, jobs: [], tags: { ids: [], names: named("SHARED") } })),
    ]);

    expect([one.kind, two.kind]).toEqual(["created", "created"]);
    expect(await tagNamesOf(workspace.id)).toHaveLength(1);
    expect(await linksOf(workspace.id)).toHaveLength(2);
  });

  it("shows the caller's tags only, on the bookmark it reads and in a list, whoever put the other tags there", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    const tagOfA = await seedTag(workspace.id, a, "Of A");
    const tagOfB = await seedTag(workspace.id, b, "Of B");
    // A link of B's tag on A's bookmark is one no request can write; the rows are written as the system does.
    await link(workspace.id, bookmarkOfA, tagOfA);
    await link(workspace.id, bookmarkOfA, tagOfB);
    const asA = { accountId: a, workspaceId: workspace.id };
    const asB = { accountId: b, workspaceId: workspace.id };

    const read = await inTenant(asA, (tx) => bookmarkRepository(tx).find(bookmarkOfA));
    const listed = await inTenant(asA, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: a }, sort: "recent", after: undefined, limit: 10 }));
    const readByB = await inTenant(asB, (tx) => bookmarkRepository(tx).find(bookmarkOfA));

    expect(read?.tags).toEqual([{ id: tagOfA, name: "Of A" }]);
    expect(listed.map((row) => row.bookmark.tags)).toEqual([[{ id: tagOfA, name: "Of A" }]]);
    expect(readByB?.tags).toEqual([{ id: tagOfB, name: "Of B" }]);
  });

  it("counts the caller's links on a tag only, and not a plan-archived bookmark", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const tagOfA = await seedTag(workspace.id, a, "Of A");
    const asA = { accountId: a, workspaceId: workspace.id };
    const bookmarks = [await seedBookmark(workspace.id, a), await seedBookmark(workspace.id, a), await seedBookmark(workspace.id, a, true)];
    for (const bookmarkId of bookmarks) {
      await link(workspace.id, bookmarkId, tagOfA);
    }
    // A link of another member's tag on the same bookmark does not add to the count of A's tag.
    const tagOfB = await seedTag(workspace.id, b, "Of B");
    await link(workspace.id, bookmarks[0] ?? "", tagOfB);

    const listA = await inTenant(asA, (tx) => tagRepository(tx).list({ ownerId: a, sort: "name", after: undefined, limit: 10 }));
    const listB = await inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => tagRepository(tx).list({ ownerId: b, sort: "name", after: undefined, limit: 10 }));

    expect(listA).toMatchObject([{ id: tagOfA, bookmarkCount: 2 }]);
    expect(listB).toMatchObject([{ id: tagOfB, bookmarkCount: 1 }]);
  });
});

describe("the list narrowed to tags", () => {
  async function library() {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const [reading, later, work] = [await seedTag(workspace.id, a, "Reading"), await seedTag(workspace.id, a, "Later"), await seedTag(workspace.id, a, "Work")];
    const tagOfB = await seedTag(workspace.id, b, "Reading B");
    const both = await seedBookmark(workspace.id, a);
    const onlyReading = await seedBookmark(workspace.id, a);
    const none = await seedBookmark(workspace.id, a);
    const bookmarkOfB = await seedBookmark(workspace.id, b);
    await link(workspace.id, both, reading);
    await link(workspace.id, both, later);
    await link(workspace.id, onlyReading, reading);
    await link(workspace.id, bookmarkOfB, tagOfB);
    return { a, b, workspace, reading, later, work, tagOfB, both, onlyReading, none, bookmarkOfB };
  }

  it("lists the bookmarks that carry every tag named (AND), counts them, and carries the tags of each", async () => {
    const { a, workspace, reading, later, both, onlyReading } = await library();
    const as = { accountId: a, workspaceId: workspace.id };

    const one = { ownerId: a, tagIds: [reading] };
    const two = { ownerId: a, tagIds: [reading, later] };
    const rowsOne = await inTenant(as, (tx) => bookmarkRepository(tx).list({ filter: one, sort: "recent", after: undefined, limit: 10 }));
    const rowsTwo = await inTenant(as, (tx) => bookmarkRepository(tx).list({ filter: two, sort: "recent", after: undefined, limit: 10 }));

    expect(rowsOne.map((row) => row.bookmark.id).sort()).toEqual([both, onlyReading].sort());
    expect(rowsTwo.map((row) => row.bookmark.id)).toEqual([both]);
    expect(rowsTwo[0]?.bookmark.tags.map((tag) => tag.name)).toEqual(["Later", "Reading"]);
    expect(await inTenant(as, (tx) => bookmarkRepository(tx).count(one, 100))).toBe(2);
    expect(await inTenant(as, (tx) => bookmarkRepository(tx).count(two, 100))).toBe(1);
    expect(await inTenant(as, (tx) => bookmarkRepository(tx).ids(two, 100))).toEqual([both]);
  });

  it("lists nothing when one of the tags is another member's, another workspace's or unknown, or carried by no bookmark of the caller's", async () => {
    const { a, workspace, reading, work, tagOfB, both } = await library();
    const as = { accountId: a, workspaceId: workspace.id };
    // Even a link of the caller's own bookmark to the other member's tag (one no request can write) matches nothing.
    await link(workspace.id, both, tagOfB);

    for (const tagIds of [[reading, tagOfB], [tagOfB], [reading, freshId()], [work]]) {
      const filter = { ownerId: a, tagIds };
      expect(await inTenant(as, (tx) => bookmarkRepository(tx).list({ filter, sort: "recent", after: undefined, limit: 10 }))).toEqual([]);
      expect(await inTenant(as, (tx) => bookmarkRepository(tx).count(filter, 100))).toBe(0);
    }
  });

  it("does not list another member's bookmarks for a tag of the caller's", async () => {
    const { b, workspace, reading, bookmarkOfB } = await library();

    const filter = { ownerId: b, tagIds: [reading] };
    expect(await inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).list({ filter, sort: "recent", after: undefined, limit: 10 }))).toEqual([]);
    expect(bookmarkOfB).toBeDefined();
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

function planNodes(text: string): PlanNode[] {
  const plan = (JSON.parse(text) as { Plan: PlanNode }[])[0];
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan.Plan);
}

async function explain(tenant: { accountId: string; workspaceId: string }, statement: { sql: string; params: unknown[] }): Promise<{ text: string }> {
  return db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${tenant.accountId}, true), set_config('app.workspace_id', ${tenant.workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": unknown[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return { text: JSON.stringify(rows[0]?.["QUERY PLAN"]) };
  });
}

describe("the plans of the reads of tags", () => {
  const library = { account: "", workspace: "", tags: [] as string[], sample: [] as string[] };

  beforeAll(async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    await asSystem(db, (tx) => tx`
      INSERT INTO tags (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ${workspace.id}, ${a}, 'Tag ' || n FROM generate_series(1, 200) AS n`);
    await asSystem(db, (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, created_at)
      SELECT gen_random_uuid(), ${workspace.id}, ${a}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 97), timestamptz '2026-01-01' + n * interval '1 second'
      FROM generate_series(1, 20000) AS n`);
    // 200 tags of 100 bookmarks each; each bookmark has one tag.
    await asSystem(db, (tx) => tx`
      INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id)
      SELECT ${workspace.id}, b.id, t.id
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM bookmarks WHERE workspace_id = ${workspace.id}) AS b
      JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM tags WHERE workspace_id = ${workspace.id}) AS t ON t.n = (b.n % 200) + 1`);
    await db.owner.unsafe("ANALYZE bookmarks; ANALYZE bookmark_tags; ANALYZE tags");
    const tagRows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM tags WHERE workspace_id = ${workspace.id} ORDER BY id LIMIT 2`);
    const sample = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspace.id} ORDER BY created_at DESC LIMIT 48`);
    Object.assign(library, { account: a, workspace: workspace.id, tags: tagRows.map((row) => row.id), sample: sample.map((row) => row.id) });
  }, HOOK_TIMEOUT_MS);

  it("reads the links of a bookmark by the primary key of bookmark_tags for each tag of the filter, not from a scan of the table", async () => {
    const as = { accountId: library.account, workspaceId: library.workspace };
    const statement = await inTenant(as, (tx) => Promise.resolve(listQuery(tx, { filter: { ownerId: library.account, tagIds: library.tags }, sort: "recent", after: undefined, limit: 49 }).toSQL()));

    const nodes = planNodes((await explain(as, statement)).text);

    expect(nodes.filter((node) => node["Relation Name"] === "bookmark_tags").map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toContain("bookmark_tags_pkey");
  });

  it("reads the tags of the bookmarks of a page through an index of bookmark_tags, not from a scan of the links", async () => {
    const as = { accountId: library.account, workspaceId: library.workspace };
    const statement = await inTenant(as, (tx) => Promise.resolve(tagsOfBookmarksQuery(tx, library.account, library.sample).toSQL()));

    const nodes = planNodes((await explain(as, statement)).text);

    expect(nodes.filter((node) => node["Relation Name"] === "bookmark_tags").map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toContain("bookmark_tags_pkey");
  });
});
