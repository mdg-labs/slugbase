import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportRepository } from "../src/index.ts";
import { bookmarksStatement, foldersStatement, folderBookmarksStatement, goPreferencesStatement, sectionsStatement, sharedStatement, summaryStatement, tagsStatement, unfiledBookmarksStatement } from "../src/repositories/export.ts";
import type { TenantTx } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark, shareThroughFolder } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The reads of the export (doc 02 section 13.2, doc 05 section 2.4, doc 10 T1 and T2). The failure scenario: another member's bookmark, folder or tag, a bookmark with no owner and anything of
// another workspace is never in a member's export, whatever the links between the rows, and a plan-archived bookmark of the member's own is.

const HOOK_TIMEOUT_MS = 300_000;
const dialect = new PgDialect({ casing: "snake_case" });

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
  await seedAccount(db, { id, email: `export${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(members: readonly string[], name = "Export test"): Promise<string> {
  const id = await seedWorkspace(db, { name });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

interface Seed {
  readonly title: string;
  readonly description?: string | null;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
  readonly pinnedAt?: Date | null;
  readonly archived?: boolean;
}

async function bookmark(workspaceId: string, ownerId: string | null, seed: Seed): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, plan_archived_at, open_count)
      VALUES (${id}, ${workspaceId}, ${ownerId}, ${`https://example.com/${id}`}, ${`https://example.com/${id}`}, 'example.com', ${seed.title}, ${seed.description ?? null}, ${seed.slug ?? null},
              ${seed.forwarding ?? false}, ${seed.pinnedAt ?? null}, ${seed.archived === true ? new Date() : null}, 7)`,
  );
  return id;
}

async function folder(workspaceId: string, ownerId: string, name: string, files: readonly string[] = [], icon = "folder", color = 1): Promise<string> {
  const id = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name, icon, color) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name}, ${icon}, ${color})`;
    for (const bookmarkId of files) {
      await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${id}, ${bookmarkId})`;
    }
  });
  return id;
}

async function tag(workspaceId: string, ownerId: string, name: string, on: readonly string[] = []): Promise<string> {
  const id = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`;
    for (const bookmarkId of on) {
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${id})`;
    }
  });
  return id;
}

function asMember<T>(workspaceId: string, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "export-test" }, work);
}

/** Every bookmark of the member, read page by page. */
async function allBookmarks(workspaceId: string, accountId: string, pageSize: number) {
  const rows = [];
  let after: string | undefined;
  for (;;) {
    const page = await asMember(workspaceId, accountId, (tx) => exportRepository(tx).bookmarks(accountId, after, pageSize));
    rows.push(...page);
    if (page.length < pageSize) {
      return rows;
    }
    after = page[page.length - 1]?.id;
  }
}

describe("the bookmarks of the export", () => {
  it("are the member's own with every field of the format, a plan-archived one flagged, and the names of their folders and tags", async () => {
    const me = await account();
    const w = await workspace([me]);
    const pinnedAt = new Date("2026-01-01T00:00:00Z");
    const plain = await bookmark(w, me, { title: "Plain" });
    const rich = await bookmark(w, me, { title: "Rich", description: "About it", slug: "rich", forwarding: true, pinnedAt });
    const archived = await bookmark(w, me, { title: "Archived", archived: true });
    await folder(w, me, "Reading", [rich, archived], "book-open", 4);
    await folder(w, me, "Work", [rich]);
    await tag(w, me, "news", [rich]);
    await tag(w, me, "alpha", [rich, archived]);

    const rows = await allBookmarks(w, me, 100);

    expect(rows.map((row) => row.id)).toEqual([plain, rich, archived].sort());
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(plain)).toEqual({ id: plain, url: expect.stringContaining("https://example.com/") as string, title: "Plain", description: null, slug: null, forwarding: false, pinned: false, planArchived: false, folders: [], tags: [] });
    expect(byId.get(rich)).toMatchObject({ title: "Rich", description: "About it", slug: "rich", forwarding: true, pinned: true, planArchived: false, folders: ["Reading", "Work"], tags: ["alpha", "news"] });
    expect(byId.get(archived)).toMatchObject({ title: "Archived", planArchived: true, pinned: false, folders: ["Reading"], tags: ["alpha"] });
  });

  it("carry no usage count, identifier of a link or timestamp", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, { title: "Opened" });
    const [row] = await allBookmarks(w, me, 100);
    expect(Object.keys(row ?? {}).sort()).toEqual(["description", "folders", "forwarding", "id", "pinned", "planArchived", "slug", "tags", "title", "url"]);
  });

  it("come in the order of their identifiers and resume after the last one, each exactly once, whatever the page size", async () => {
    const me = await account();
    const w = await workspace([me]);
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) {
      ids.push(await bookmark(w, me, { title: `Title ${String(n)}` }));
    }
    for (const pageSize of [1, 2, 3, 7, 8, 500]) {
      expect((await allBookmarks(w, me, pageSize)).map((row) => row.id), `page size ${String(pageSize)}`).toEqual([...ids].sort());
    }
  });

  it("never include another member's bookmark, one with no owner or one of another workspace, and never the names of another member's folders and tags", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, other]);
    const mine = await bookmark(w, me, { title: "Mine" });
    const theirs = await bookmark(w, other, { title: "Theirs", slug: "theirs", forwarding: true });
    await bookmark(w, null, { title: "Ownerless" });
    await bookmark(elsewhere, me, { title: "Elsewhere" });
    await bookmark(elsewhere, other, { title: "Elsewhere theirs" });
    await folder(w, me, "My folder", [mine]);
    await tag(w, me, "my-tag", [mine]);
    // The rows of the other member, linked to my bookmark by the system as no policy would allow: the join names its own owner, so the names are not read.
    await folder(w, other, "Their folder", [mine, theirs]);
    await tag(w, other, "their-tag", [mine, theirs]);

    const rows = await allBookmarks(w, me, 100);

    expect(rows.map((row) => row.title)).toEqual(["Mine"]);
    expect(rows[0]).toMatchObject({ folders: ["My folder"], tags: ["my-tag"] });
    expect(JSON.stringify(rows)).not.toMatch(/Their folder|their-tag|theirs|Elsewhere/i);

    expect((await allBookmarks(w, other, 100)).map((row) => row.title)).toEqual(["Theirs"]);
  });
});

describe("the folders and tags of the export", () => {
  it("are every one the member owns, used or not, sorted by the bytes of the name and not by the locale", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (const name of ["banana", "Zebra", "apple", "Äpfel", "Banana-2", "10", "9"]) {
      await folder(w, me, name, [], "folder", 2);
      await tag(w, me, name);
    }
    const expectedOrder = ["10", "9", "Banana-2", "Zebra", "apple", "banana", "Äpfel"];

    const folders = await asMember(w, me, (tx) => exportRepository(tx).folders(me, undefined, 100));
    const tags = await asMember(w, me, (tx) => exportRepository(tx).tags(me, undefined, 100));

    expect(folders.map((row) => row.name)).toEqual(expectedOrder);
    expect(folders[0]).toEqual({ name: "10", icon: "folder", color: 2 });
    expect(tags).toEqual(expectedOrder);
  });

  it("resume after the last name of a page, each exactly once", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (const name of ["d", "a", "e", "c", "b"]) {
      await folder(w, me, name);
      await tag(w, me, name);
    }
    const seenFolders: string[] = [];
    const seenTags: string[] = [];
    let afterFolder: string | undefined;
    let afterTag: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const folders = await asMember(w, me, (tx) => exportRepository(tx).folders(me, afterFolder, 2));
      const tags = await asMember(w, me, (tx) => exportRepository(tx).tags(me, afterTag, 2));
      seenFolders.push(...folders.map((row) => row.name));
      seenTags.push(...tags);
      afterFolder = folders[folders.length - 1]?.name;
      afterTag = tags[tags.length - 1];
    }
    expect(seenFolders).toEqual(["a", "b", "c", "d", "e"]);
    expect(seenTags).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never include another member's, one with no owner or another workspace's", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, other]);
    await folder(w, me, "mine");
    await tag(w, me, "mine");
    await folder(w, other, "theirs");
    await tag(w, other, "theirs");
    await folder(elsewhere, me, "elsewhere");
    await tag(elsewhere, me, "elsewhere");
    await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${w}, NULL, 'ownerless')`);

    expect((await asMember(w, me, (tx) => exportRepository(tx).folders(me, undefined, 100))).map((row) => row.name)).toEqual(["mine"]);
    expect(await asMember(w, me, (tx) => exportRepository(tx).tags(me, undefined, 100))).toEqual(["mine"]);
    expect(await asMember(w, other, (tx) => exportRepository(tx).tags(other, undefined, 100))).toEqual(["theirs"]);
  });
});

describe("the remembered slug choices of the export", () => {
  async function choose(workspaceId: string, accountId: string, slug: string, bookmarkId: string): Promise<void> {
    await asSystem(db, (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspaceId}, ${accountId}, ${slug}, ${bookmarkId})`);
  }

  const read = (workspaceId: string, accountId: string, after: string | undefined, limit: number) => asMember(workspaceId, accountId, (tx) => exportRepository(tx).goPreferences(accountId, after, limit));

  it("are the member's choices for their own bookmark that has the slug and forwards, a plan-archived bookmark's included, sorted by the bytes of the slug and not by the locale", async () => {
    const me = await account();
    const w = await workspace([me]);
    const slugs = ["banana", "zebra", "apple", "b-2", "10", "9"];
    const ids = new Map<string, string>();
    for (const slug of slugs) {
      const id = await bookmark(w, me, { title: slug, slug, forwarding: true, archived: slug === "zebra" });
      ids.set(slug, id);
      await choose(w, me, slug, id);
    }

    const rows = await read(w, me, undefined, 100);

    expect(rows).toEqual(["10", "9", "apple", "b-2", "banana", "zebra"].map((slug) => ({ slug, bookmarkId: ids.get(slug) })));
  });

  it("resume after the last slug of a page, each exactly once, whatever the page size", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (const slug of ["d", "a", "e", "c", "b"]) {
      await choose(w, me, slug, await bookmark(w, me, { title: slug, slug, forwarding: true }));
    }
    const everything = (await read(w, me, undefined, 100)).map((row) => row.slug);
    expect(everything).toEqual(["a", "b", "c", "d", "e"]);

    for (const size of [1, 2, 3, 5, 6]) {
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await read(w, me, after, size);
        seen.push(...page.map((row) => row.slug));
        if (page.length < size) {
          break;
        }
        after = page[page.length - 1]?.slug;
      }
      expect(seen, `page size ${String(size)}`).toEqual(everything);
    }
  });

  it("never include a choice for another member's bookmark, another member's choice, a choice of another workspace, or a choice that went stale because its bookmark changed its slug or stopped forwarding", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, other]);
    const mine = await bookmark(w, me, { title: "mine", slug: "mine", forwarding: true });
    const theirs = await bookmark(w, other, { title: "theirs", slug: "theirs", forwarding: true });
    const moved = await bookmark(w, me, { title: "moved", slug: "moved", forwarding: true });
    const quiet = await bookmark(w, me, { title: "quiet", slug: "quiet", forwarding: true });
    const ownerless = await bookmark(w, null, { title: "ownerless", slug: "ownerless", forwarding: true });
    const elsewhereMine = await bookmark(elsewhere, me, { title: "elsewhere", slug: "elsewhere", forwarding: true });
    const othersChoice = await bookmark(w, other, { title: "others choice", slug: "mine", forwarding: true });
    for (const [slug, id] of [["mine", mine], ["theirs", theirs], ["moved", moved], ["quiet", quiet], ["ownerless", ownerless]] as const) {
      await choose(w, me, slug, id);
    }
    await choose(elsewhere, me, "elsewhere", elsewhereMine);
    await choose(w, other, "mine", othersChoice);
    await choose(w, other, "other-only", await bookmark(w, other, { title: "other only", slug: "other-only", forwarding: true }));
    await asSystem(db, async (tx) => {
      await tx`UPDATE bookmarks SET slug = 'renamed' WHERE id = ${moved}`;
      await tx`UPDATE bookmarks SET forwarding = false WHERE id = ${quiet}`;
    });

    expect(await read(w, me, undefined, 100)).toEqual([{ slug: "mine", bookmarkId: mine }]);
    expect(await read(w, other, undefined, 100)).toEqual([{ slug: "mine", bookmarkId: othersChoice }, { slug: "other-only", bookmarkId: expect.any(String) as string }]);
    expect(await read(elsewhere, me, undefined, 100)).toEqual([{ slug: "elsewhere", bookmarkId: elsewhereMine }]);
  });

  it("are read for the account of the transaction only, with a positive whole page size", async () => {
    const me = await account();
    const w = await workspace([me]);
    await asMember(w, me, (tx) => {
      expect(() => goPreferencesStatement(tx, freshId(), undefined, 10)).toThrow("account of the transaction");
      expect(() => goPreferencesStatement(tx, me, undefined, 0)).toThrow("positive whole limit");
      expect(() => goPreferencesStatement(tx, me, undefined, 1.5)).toThrow("positive whole limit");
      return Promise.resolve();
    });
    await expect(asMember(w, me, (tx) => exportRepository(tx).goPreferences(freshId(), undefined, 10))).rejects.toThrow("account of the transaction");
  });
});

describe("the summary of the export", () => {
  it("names the workspace and counts what the member owns, plan-archived bookmarks included", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other], "Home");
    await bookmark(w, me, { title: "One" });
    await bookmark(w, me, { title: "Two", archived: true });
    await bookmark(w, other, { title: "Theirs" });
    await bookmark(w, null, { title: "Ownerless" });
    await folder(w, me, "f");
    await folder(w, other, "g");
    await tag(w, me, "t1");
    await tag(w, me, "t2");
    await tag(w, other, "t3");

    expect(await asMember(w, me, (tx) => exportRepository(tx).summary(me, false))).toEqual({ workspaceName: "Home", bookmarks: 2, folders: 1, tags: 2, shared: 0 });
    expect(await asMember(w, other, (tx) => exportRepository(tx).summary(other, false))).toEqual({ workspaceName: "Home", bookmarks: 1, folders: 1, tags: 1, shared: 0 });
  });

  it("is undefined for a workspace that is being deleted", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, { title: "One" });
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${w}`);

    expect(await asMember(w, me, (tx) => exportRepository(tx).summary(me, true))).toBeUndefined();
  });
});

// The bookmarks other members shared with the member (doc 02 sections 8.2 and 13.2, doc 10 T1, T2 and T11). The failure scenario: a bookmark that is not shared with the member, one whose share has
// ended, one of another workspace, one the member owns and one a downgrade archived is in no page, and no row carries the owner's tags, folders or pin.

/** Every shared bookmark of the member, read page by page. */
async function allShared(workspaceId: string, accountId: string, pageSize: number) {
  const rows = [];
  let after: string | undefined;
  for (;;) {
    const page = await asMember(workspaceId, accountId, (tx) => exportRepository(tx).shared(accountId, after, pageSize));
    rows.push(...page);
    if (page.length < pageSize) {
      return rows;
    }
    after = page[page.length - 1]?.id;
  }
}

async function nameOf(accountId: string, displayName: string): Promise<void> {
  await asSystem(db, (tx) => tx`UPDATE accounts SET display_name = ${displayName} WHERE id = ${accountId}`);
}

describe("the shared bookmarks of the export", () => {
  it("are the readable bookmarks of other members through a direct share, a team's and a shared folder's, each once even when two shares give it, with the readable fields and the name of the owner", async () => {
    const me = await account();
    const olga = await account();
    const max = await account();
    await nameOf(olga, "Olga Owner");
    const w = await workspace([me, olga, max]);
    const team = await seedTeam(db, w, [me]);
    const direct = await bookmark(w, olga, { title: "Direct", description: "About it", slug: "direct", forwarding: true, pinnedAt: new Date() });
    const viaTeam = await bookmark(w, olga, { title: "Via team" });
    const viaFolder = await bookmark(w, olga, { title: "Via folder" });
    const twice = await bookmark(w, olga, { title: "Twice" });
    const notShared = await bookmark(w, olga, { title: "Not shared" });
    const sharedWithMax = await bookmark(w, olga, { title: "For Max" });
    await shareBookmark(db, w, direct, olga, { accountId: me });
    await shareBookmark(db, w, viaTeam, olga, { teamId: team });
    await shareThroughFolder(db, w, viaFolder, olga, { accountId: me });
    await shareBookmark(db, w, twice, olga, { accountId: me });
    await shareBookmark(db, w, twice, olga, { teamId: team });
    await shareThroughFolder(db, w, twice, olga, { teamId: team });
    await shareBookmark(db, w, sharedWithMax, olga, { accountId: max });
    await tag(w, olga, "private-tag", [direct, notShared]);
    await folder(w, olga, "Private folder", [direct]);

    const rows = await allShared(w, me, 100);

    expect(rows.map((row) => row.id)).toEqual([direct, viaTeam, viaFolder, twice].sort());
    expect(rows.find((row) => row.id === direct)).toEqual({ id: direct, url: expect.stringContaining("https://example.com/") as string, title: "Direct", description: "About it", slug: "direct", ownerName: "Olga Owner" });
    expect(rows.every((row) => row.ownerName === "Olga Owner")).toBe(true);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["description", "id", "ownerName", "slug", "title", "url"]);
    expect(JSON.stringify(rows)).not.toMatch(/private-tag|Private folder|pinned|forwarding|Not shared|For Max/);
    expect((await allShared(w, max, 100)).map((row) => row.title)).toEqual(["For Max"]);
  });

  it("never hold the owner's own bookmark, though the owner is in a team it is shared with, in the read or in the count", async () => {
    const me = await account();
    const olga = await account();
    const w = await workspace([me, olga]);
    const team = await seedTeam(db, w, [me, olga]);
    const own = await bookmark(w, olga, { title: "Olga's, shared with her own team" });
    await shareBookmark(db, w, own, olga, { teamId: team });

    expect((await allShared(w, olga, 100)).map((row) => row.title)).toEqual([]);
    expect(await asMember(w, olga, (tx) => exportRepository(tx).summary(olga, true))).toMatchObject({ bookmarks: 1, shared: 0 });
    expect((await allShared(w, me, 100)).map((row) => row.title)).toEqual(["Olga's, shared with her own team"]);
  });

  it("come in the order of their identifiers and resume after the last one, each exactly once, whatever the page size", async () => {
    const me = await account();
    const olga = await account();
    const w = await workspace([me, olga]);
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) {
      const id = await bookmark(w, olga, { title: `Shared ${String(n)}` });
      await shareBookmark(db, w, id, olga, { accountId: me });
      ids.push(id);
    }
    for (const pageSize of [1, 2, 3, 7, 8, 500]) {
      expect((await allShared(w, me, pageSize)).map((row) => row.id), `page size ${String(pageSize)}`).toEqual([...ids].sort());
    }
  });

  it("leave out the member's own bookmarks, those nobody shared with them, plan-archived ones and those of another workspace, and a share another workspace holds names nothing here", async () => {
    const me = await account();
    const olga = await account();
    const w = await workspace([me, olga]);
    const elsewhere = await workspace([me, olga]);
    const mine = await bookmark(w, me, { title: "Mine" });
    await shareBookmark(db, w, mine, me, { accountId: olga });
    const archived = await bookmark(w, olga, { title: "Archived", archived: true });
    await shareBookmark(db, w, archived, olga, { accountId: me });
    await bookmark(w, olga, { title: "Private" });
    const shown = await bookmark(w, olga, { title: "Shown" });
    await shareBookmark(db, w, shown, olga, { accountId: me });
    const abroad = await bookmark(elsewhere, olga, { title: "Abroad" });
    await shareBookmark(db, elsewhere, abroad, olga, { accountId: me });

    expect((await allShared(w, me, 100)).map((row) => row.title)).toEqual(["Shown"]);
    expect((await allShared(elsewhere, me, 100)).map((row) => row.title)).toEqual(["Abroad"]);
    expect((await allShared(w, olga, 100)).map((row) => row.title)).toEqual(["Mine"]);
  });

  it("are no longer read once the share is revoked, the member leaves the team, or the bookmark leaves the shared folder", async () => {
    const me = await account();
    const olga = await account();
    const w = await workspace([me, olga]);
    const team = await seedTeam(db, w, [me]);
    const byShare = await bookmark(w, olga, { title: "By share" });
    const byTeam = await bookmark(w, olga, { title: "By team" });
    const byFolder = await bookmark(w, olga, { title: "By folder" });
    await shareBookmark(db, w, byShare, olga, { accountId: me });
    await shareBookmark(db, w, byTeam, olga, { teamId: team });
    const sharedFolder = await shareThroughFolder(db, w, byFolder, olga, { accountId: me });
    expect((await allShared(w, me, 100)).map((row) => row.title).sort()).toEqual(["By folder", "By share", "By team"]);

    await asSystem(db, (tx) => tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${byShare}`);
    expect((await allShared(w, me, 100)).map((row) => row.title).sort()).toEqual(["By folder", "By team"]);
    await asSystem(db, (tx) => tx`DELETE FROM team_members WHERE team_id = ${team} AND account_id = ${me}`);
    expect((await allShared(w, me, 100)).map((row) => row.title)).toEqual(["By folder"]);
    await asSystem(db, (tx) => tx`DELETE FROM folder_bookmarks WHERE folder_id = ${sharedFolder} AND bookmark_id = ${byFolder}`);
    expect(await allShared(w, me, 100)).toEqual([]);
  });

  it("name no owner for a bookmark whose owner has left, and still read it through its share", async () => {
    const me = await account();
    const olga = await account();
    const w = await workspace([me, olga]);
    const orphan = await bookmark(w, null, { title: "Orphan" });
    await shareBookmark(db, w, orphan, olga, { accountId: me });
    const kept = await bookmark(w, olga, { title: "Kept" });
    await shareBookmark(db, w, kept, olga, { accountId: me });
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET owner_id = NULL WHERE id = ${kept}`);

    const rows = await allShared(w, me, 100);

    expect(rows.map((row) => [row.title, row.ownerName]).sort()).toEqual([
      ["Kept", null],
      ["Orphan", null],
    ]);
  });

  it("are counted by the summary with includeShared, by the same rule, and not counted without it", async () => {
    const me = await account();
    const olga = await account();
    const w = await workspace([me, olga]);
    const team = await seedTeam(db, w, [me]);
    await bookmark(w, me, { title: "Mine" });
    const a = await bookmark(w, olga, { title: "A" });
    const b = await bookmark(w, olga, { title: "B" });
    const c = await bookmark(w, olga, { title: "C", archived: true });
    await bookmark(w, olga, { title: "Private" });
    await shareBookmark(db, w, a, olga, { accountId: me });
    await shareBookmark(db, w, b, olga, { teamId: team });
    await shareBookmark(db, w, b, olga, { accountId: me });
    await shareBookmark(db, w, c, olga, { accountId: me });

    expect(await asMember(w, me, (tx) => exportRepository(tx).summary(me, true))).toMatchObject({ bookmarks: 1, shared: 2 });
    expect(await asMember(w, me, (tx) => exportRepository(tx).summary(me, false))).toMatchObject({ bookmarks: 1, shared: 0 });
    expect(await asMember(w, olga, (tx) => exportRepository(tx).summary(olga, true))).toMatchObject({ bookmarks: 4, shared: 0 });
  });

  it("are read for the account of the transaction only, with a positive whole page size", async () => {
    const me = await account();
    const w = await workspace([me]);
    await asMember(w, me, (tx) => {
      expect(() => sharedStatement(tx, freshId(), undefined, 10)).toThrow("account of the transaction");
      expect(() => sharedStatement(tx, me, undefined, 0)).toThrow("positive whole limit");
      expect(() => summaryStatement(tx, freshId(), true)).toThrow("account of the transaction");
      return Promise.resolve();
    });
  });
});

// The sections of the Netscape export: the bookmarks of one folder, and the bookmarks that are in none. The failure scenario: another member's bookmark filed in the member's folder, a bookmark that is
// in another member's folder only, content with no owner or of another workspace, and another member's tag on the member's bookmark are in no section.
describe("the sections of the Netscape export", () => {
  /** The bookmarks of one folder by its identifier, page by page. */
  async function sectionOf(workspaceId: string, accountId: string, folderId: string, pageSize = 100) {
    const rows = [];
    let after: string | undefined;
    for (;;) {
      const page = await asMember(workspaceId, accountId, (tx) => exportRepository(tx).folderBookmarks(accountId, folderId, after, pageSize));
      rows.push(...page);
      if (page.length < pageSize) {
        return rows;
      }
      after = page[page.length - 1]?.id;
    }
  }

  /** The folders of the member, page by page. */
  async function sections(workspaceId: string, accountId: string, pageSize = 100) {
    const rows = [];
    let after: string | undefined;
    for (;;) {
      const page = await asMember(workspaceId, accountId, (tx) => exportRepository(tx).sections(accountId, after, pageSize));
      rows.push(...page);
      if (page.length < pageSize) {
        return rows;
      }
      after = page[page.length - 1]?.id;
    }
  }

  /** The bookmarks of the member's folder of that name, found the way the writer finds them: through the list of the member's folders. */
  async function section(workspaceId: string, accountId: string, name: string, pageSize = 100) {
    const found = (await sections(workspaceId, accountId)).find((entry) => entry.name === name);
    return found === undefined ? [] : sectionOf(workspaceId, accountId, found.id, pageSize);
  }

  async function unfiled(workspaceId: string, accountId: string, pageSize = 100) {
    const rows = [];
    let after: string | undefined;
    for (;;) {
      const page = await asMember(workspaceId, accountId, (tx) => exportRepository(tx).unfiledBookmarks(accountId, after, pageSize));
      rows.push(...page);
      if (page.length < pageSize) {
        return rows;
      }
      after = page[page.length - 1]?.id;
    }
  }

  it("hold the bookmarks of a folder with their address, title, slug and tags, a plan-archived one included, and a bookmark of two folders in each", async () => {
    const me = await account();
    const w = await workspace([me]);
    const rich = await bookmark(w, me, { title: "Rich", slug: "rich", forwarding: true, description: "About it", pinnedAt: new Date("2026-01-01T00:00:00Z") });
    const archived = await bookmark(w, me, { title: "Archived", archived: true });
    const alone = await bookmark(w, me, { title: "Alone" });
    await folder(w, me, "Reading", [rich, archived]);
    await folder(w, me, "Work", [rich]);
    await folder(w, me, "Empty");
    await tag(w, me, "news", [rich]);
    await tag(w, me, "alpha", [rich]);

    const reading = await section(w, me, "Reading");

    expect(reading.map((row) => row.id)).toEqual([rich, archived].sort());
    expect(reading.find((row) => row.id === rich)).toEqual({ id: rich, url: `https://example.com/${rich}`, title: "Rich", slug: "rich", tags: ["alpha", "news"] });
    expect(Object.keys(reading[0] ?? {}).sort()).toEqual(["id", "slug", "tags", "title", "url"]);
    expect(reading.find((row) => row.id === archived)).toMatchObject({ title: "Archived", slug: null, tags: [] });
    expect((await section(w, me, "Work")).map((row) => row.id)).toEqual([rich]);
    expect(await section(w, me, "Empty")).toEqual([]);
    expect(await section(w, me, "No such folder")).toEqual([]);
    expect(reading.map((row) => row.id)).not.toContain(alone);
  });

  it("list the folders the member owns, used or not, with their names, in the order of their identifiers, and resume after the last one, each exactly once", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me]);
    const made = [];
    for (const name of ["Zeta", "Alpha", "Mid", "Used"]) {
      made.push(await folder(w, me, name));
    }
    await folder(w, other, "Theirs");
    await folder(elsewhere, me, "Elsewhere");
    await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${w}, NULL, 'Ownerless')`);

    for (const pageSize of [1, 2, 3, 4, 5, 500]) {
      const rows = await sections(w, me, pageSize);
      expect(rows.map((row) => row.id), `page size ${String(pageSize)}`).toEqual(made);
      expect(rows.map((row) => row.name)).toEqual(["Zeta", "Alpha", "Mid", "Used"]);
    }
    expect(Object.keys((await sections(w, me))[0] ?? {}).sort()).toEqual(["id", "name"]);
  });

  it("keep a folder in its place and its bookmarks in its section when it is renamed between two pages", async () => {
    const me = await account();
    const w = await workspace([me]);
    const first = await bookmark(w, me, { title: "First" });
    const second = await bookmark(w, me, { title: "Second" });
    const third = await bookmark(w, me, { title: "Third" });
    const early = await folder(w, me, "Beta", [first, second, third]);
    await folder(w, me, "Gamma");
    const [head] = await asMember(w, me, (tx) => exportRepository(tx).sections(me, undefined, 1));
    const firstPage = await asMember(w, me, (tx) => exportRepository(tx).folderBookmarks(me, early, undefined, 2));

    await asSystem(db, (tx) => tx`UPDATE folders SET name = 'Aardvark' WHERE id = ${early}`);

    const rest = await asMember(w, me, (tx) => exportRepository(tx).folderBookmarks(me, early, firstPage[1]?.id, 2));
    expect(head).toEqual({ id: early, name: "Beta" });
    expect([...firstPage, ...rest].map((row) => row.id)).toEqual([first, second, third].sort());
    const next = await asMember(w, me, (tx) => exportRepository(tx).sections(me, early, 5));
    expect(next.map((row) => row.name)).toEqual(["Gamma"]);
    expect((await sections(w, me)).map((row) => row.name)).toEqual(["Aardvark", "Gamma"]);
  });

  it("resume after the last identifier of a page, each bookmark of a folder exactly once, whatever the page size", async () => {
    const me = await account();
    const w = await workspace([me]);
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) {
      ids.push(await bookmark(w, me, { title: `Title ${String(n)}` }));
    }
    await folder(w, me, "All", ids.slice(0, 6));
    for (const pageSize of [1, 2, 3, 6, 7, 500]) {
      expect((await section(w, me, "All", pageSize)).map((row) => row.id), `page size ${String(pageSize)}`).toEqual(ids.slice(0, 6).sort());
      expect((await unfiled(w, me, pageSize)).map((row) => row.id), `unfiled, page size ${String(pageSize)}`).toEqual([ids[6]]);
    }
  });

  it("hold in the unfiled one every bookmark of the member that is in none of its folders, in the order of the identifier, and none that is filed", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const loose = await bookmark(w, me, { title: "Loose", slug: "loose" });
    const archived = await bookmark(w, me, { title: "Archived loose", archived: true });
    const filed = await bookmark(w, me, { title: "Filed" });
    const inTheirs = await bookmark(w, me, { title: "Only in a folder of another member" });
    await folder(w, me, "Mine", [filed]);
    await folder(w, other, "Theirs", [inTheirs]);
    await tag(w, me, "t", [loose]);

    const rows = await unfiled(w, me);

    expect(rows.map((row) => row.id)).toEqual([loose, archived, inTheirs].sort());
    expect(rows.find((row) => row.id === loose)).toEqual({ id: loose, url: `https://example.com/${loose}`, title: "Loose", slug: "loose", tags: ["t"] });
  });

  it("never include another member's bookmark filed in the member's folder, one with no owner or of another workspace, nor another member's tag or folder", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, other]);
    const mine = await bookmark(w, me, { title: "Mine" });
    const theirs = await bookmark(w, other, { title: "Theirs", slug: "theirs", forwarding: true });
    const ownerless = await bookmark(w, null, { title: "Ownerless" });
    await bookmark(elsewhere, me, { title: "Elsewhere" });
    await bookmark(elsewhere, other, { title: "Elsewhere theirs" });
    await folder(w, me, "Shared name", [mine, theirs, ownerless]);
    const theirFolder = await folder(w, other, "Shared name too", [mine, theirs]);
    const foreignFolder = await folder(elsewhere, me, "Shared name", [await bookmark(elsewhere, me, { title: "Elsewhere filed" })]);
    const ownerlessFolder = freshId();
    await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${ownerlessFolder}, ${w}, NULL, 'Ownerless folder')`);
    await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${w}, ${ownerlessFolder}, ${mine})`);
    await tag(w, me, "my-tag", [mine]);
    await tag(w, other, "their-tag", [mine, theirs]);

    const rows = await section(w, me, "Shared name");

    expect(rows.map((row) => row.title)).toEqual(["Mine"]);
    expect(rows[0]?.tags).toEqual(["my-tag"]);
    expect(await section(w, me, "Shared name too")).toEqual([]);
    // The folders of the other member and of the other workspace are asked for by their identifiers, which a caller of the repository could know: they yield nothing for me.
    expect(await sectionOf(w, me, theirFolder)).toEqual([]);
    expect(await sectionOf(w, me, foreignFolder)).toEqual([]);
    expect(await sectionOf(w, me, ownerlessFolder)).toEqual([]);
    expect((await sections(w, me)).map((row) => row.name)).toEqual(["Shared name"]);
    expect((await unfiled(w, me)).map((row) => row.title)).toEqual([]);
    expect(JSON.stringify(await unfiled(w, other))).not.toMatch(/Mine|Ownerless|Elsewhere/);
    expect(await section(w, other, "Shared name")).toEqual([]);
    expect((await section(w, other, "Shared name too")).map((row) => row.title)).toEqual(["Theirs"]);
    expect((await unfiled(elsewhere, me)).map((row) => row.title)).toEqual(["Elsewhere"]);
  });

  it("are read for the account of the transaction only, with a positive whole page size", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    await asMember(w, me, async (tx) => {
      const repository = exportRepository(tx);
      await expect(repository.sections(other, undefined, 10)).rejects.toThrow("account of the transaction");
      await expect(repository.folderBookmarks(other, freshId(), undefined, 10)).rejects.toThrow("account of the transaction");
      await expect(repository.unfiledBookmarks(other, undefined, 10)).rejects.toThrow("account of the transaction");
      expect(() => folderBookmarksStatement(tx, me, freshId(), undefined, 0)).toThrow("positive whole limit");
      expect(() => sectionsStatement(tx, me, undefined, 0)).toThrow("positive whole limit");
      expect(() => unfiledBookmarksStatement(tx, me, undefined, 2.5)).toThrow("positive whole limit");
    });
  });
});

describe("the owner of a read", () => {
  it("is the account of the transaction: a read for another account is refused, whatever it names", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    await asMember(w, me, async (tx) => {
      const repository = exportRepository(tx);
      await expect(repository.summary(other, false)).rejects.toThrow("account of the transaction");
      await expect(repository.summary(other, true)).rejects.toThrow("account of the transaction");
      await expect(repository.shared(other, undefined, 10)).rejects.toThrow("account of the transaction");
      await expect(repository.folders(other, undefined, 10)).rejects.toThrow("account of the transaction");
      await expect(repository.tags(other, undefined, 10)).rejects.toThrow("account of the transaction");
      await expect(repository.bookmarks(other, undefined, 10)).rejects.toThrow("account of the transaction");
    });
  });

  it("is read with a positive whole page size only", async () => {
    const me = await account();
    const w = await workspace([me]);
    await asMember(w, me, (tx) => {
      expect(() => bookmarksStatement(tx, me, undefined, 0)).toThrow("positive whole limit");
      expect(() => bookmarksStatement(tx, me, undefined, 1.5)).toThrow("positive whole limit");
      return Promise.resolve();
    });
  });
});

// The plan of the page of bookmarks on a workspace of 30 000 bookmarks, a third of them the member's (doc 08 section 5.3): the statement walks the key of `bookmarks_workspace_id_id_key` from the
// identifier after which the page resumes and stops at the limit, and the links of each bookmark are probed through the indexes of the link tables, so no statement of the export scans the table of
// bookmarks or sorts the member's library for each page. The failure scenario: a statement that does not match an index (a missing workspace, a different order) plans a scan and a sort of the
// whole library for each of the hundreds of pages of an export.
describe("the pages of the export on a workspace of 30 000 bookmarks", () => {
  const BOOKMARKS = 30_000;
  const PAGE = 500;
  const SMALL_WORKSPACES = 2_000;
  const SMALL_BOOKMARKS = 50;
  const FIXTURE_TABLES = ["bookmarks", "folders", "tags", "folder_bookmarks", "bookmark_tags", "bookmark_shares"] as const;

  interface PlanNode {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    Plans?: PlanNode[];
  }

  const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

  let me: string;
  let w: string;
  let afterId: string;

  beforeAll(async () => {
    me = await account();
    const other = await account();
    const third = await account();
    w = await workspace([me, other, third]);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
        SELECT ('0192f3a0-bbbb-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, ${w}, (ARRAY[${me}, ${other}, ${third}]::uuid[])[1 + n % 3],
               'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 997), CASE WHEN n % 5 = 0 THEN 'slug-' || n END, n % 10 = 0
        FROM generate_series(1, ${BOOKMARKS}) AS n`,
    );
    await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ${w}, ${me}, 'Folder ' || n FROM generate_series(1, 30) AS n`);
    await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ${w}, ${me}, 'tag-' || n FROM generate_series(1, 40) AS n`);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id)
        SELECT ${w}::uuid, b.id, t.id FROM bookmarks b JOIN tags t ON t.workspace_id = b.workspace_id AND t.owner_id = b.owner_id AND t.name = 'tag-' || (1 + (right(b.url, 3))::int % 40)
        WHERE b.workspace_id = ${w} AND b.owner_id = ${me} AND right(b.url, 1) IN ('1', '2', '3') AND right(b.url, 3) ~ '^[0-9]+$'`,
    );
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id)
        SELECT ${w}::uuid, f.id, b.id FROM bookmarks b JOIN folders f ON f.workspace_id = b.workspace_id AND f.owner_id = b.owner_id AND f.name = 'Folder ' || (1 + (right(b.url, 3))::int % 30)
        WHERE b.workspace_id = ${w} AND b.owner_id = ${me} AND right(b.url, 1) IN ('4', '5') AND right(b.url, 3) ~ '^[0-9]+$'`,
    );
    // Some of another member's bookmarks are shared with the member, and the member's own sit beside them.
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by)
        SELECT gen_random_uuid(), ${w}, b.id, ${me}, ${other} FROM bookmarks b WHERE b.workspace_id = ${w} AND b.owner_id = ${other} AND right(b.url, 2) = '01'`,
    );
    // Many small workspaces beside it, so no workspace dominates a table: the member's library is a small part of every table the export reads.
    await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name) SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Small ' || n FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
    await asSystem(db, (tx) => tx`INSERT INTO workspace_members (workspace_id, account_id, role) SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, ${me}, 'owner' FROM generate_series(1, ${SMALL_WORKSPACES}) AS n`);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, ${me}, 'https://example.com/s' || w || '/' || n, 'https://example.com/s' || w || '/' || n, 'example.com', 'Small ' || w || ' ' || n
        FROM generate_series(1, ${SMALL_WORKSPACES}) AS w CROSS JOIN generate_series(1, ${SMALL_BOOKMARKS}) AS n`,
    );
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO folders (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, ${me}, 'F' || n
        FROM generate_series(1, ${SMALL_WORKSPACES}) AS w CROSS JOIN generate_series(1, 5) AS n`,
    );
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO tags (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(w::text, 12, '0'))::uuid, ${me}, 'T' || n
        FROM generate_series(1, ${SMALL_WORKSPACES}) AS w CROSS JOIN generate_series(1, 5) AS n`,
    );
    await db.owner.unsafe(`VACUUM (ANALYZE) ${FIXTURE_TABLES.join(", ")}`);
    const [middle] = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${w} ORDER BY id OFFSET ${BOOKMARKS / 2} LIMIT 1`);
    afterId = middle?.id ?? "";
  }, HOOK_TIMEOUT_MS);

  async function planOf(after: string | undefined): Promise<PlanNode[]> {
    const statement = await asMember(w, me, (tx) => Promise.resolve(dialect.sqlToQuery(bookmarksStatement(tx, me, after, PAGE))));
    const plan = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${me}, true), set_config('app.workspace_id', ${w}, true)`;
      const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
      return rows[0]?.["QUERY PLAN"][0]?.Plan;
    });
    if (plan === undefined) {
      throw new Error("EXPLAIN returned no plan");
    }
    return nodesOf(plan);
  }

  it("plans a page from the key of the workspace and the identifier, with no sequential scan of any table it reads", async () => {
    for (const after of [undefined, afterId]) {
      const nodes = await planOf(after);

      expect(nodes.filter((node) => node["Node Type"] === "Seq Scan")).toEqual([]);
      expect(nodes.map((node) => node["Index Name"])).toContain("bookmarks_workspace_id_id_key");
      expect(nodes.map((node) => node["Index Name"])).not.toContain("bookmarks_pkey");
    }
  });

  async function planOfStatement(statementOf: (tx: TenantTx) => SQL): Promise<PlanNode[]> {
    const statement = await asMember(w, me, (tx) => Promise.resolve(dialect.sqlToQuery(statementOf(tx))));
    const plan = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${me}, true), set_config('app.workspace_id', ${w}, true)`;
      const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
      return rows[0]?.["QUERY PLAN"][0]?.Plan;
    });
    if (plan === undefined) {
      throw new Error("EXPLAIN returned no plan");
    }
    return nodesOf(plan);
  }

  it("plans a page of the unfiled bookmarks from the key of the workspace and the identifier, a page of the folders, and a page of a folder from the key of its links, with no sequential scan of a table of bookmarks, folders or links", async () => {
    const big = (await asMember(w, me, (tx) => exportRepository(tx).sections(me, undefined, 2))).map((entry) => entry.id);
    expect(big).toHaveLength(2);
    for (const nodes of [
      await planOfStatement((tx) => sectionsStatement(tx, me, undefined, PAGE)),
      await planOfStatement((tx) => sectionsStatement(tx, me, big[0], PAGE)),
      await planOfStatement((tx) => unfiledBookmarksStatement(tx, me, undefined, PAGE)),
      await planOfStatement((tx) => unfiledBookmarksStatement(tx, me, afterId, PAGE)),
      ...(await Promise.all(big.map((id) => planOfStatement((tx) => folderBookmarksStatement(tx, me, id, undefined, PAGE))))),
    ]) {
      expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && ["bookmarks", "folders", "folder_bookmarks", "bookmark_tags"].includes(node["Relation Name"] ?? ""))).toEqual([]);
    }
    expect((await planOfStatement((tx) => unfiledBookmarksStatement(tx, me, afterId, PAGE))).map((node) => node["Index Name"])).toContain("bookmarks_workspace_id_id_key");
    expect((await planOfStatement((tx) => folderBookmarksStatement(tx, me, big[0] ?? "", undefined, PAGE))).map((node) => node["Index Name"])).toContain("folder_bookmarks_pkey");
  });

  it("plans a page of the shared bookmarks driven from the grants of the member, reading each bookmark by its key and scanning no table of bookmarks or links", async () => {
    const shared = await asMember(w, me, (tx) => exportRepository(tx).shared(me, undefined, PAGE));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.length).toBeLessThan(PAGE);
    expect(shared.every((row) => row.ownerName === null || row.ownerName.length > 0)).toBe(true);
    for (const nodes of [await planOfStatement((tx) => sharedStatement(tx, me, undefined, PAGE)), await planOfStatement((tx) => sharedStatement(tx, me, shared[3]?.id, PAGE))]) {
      expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && ["bookmarks", "folder_bookmarks"].includes(node["Relation Name"] ?? ""))).toEqual([]);
      expect(nodes.map((node) => node["Index Name"])).toContain("bookmarks_pkey");
    }
  });

  it("plans a page of the remembered slug choices from the member's own rows, reading the bookmarks through an index and scanning no table of bookmarks", async () => {
    const mine = await asSystem(db, (tx) => tx<{ id: string; slug: string }[]>`SELECT id, slug FROM bookmarks WHERE workspace_id = ${w} AND owner_id = ${me} AND forwarding AND slug IS NOT NULL LIMIT 300`);
    expect(mine.length).toBeGreaterThan(100);
    for (const row of mine) {
      await asSystem(db, (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${w}, ${me}, ${row.slug}, ${row.id})`);
    }
    await db.owner.unsafe("VACUUM (ANALYZE) slug_preferences");
    const page = await asMember(w, me, (tx) => exportRepository(tx).goPreferences(me, undefined, PAGE));
    expect(page).toHaveLength(mine.length);
    for (const nodes of [await planOfStatement((tx) => goPreferencesStatement(tx, me, undefined, PAGE)), await planOfStatement((tx) => goPreferencesStatement(tx, me, page[3]?.slug, PAGE))]) {
      expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "bookmarks")).toEqual([]);
      expect(nodes.filter((node) => node["Relation Name"] === "bookmarks" && node["Node Type"].startsWith("Index"))).not.toEqual([]);
    }
  });

  it("plans the summary, a page of the folders and a page of the tags with no sequential scan of the tables of bookmarks, folders and tags", async () => {
    const [name] = await asMember(w, me, (tx) => exportRepository(tx).tags(me, undefined, 1));
    for (const nodes of [
      await planOfStatement((tx) => summaryStatement(tx, me, true)),
      await planOfStatement((tx) => summaryStatement(tx, me, false)),
      await planOfStatement((tx) => foldersStatement(tx, me, undefined, PAGE)),
      await planOfStatement((tx) => foldersStatement(tx, me, "Folder 1", PAGE)),
      await planOfStatement((tx) => tagsStatement(tx, me, undefined, PAGE)),
      await planOfStatement((tx) => tagsStatement(tx, me, name, PAGE)),
    ]) {
      expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && ["bookmarks", "folders", "tags"].includes(node["Relation Name"] ?? ""))).toEqual([]);
    }
  });

  it("reads the member's whole library in pages that add up to it, each bookmark once", async () => {
    const rows = await allBookmarks(w, me, PAGE);

    expect(rows).toHaveLength(BOOKMARKS / 3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.map((row) => row.id)).toEqual(rows.map((row) => row.id).sort());
    const linked = rows.filter((row) => row.tags.length > 0 || row.folders.length > 0);
    expect(linked.length).toBeGreaterThan(0);
  });
});
