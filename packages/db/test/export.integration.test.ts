import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportRepository } from "../src/index.ts";
import { bookmarksStatement, folderBookmarksStatement, sectionsStatement, unfiledBookmarksStatement } from "../src/repositories/export.ts";
import type { TenantTx } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
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

    expect(await asMember(w, me, (tx) => exportRepository(tx).summary(me))).toEqual({ workspaceName: "Home", bookmarks: 2, folders: 1, tags: 2 });
    expect(await asMember(w, other, (tx) => exportRepository(tx).summary(other))).toEqual({ workspaceName: "Home", bookmarks: 1, folders: 1, tags: 1 });
  });

  it("is undefined for a workspace that is being deleted", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, { title: "One" });
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${w}`);

    expect(await asMember(w, me, (tx) => exportRepository(tx).summary(me))).toBeUndefined();
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
      await expect(repository.summary(other)).rejects.toThrow("account of the transaction");
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
  const FIXTURE_TABLES = ["bookmarks", "folders", "tags", "folder_bookmarks", "bookmark_tags"] as const;

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

  it("reads the member's whole library in pages that add up to it, each bookmark once", async () => {
    const rows = await allBookmarks(w, me, PAGE);

    expect(rows).toHaveLength(BOOKMARKS / 3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.map((row) => row.id)).toEqual(rows.map((row) => row.id).sort());
    const linked = rows.filter((row) => row.tags.length > 0 || row.folders.length > 0);
    expect(linked.length).toBeGreaterThan(0);
  });
});
