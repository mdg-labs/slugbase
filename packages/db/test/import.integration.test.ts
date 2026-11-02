import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle } from "../src/tenant.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The reads of the import preview (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1). The failure scenario: a duplicate found among another member's bookmarks, a plan-archived bookmark, a bookmark with no
// owner or another workspace's, and a room under the limit worked out from the rows and not from the counter of the workspace's row.
//
// The slugs, folders and tags of the import (Q30, doc 10 T2): a slug, a folder or a tag of another member of the workspace is never found, changed or taken for the importing member's, and each member gets their own;
// a slug that the account takes between the check and the insert costs the bookmark its slug and not the import.

const HOOK_TIMEOUT_MS = 300_000;

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
  await seedAccount(db, { id, email: `import${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(members: readonly string[]): Promise<string> {
  const id = await seedWorkspace(db, { name: "Import test" });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

async function bookmark(workspaceId: string, ownerId: string | null, canonical: string, archived = false): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${freshId()}, ${workspaceId}, ${ownerId}, ${canonical}, ${canonical}, 'example.com', 'Title', ${archived ? new Date() : null})`,
  );
}

function asMember<T>(workspaceId: string, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "import-test" }, work);
}

describe("the existing canonical URLs of the import preview", () => {
  it("are the member's own on bookmarks that are not plan-archived, each once, and nothing of another member's, of no owner's or of another workspace's", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me]);
    await bookmark(w, me, "https://example.com/mine");
    await bookmark(w, me, "https://example.com/mine");
    await bookmark(w, me, "https://example.com/archived", true);
    await bookmark(w, other, "https://example.com/members");
    await bookmark(w, null, "https://example.com/ownerless");
    await bookmark(elsewhere, me, "https://example.com/other-workspace");
    const asked = ["https://example.com/mine", "https://example.com/archived", "https://example.com/members", "https://example.com/ownerless", "https://example.com/other-workspace", "https://example.com/unknown"];

    const found = await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls(asked));
    const foundByOther = await asMember(w, other, (tx) => importRepository(tx).existingCanonicalUrls(asked));

    expect([...found]).toEqual(["https://example.com/mine"]);
    expect([...foundByOther]).toEqual(["https://example.com/members"]);
  });

  it("answer a whole file of canonical URLs, and nothing for none", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (let n = 0; n < 50; n += 1) {
      await bookmark(w, me, `https://example.com/${String(n)}`);
    }
    const asked = Array.from({ length: 5000 }, (_, n) => `https://example.com/${String(n)}`);

    const found = await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls(asked));
    const none = await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls([]));

    expect(found.size).toBe(50);
    expect(none.size).toBe(0);
  });

  it("match a URL as text, whatever characters it holds", async () => {
    const me = await account();
    const w = await workspace([me]);
    const odd = "https://example.com/a'b\"c\\d%e_f,g)h";
    await bookmark(w, me, odd);

    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls([odd, "https://example.com/a'b' OR '1'='1"])))]).toEqual([odd]);
  });

  it("need a transaction opened with a workspace", async () => {
    const me = await account();
    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).existingCanonicalUrls(["https://example.com/"]))).rejects.toThrow(/workspace/);
    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).bookmarkCount())).rejects.toThrow(/workspace/);
  });
});

describe("the bookmark counter of the import preview", () => {
  it("is the counter of the workspace's row and not a count of its bookmarks", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, "https://example.com/a");
    await bookmark(w, me, "https://example.com/b");
    await bookmark(w, me, "https://example.com/c", true);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 7 WHERE id = ${w}`);

    expect(await asMember(w, me, (tx) => importRepository(tx).bookmarkCount())).toBe(7);
  });

  it("is undefined for a workspace the account is no member of", async () => {
    const me = await account();
    const stranger = await account();
    const w = await workspace([me]);

    expect(await asMember(w, stranger, (tx) => importRepository(tx).bookmarkCount())).toBeUndefined();
    expect(await asMember(w, me, (tx) => importRepository(tx).bookmarkCount())).toBe(0);
  });
});

async function counterAndRows(workspaceId: string): Promise<{ counter: number; rows: number; counted: number }> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ counter: number; rows: number; counted: number }[]>`
      SELECT (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter,
        (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows,
        (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND plan_archived_at IS NULL)::int AS counted`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("no row");
  }
  return row;
}

async function setCounter(workspaceId: string, count: number): Promise<void> {
  await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = ${count} WHERE id = ${workspaceId}`);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("the places the import takes under the ceiling", () => {
  it("are all it asked for under no ceiling or room enough, and raise the counter once by that number", async () => {
    const me = await account();
    const w = await workspace([me]);

    const unlimited = await asMember(w, me, (tx) => importRepository(tx).takePlaces(null, 40));
    const within = await asMember(w, me, (tx) => importRepository(tx).takePlaces(100, 60));
    const none = await asMember(w, me, (tx) => importRepository(tx).takePlaces(100, 0));

    expect(unlimited).toEqual({ kind: "taken", taken: 40, used: 40 });
    expect(within).toEqual({ kind: "taken", taken: 60, used: 100 });
    expect(none).toEqual({ kind: "taken", taken: 0, used: 100 });
    expect((await counterAndRows(w)).counter).toBe(100);
  });

  it("are as many as the room under the ceiling holds, from the counter and not from the rows, and none when the counter is at or over the ceiling", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, "https://example.com/a");
    await setCounter(w, 7);

    const partial = await asMember(w, me, (tx) => importRepository(tx).takePlaces(10, 5));
    const full = await asMember(w, me, (tx) => importRepository(tx).takePlaces(10, 5));
    const lowered = await asMember(w, me, (tx) => importRepository(tx).takePlaces(4, 1));
    const zero = await asMember(w, me, (tx) => importRepository(tx).takePlaces(0, 1));

    expect(partial).toEqual({ kind: "taken", taken: 3, used: 10 });
    expect(full).toEqual({ kind: "taken", taken: 0, used: 10 });
    expect(lowered).toEqual({ kind: "taken", taken: 0, used: 10 });
    expect(zero).toEqual({ kind: "taken", taken: 0, used: 10 });
    expect((await counterAndRows(w)).counter).toBe(10);
  });

  it("answer limit_reached with the places taken and the count after them, and taken when all were", async () => {
    const me = await account();
    const w = await workspace([me]);
    await setCounter(w, 2);

    const [short, enough] = await appAs({ accountId: me, workspaceId: w }, async (tx) => [
      await tx<{ outcome: string; taken: number; used: number }[]>`SELECT * FROM sys_bookmark_count_take_many(${w}::uuid, 5, 4)`,
      await tx<{ outcome: string; taken: number; used: number }[]>`SELECT * FROM sys_bookmark_count_take_many(${w}::uuid, 50, 0)`,
    ]);

    expect(short).toEqual([{ outcome: "limit_reached", taken: 3, used: 5 }]);
    expect(enough).toEqual([{ outcome: "taken", taken: 0, used: 5 }]);
  });

  it("are not taken in a workspace other than the one the transaction acts in, for an account that is no member, or for a workspace being deleted", async () => {
    const me = await account();
    const stranger = await account();
    const a = await workspace([me]);
    const b = await workspace([me]);
    const deleting = await workspace([me]);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${deleting}`);

    const foreign = await appAs({ accountId: me, workspaceId: a }, (tx) => tx<{ outcome: string; taken: number | null; used: number | null }[]>`SELECT * FROM sys_bookmark_count_take_many(${b}::uuid, NULL, 3)`);
    const noAccount = await appAs({ accountId: me, workspaceId: a }, (tx) => tx`SELECT set_config('app.account_id', '', true)`.then(() => tx<{ outcome: string }[]>`SELECT outcome FROM sys_bookmark_count_take_many(${a}::uuid, NULL, 3)`));

    expect(foreign).toEqual([{ outcome: "unavailable", taken: null, used: null }]);
    expect(noAccount).toEqual([{ outcome: "unavailable" }]);
    expect(await asMember(a, stranger, (tx) => importRepository(tx).takePlaces(null, 3))).toEqual({ kind: "unavailable" });
    expect(await asMember(deleting, me, (tx) => importRepository(tx).takePlaces(null, 3))).toEqual({ kind: "unavailable" });
    expect((await counterAndRows(a)).counter).toBe(0);
    expect((await counterAndRows(b)).counter).toBe(0);
    expect((await counterAndRows(deleting)).counter).toBe(0);
  });

  it("are refused for a number of places that is null, negative or over 5 000 and for a negative ceiling, writing nothing", async () => {
    const me = await account();
    const w = await workspace([me]);
    const call = (max: string, wanted: string) => appAs({ accountId: me, workspaceId: w }, (tx) => tx.unsafe(`SELECT * FROM sys_bookmark_count_take_many('${w}'::uuid, ${max}, ${wanted})`));

    expect(await codeOf(call("NULL", "NULL"))).toBe("22023");
    expect(await codeOf(call("NULL", "-1"))).toBe("22023");
    expect(await codeOf(call("NULL", "5001"))).toBe("22023");
    expect(await codeOf(call("-1", "1"))).toBe("22023");
    expect(await codeOf(call("NULL", "5000"))).toBeUndefined();
    expect((await counterAndRows(w)).counter).toBe(5000);
  });

  it("are taken one after the other when two imports ask at once, so together they never pass the ceiling", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    await setCounter(w, 8);

    const taken = await Promise.all([
      asMember(w, me, (tx) => importRepository(tx).takePlaces(10, 5)),
      asMember(w, other, (tx) => importRepository(tx).takePlaces(10, 5)),
    ]);

    expect(taken.map((answer) => (answer.kind === "taken" ? answer.taken : -1)).sort()).toEqual([0, 2]);
    expect((await counterAndRows(w)).counter).toBe(10);
  });
});

describe("the bookmarks the import inserts", () => {
  const row = (id: string, ownerId: string, url: string, overrides: Partial<{ title: string; description: string | null; pinned: boolean; slug: string | null; forwarding: boolean }> = {}) => ({
    id,
    ownerId,
    url,
    urlCanonical: url,
    host: "example.com",
    title: "Title",
    description: null,
    pinned: false,
    slug: null,
    forwarding: false,
    ...overrides,
  });

  it("are the account's own in the workspace of the transaction, pinned or not, archived never, and the counter follows them", async () => {
    const me = await account();
    const w = await workspace([me]);
    const first = freshId();
    const second = freshId();

    await asMember(w, me, async (tx) => {
      const repository = importRepository(tx);
      await repository.takePlaces(null, 2);
      await repository.insertBookmarks({
        bookmarks: [row(first, me, "https://example.com/a", { title: "A", description: "About" }), row(second, me, "https://example.com/b", { pinned: true })],
        jobs: [],
      });
    });

    const stored = await asSystem(
      db,
      (tx) => tx<{ id: string; workspace_id: string; owner_id: string; title: string; description: string | null; pinned: boolean; archived: boolean; slug: string | null; version: number }[]>`
        SELECT id, workspace_id, owner_id, title, description, pinned_at IS NOT NULL AS pinned, plan_archived_at IS NOT NULL AS archived, slug, version FROM bookmarks WHERE workspace_id = ${w} ORDER BY url`,
    );
    expect(stored).toEqual([
      { id: first, workspace_id: w, owner_id: me, title: "A", description: "About", pinned: false, archived: false, slug: null, version: 1 },
      { id: second, workspace_id: w, owner_id: me, title: "Title", description: null, pinned: true, archived: false, slug: null, version: 1 },
    ]);
    expect(await counterAndRows(w)).toEqual({ counter: 2, rows: 2, counted: 2 });
  });

  it("keep text as text: a title or URL with quotes, backslashes and braces is stored as given", async () => {
    const me = await account();
    const w = await workspace([me]);
    const odd = "https://example.com/a'b\"c\\d{e}[f]";
    const title = "T'\"\\{}[]";

    await asMember(w, me, async (tx) => {
      await importRepository(tx).takePlaces(null, 1);
      await importRepository(tx).insertBookmarks({ bookmarks: [row(freshId(), me, odd, { title })], jobs: [] });
    });

    const stored = await asSystem(db, (tx) => tx<{ url: string; title: string }[]>`SELECT url, title FROM bookmarks WHERE workspace_id = ${w}`);
    expect(stored).toEqual([{ url: odd, title }]);
  });

  it("are not written for an account other than the one of the transaction, and nothing is written for the batch", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);

    await expect(
      asMember(w, me, (tx) => importRepository(tx).insertBookmarks({ bookmarks: [row(freshId(), me, "https://example.com/a"), row(freshId(), other, "https://example.com/b")], jobs: [] })),
    ).rejects.toThrow(/own bookmarks/);

    expect((await counterAndRows(w)).rows).toBe(0);
  });

  it("are not written in another workspace: a transaction that acts in A cannot insert into B", async () => {
    const me = await account();
    const a = await workspace([me]);
    const b = await workspace([me]);

    const code = await codeOf(
      appAs({ accountId: me, workspaceId: a }, (tx) =>
        tx`INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title) VALUES (${freshId()}, ${b}, ${me}, 'https://example.com/x', 'https://example.com/x', 'example.com', 'X')`,
      ),
    );

    expect(code).toBe("42501");
    expect((await counterAndRows(b)).rows).toBe(0);
  });

  it("leave neither a bookmark nor a place taken when a later write of the transaction fails", async () => {
    const me = await account();
    const w = await workspace([me]);

    await expect(
      asMember(w, me, async (tx) => {
        const repository = importRepository(tx);
        await repository.takePlaces(null, 2);
        await repository.insertBookmarks({ bookmarks: [row(freshId(), me, "https://example.com/a"), row(freshId(), me, "https://example.com/b")], jobs: [] });
        throw new Error("a later write failed");
      }),
    ).rejects.toThrow("a later write failed");

    expect(await counterAndRows(w)).toEqual({ counter: 0, rows: 0, counted: 0 });
  });

  it("are written from an empty batch without a statement, and need a transaction opened with a workspace", async () => {
    const me = await account();
    const w = await workspace([me]);

    await asMember(w, me, (tx) => importRepository(tx).insertBookmarks({ bookmarks: [], jobs: [] }));

    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).takePlaces(null, 1))).rejects.toThrow(/workspace/);
    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).insertBookmarks({ bookmarks: [], jobs: [] }))).rejects.toThrow(/workspace/);
    expect((await counterAndRows(w)).rows).toBe(0);
  });
});

interface SeededFolder {
  readonly id: string;
  readonly name: string;
}

async function seedFolder(workspaceId: string, ownerId: string | null, name: string, icon = "folder", color = 1): Promise<SeededFolder> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name, icon, color) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name}, ${icon}, ${color})`);
  return { id, name };
}

async function seedTag(workspaceId: string, ownerId: string, name: string): Promise<SeededFolder> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return { id, name };
}

async function seedSlug(workspaceId: string, ownerId: string | null, slug: string, archived = false): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, ${`https://example.com/${slug}`}, ${`https://example.com/${slug}`}, 'example.com', 'Title', ${slug}, ${archived ? new Date() : null})`,
  );
  return id;
}

interface StoredFolder {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

const foldersOf = (workspaceId: string) =>
  asSystem(db, (tx) => tx<StoredFolder[]>`SELECT id, owner_id, name::text AS name, icon, color FROM folders WHERE workspace_id = ${workspaceId} ORDER BY owner_id, name::text COLLATE "C"`);

const tagsOf = (workspaceId: string) => asSystem(db, (tx) => tx<{ id: string; owner_id: string; name: string }[]>`SELECT id, owner_id, name::text AS name FROM tags WHERE workspace_id = ${workspaceId} ORDER BY owner_id, name::text COLLATE "C"`);

describe("the slugs the import checks", () => {
  it("are the account's own on any bookmark of the workspace, plan-archived ones included, and nothing of another member's, of no owner's or of another workspace's", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me]);
    await seedSlug(w, me, "mine");
    await seedSlug(w, me, "archived", true);
    await seedSlug(w, other, "members");
    await seedSlug(w, null, "ownerless");
    await seedSlug(elsewhere, me, "other-workspace");
    const asked = ["mine", "archived", "members", "ownerless", "other-workspace", "unknown"];

    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingSlugs(asked)))].sort()).toEqual(["archived", "mine"]);
    expect([...(await asMember(w, other, (tx) => importRepository(tx).existingSlugs(asked)))]).toEqual(["members"]);
    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingSlugs([])))]).toEqual([]);
  });
});

describe("the folder and tag names the import checks", () => {
  it("are those the account has, matched without regard to case and answered as they were asked, and nothing of another member's, of no owner's or of another workspace's", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me]);
    await seedFolder(w, me, "Work");
    await seedFolder(w, other, "Theirs");
    await seedFolder(w, null, "Ownerless");
    await seedFolder(elsewhere, me, "Elsewhere");
    await seedTag(w, me, "News");
    await seedTag(w, other, "Private");
    await seedTag(elsewhere, me, "Away");

    const folderNames = ["WORK", "work", "Theirs", "Ownerless", "Elsewhere", "Nothing"];
    const tagNames = ["news", "Private", "Away", "Nothing"];
    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingFolderNames(folderNames)))].sort()).toEqual(["WORK", "work"]);
    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingTagNames(tagNames)))]).toEqual(["news"]);
    expect([...(await asMember(w, other, (tx) => importRepository(tx).existingFolderNames(folderNames)))]).toEqual(["Theirs"]);
    expect([...(await asMember(w, other, (tx) => importRepository(tx).existingTagNames(tagNames)))]).toEqual(["Private"]);
    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingFolderNames([])))]).toEqual([]);
  });

  it("match a name as text, whatever characters it holds", async () => {
    const me = await account();
    const w = await workspace([me]);
    const odd = "a'b\"c\\d%e_f,g)h{}";
    await seedFolder(w, me, odd);

    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingFolderNames([odd, "a' OR '1'='1"])))]).toEqual([odd]);
  });
});

describe("the folders and tags the import gets or creates", () => {
  it("use the account's own folder or tag of the name, whatever the case, with its icon and colour and without a new row, and create the others with the icon and colour asked", async () => {
    const me = await account();
    const w = await workspace([me]);
    const work = await seedFolder(w, me, "Work", "briefcase", 4);
    const news = await seedTag(w, me, "News");
    const ids = [freshId(), freshId(), freshId(), freshId()];

    const folders = await asMember(w, me, (tx) =>
      importRepository(tx).resolveFolders([
        { id: ids[0] ?? "", name: "WORK", icon: "star", color: 8 },
        { id: ids[1] ?? "", name: "Reading", icon: "book-open", color: 2 },
      ]),
    );
    const tags = await asMember(w, me, (tx) =>
      importRepository(tx).resolveTags([
        { id: ids[2] ?? "", name: "news" },
        { id: ids[3] ?? "", name: "Later" },
      ]),
    );

    expect(folders.created).toBe(1);
    expect(folders.ids.get("WORK")).toBe(work.id);
    expect(folders.ids.get("Reading")).toBe(ids[1]);
    expect(tags.created).toBe(1);
    expect(tags.ids.get("news")).toBe(news.id);
    expect(tags.ids.get("Later")).toBe(ids[3]);
    expect((await foldersOf(w)).map((folder) => [folder.name, folder.icon, folder.color])).toEqual([
      ["Reading", "book-open", 2],
      ["Work", "briefcase", 4],
    ]);
    expect((await tagsOf(w)).map((tag) => tag.name)).toEqual(["Later", "News"]);
  });

  it("leave another member's folders, tags and slugs as they are when that member's names are imported by the caller, who gets their own folder, tag and slug (T2)", async () => {
    const a = await account();
    const b = await account();
    const w = await workspace([a, b]);
    const workOfA = await seedFolder(w, a, "Work", "briefcase", 5);
    const newsOfA = await seedTag(w, a, "News");
    const mailOfA = await seedSlug(w, a, "mail");
    const bId = { folder: freshId(), tag: freshId(), bookmark: freshId() };

    const taken = await asMember(w, b, (tx) => importRepository(tx).existingSlugs(["mail"]));
    const resolved = await asMember(w, b, async (tx) => {
      const repository = importRepository(tx);
      const folders = await repository.resolveFolders([{ id: bId.folder, name: "work", icon: "star", color: 2 }]);
      const tags = await repository.resolveTags([{ id: bId.tag, name: "NEWS" }]);
      await repository.takePlaces(null, 1);
      const inserted = await repository.insertBookmarks({
        bookmarks: [{ id: bId.bookmark, ownerId: b, url: "https://example.com/b", urlCanonical: "https://example.com/b", host: "example.com", title: "B", description: null, pinned: false, slug: "mail", forwarding: true }],
        jobs: [],
      });
      await repository.linkBookmarks({ folders: [{ bookmarkId: bId.bookmark, folderId: bId.folder }], tags: [{ bookmarkId: bId.bookmark, tagId: bId.tag }] });
      return { folders, tags, inserted };
    });

    expect([...taken]).toEqual([]);
    expect(resolved.folders).toMatchObject({ created: 1 });
    expect(resolved.folders.ids.get("work")).toBe(bId.folder);
    expect(resolved.tags.ids.get("NEWS")).toBe(bId.tag);
    expect(resolved.inserted).toEqual({ slugsLost: [] });
    expect(await foldersOf(w)).toEqual(
      expect.arrayContaining([
        { id: workOfA.id, owner_id: a, name: "Work", icon: "briefcase", color: 5 },
        { id: bId.folder, owner_id: b, name: "work", icon: "star", color: 2 },
      ]),
    );
    expect((await foldersOf(w)).length).toBe(2);
    expect((await tagsOf(w)).map((tag) => [tag.id, tag.owner_id, tag.name])).toEqual(
      [
        [newsOfA.id, a, "News"],
        [bId.tag, b, "NEWS"],
      ].sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    );
    const bookmarksStored = await asSystem(db, (tx) => tx<{ id: string; owner_id: string; slug: string; forwarding: boolean }[]>`SELECT id, owner_id, slug, forwarding FROM bookmarks WHERE workspace_id = ${w} ORDER BY owner_id`);
    expect(bookmarksStored.map((row) => [row.id, row.owner_id, row.slug, row.forwarding]).sort()).toEqual(
      [
        [mailOfA, a, "mail", false],
        [bId.bookmark, b, "mail", true],
      ].sort(),
    );
  });

  it("do not create a folder in a workspace other than the one the transaction acts in", async () => {
    const me = await account();
    const a = await workspace([me]);
    const b = await workspace([me]);

    const code = await codeOf(
      appAs({ accountId: me, workspaceId: a }, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${b}, ${me}, 'Sneaked')`),
    );

    expect(code).toBe("42501");
    expect(await foldersOf(b)).toEqual([]);
  });

  it("create a name that two transactions of the account create at once only once, and neither fails, though they ask for the names in opposite orders", async () => {
    const me = await account();
    const w = await workspace([me]);
    const names = ["Alpha", "bravo", "Charlie", "delta", "Echo"];
    const entries = (list: readonly string[]) => list.map((name) => ({ id: freshId(), name, icon: "folder", color: 1 }));

    const [first, second] = await Promise.all([
      asMember(w, me, (tx) => importRepository(tx).resolveFolders(entries(names))),
      asMember(w, me, (tx) => importRepository(tx).resolveFolders(entries([...names].reverse()))),
    ]);
    const tagged = await Promise.all([
      asMember(w, me, (tx) => importRepository(tx).resolveTags(entries(names))),
      asMember(w, me, (tx) => importRepository(tx).resolveTags(entries([...names].reverse()))),
    ]);

    expect(first.created + second.created).toBe(5);
    expect(tagged[0].created + tagged[1].created).toBe(5);
    expect([...first.ids.values()].sort()).toEqual([...second.ids.values()].sort());
    expect((await foldersOf(w)).map((folder) => folder.name)).toEqual(["Alpha", "Charlie", "Echo", "bravo", "delta"]);
    expect((await tagsOf(w)).length).toBe(5);
  });

  it("leave no folder and no tag when a later write of the transaction fails", async () => {
    const me = await account();
    const w = await workspace([me]);

    await expect(
      asMember(w, me, async (tx) => {
        await importRepository(tx).resolveFolders([{ id: freshId(), name: "Gone", icon: "folder", color: 1 }]);
        await importRepository(tx).resolveTags([{ id: freshId(), name: "Gone" }]);
        throw new Error("a later write failed");
      }),
    ).rejects.toThrow("a later write failed");

    expect(await foldersOf(w)).toEqual([]);
    expect(await tagsOf(w)).toEqual([]);
  });

  it("need a transaction opened with a workspace, and a name that is a UUID-shaped identifier only", async () => {
    const me = await account();
    const w = await workspace([me]);

    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).resolveFolders([{ id: freshId(), name: "F", icon: "folder", color: 1 }]))).rejects.toThrow(/workspace/);
    await expect(asMember(w, me, (tx) => importRepository(tx).resolveTags([{ id: "not-an-id", name: "T" }]))).rejects.toThrow(/identifiers/);
  });
});

describe("the slugs the import inserts", () => {
  const newRow = (me: string, id: string, slug: string | null, forwarding = false) => ({
    id,
    ownerId: me,
    url: `https://example.com/${id}`,
    urlCanonical: `https://example.com/${id}`,
    host: "example.com",
    title: "Title",
    description: null,
    pinned: false,
    slug,
    forwarding,
  });

  it("are written with their bookmark and their forwarding, and a slug that another member has is no conflict", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    await seedSlug(w, other, "shared-name");
    const mine = freshId();
    const plain = freshId();

    const answer = await asMember(w, me, async (tx) => {
      await importRepository(tx).takePlaces(null, 2);
      return importRepository(tx).insertBookmarks({ bookmarks: [newRow(me, mine, "shared-name", true), newRow(me, plain, null)], jobs: [] });
    });

    expect(answer).toEqual({ slugsLost: [] });
    const stored = await asSystem(db, (tx) => tx<{ id: string; slug: string | null; forwarding: boolean }[]>`SELECT id, slug, forwarding FROM bookmarks WHERE owner_id = ${me}`);
    expect(stored.map((row) => [row.id, row.slug, row.forwarding]).sort()).toEqual([[mine, "shared-name", true], [plain, null, false]].sort());
  });

  it("are lost, and the bookmark is inserted without the slug and the forwarding, when the account has the slug on a bookmark by the insert (a slug it took after the check), plan-archived or not, and the others of the batch are written as asked", async () => {
    const me = await account();
    const w = await workspace([me]);
    const checked = await asMember(w, me, (tx) => importRepository(tx).existingSlugs(["raced", "archived-raced", "free"]));
    await seedSlug(w, me, "raced");
    await seedSlug(w, me, "archived-raced", true);
    const [raced, archived, free, none] = [freshId(), freshId(), freshId(), freshId()];

    const answer = await asMember(w, me, async (tx) => {
      await importRepository(tx).takePlaces(null, 4);
      return importRepository(tx).insertBookmarks({
        bookmarks: [newRow(me, raced, "raced", true), newRow(me, archived, "archived-raced", true), newRow(me, free, "free", true), newRow(me, none, null)],
        jobs: [],
      });
    });

    expect([...checked]).toEqual([]);
    expect([...answer.slugsLost].sort()).toEqual([raced, archived].sort());
    const stored = await asSystem(db, (tx) => tx<{ id: string; slug: string | null; forwarding: boolean }[]>`SELECT id, slug, forwarding FROM bookmarks WHERE id IN (${raced}, ${archived}, ${free}, ${none})`);
    expect(Object.fromEntries(stored.map((row) => [row.id, [row.slug, row.forwarding]]))).toEqual({
      [raced]: [null, false],
      [archived]: [null, false],
      [free]: ["free", true],
      [none]: [null, false],
    });
    expect(await counterAndRows(w)).toMatchObject({ counter: 4, rows: 6, counted: 5 });
  });

  it("are lost without failing the import when another transaction of the account commits the slug while the insert waits for it", async () => {
    const me = await account();
    const w = await workspace([me]);
    const id = freshId();
    const rivalSlug = "contended";
    let commit: () => void = () => undefined;
    const rivalMayCommit = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let rivalInserted: () => void = () => undefined;
    const rivalHolds = new Promise<void>((resolve) => {
      rivalInserted = resolve;
    });
    let rivalPid = 0;
    const rival = db.owner.begin(async (tx) => {
      rivalPid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? 0;
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug)
        VALUES (${freshId()}, ${w}, ${me}, 'https://example.com/rival', 'https://example.com/rival', 'example.com', 'Rival', ${rivalSlug})`;
      rivalInserted();
      await rivalMayCommit;
    });
    try {
      await rivalHolds;
      const checked = await asMember(w, me, (tx) => importRepository(tx).existingSlugs([rivalSlug]));
      let importerPid = 0;
      const importing = asMember(w, me, async (tx) => {
        importerPid = (await tenantHandle(tx).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]?.pid ?? 0;
        await importRepository(tx).takePlaces(null, 1);
        return importRepository(tx).insertBookmarks({ bookmarks: [newRow(me, id, rivalSlug, true)], jobs: [] });
      });
      // The insert is the one that waits: its own backend waits for a transaction id and the rival's backend is what blocks it, whatever other test files do in the cluster. The probe runs on the application pool, as the rival holds a connection of the owner pool.
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (importerPid !== 0) {
          const waiting = await db.app<{ waits: boolean; blockedByRival: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${importerPid} AND NOT granted AND locktype = 'transactionid') AS waits,
              ${rivalPid} = ANY (pg_blocking_pids(${importerPid})) AS "blockedByRival"`;
          if (waiting[0]?.waits === true && waiting[0].blockedByRival) {
            break;
          }
        }
        if (Date.now() > deadline) {
          throw new Error("the insert did not wait for the rival's slug");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      commit();
      await rival;

      expect([...checked]).toEqual([]);
      expect(await importing).toEqual({ slugsLost: [id] });
      const stored = await asSystem(db, (tx) => tx<{ slug: string | null; forwarding: boolean }[]>`SELECT slug, forwarding FROM bookmarks WHERE id = ${id}`);
      expect(stored).toEqual([{ slug: null, forwarding: false }]);
    } finally {
      commit();
      await rival.catch(() => undefined);
    }
  });

  it("are refused as an insert that leaves out a bookmark with no slug", async () => {
    const me = await account();
    const w = await workspace([me]);
    const id = freshId();

    await expect(
      asMember(w, me, async (tx) => {
        await importRepository(tx).takePlaces(null, 2);
        await importRepository(tx).insertBookmarks({ bookmarks: [newRow(me, id, null)], jobs: [] });
        return importRepository(tx).insertBookmarks({ bookmarks: [newRow(me, id, null)], jobs: [] });
      }),
    ).rejects.toThrow(/no slug/);
    expect((await counterAndRows(w)).rows).toBe(0);
  });
});

describe("the names the import tells apart", () => {
  it("answers for each name the place of the first one that citext compares as the same, the comparison the unique index of the names makes", async () => {
    const me = await account();
    const w = await workspace([me]);
    const names = ["Work", "WORK", "Caf\u00E9", "work", "\u00C4b", "\u00E4b", "\u039F\u0394\u039F\u03A3", "\u03BF\u03B4\u03BF\u03C2", "\u03BF\u03B4\u03BF\u03C3", "\u0130", "i", "\uA7CE", "\uA7CF", "Work"];
    const compared = await db.owner<{ n: number; first: number }[]>`
      SELECT a.n::integer - 1 AS n, min(b.n)::integer - 1 AS first
      FROM unnest(${names}::text[]) WITH ORDINALITY AS a(name, n)
      JOIN unnest(${names}::text[]) WITH ORDINALITY AS b(name, n) ON a.name::citext = b.name::citext
      GROUP BY a.n ORDER BY a.n`;

    const first = await asMember(w, me, (tx) => importRepository(tx).firstSameNames(names));
    const created = await asMember(w, me, (tx) => importRepository(tx).resolveFolders(names.map((name) => ({ id: freshId(), name, icon: "folder", color: 1 }))));

    expect([...first]).toEqual(compared.map((row) => row.first));
    expect(first.slice(0, 4)).toEqual([0, 0, 2, 0]);
    expect(first[13]).toBe(0);
    expect(created.created).toBe(new Set(first).size);
    expect([...(await asMember(w, me, (tx) => importRepository(tx).firstSameNames([])))]).toEqual([]);
  });
});

describe("the links the import writes", () => {
  it("file and tag each bookmark in its own folders and with its own tags, and leave the links that exist", async () => {
    const me = await account();
    const w = await workspace([me]);
    const [x, y] = [freshId(), freshId()];
    const [folderOne, folderTwo] = [await seedFolder(w, me, "One"), await seedFolder(w, me, "Two")];
    const [tagOne, tagTwo] = [await seedTag(w, me, "One"), await seedTag(w, me, "Two")];
    const row = (id: string) => ({ id, ownerId: me, url: `https://example.com/${id}`, urlCanonical: `https://example.com/${id}`, host: "example.com", title: "T", description: null, pinned: false, slug: null, forwarding: false });

    await asMember(w, me, async (tx) => {
      const repository = importRepository(tx);
      await repository.takePlaces(null, 2);
      await repository.insertBookmarks({ bookmarks: [row(x), row(y)], jobs: [] });
      const links = {
        folders: [
          { bookmarkId: x, folderId: folderOne.id },
          { bookmarkId: y, folderId: folderOne.id },
          { bookmarkId: y, folderId: folderTwo.id },
        ],
        tags: [
          { bookmarkId: x, tagId: tagTwo.id },
          { bookmarkId: y, tagId: tagOne.id },
        ],
      };
      await repository.linkBookmarks(links);
      await repository.linkBookmarks(links);
      await repository.linkBookmarks({ folders: [], tags: [] });
    });

    const stored = await asSystem(
      db,
      (tx) => tx<{ link: string }[]>`
        SELECT 'f:' || bookmark_id || '/' || folder_id AS link FROM folder_bookmarks WHERE workspace_id = ${w}
        UNION ALL SELECT 't:' || bookmark_id || '/' || tag_id FROM bookmark_tags WHERE workspace_id = ${w}`,
    );
    expect(stored.map((entry) => entry.link).sort()).toEqual(
      [`f:${x}/${folderOne.id}`, `f:${y}/${folderOne.id}`, `f:${y}/${folderTwo.id}`, `t:${x}/${tagTwo.id}`, `t:${y}/${tagOne.id}`].sort(),
    );
  });

  it("refuse a folder or a tag of another member or of another workspace, writing no link", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace([me, other]);
    const b = await workspace([me]);
    const mine = freshId();
    const theirFolder = await seedFolder(a, other, "Theirs");
    const theirTag = await seedTag(a, other, "Theirs");
    const farFolder = await seedFolder(b, me, "Far");
    const row = { id: mine, ownerId: me, url: "https://example.com/m", urlCanonical: "https://example.com/m", host: "example.com", title: "T", description: null, pinned: false, slug: null, forwarding: false };

    for (const links of [
      { folders: [{ bookmarkId: mine, folderId: theirFolder.id }], tags: [] },
      { folders: [], tags: [{ bookmarkId: mine, tagId: theirTag.id }] },
      { folders: [{ bookmarkId: mine, folderId: farFolder.id }], tags: [] },
    ]) {
      await expect(
        asMember(a, me, async (tx) => {
          await importRepository(tx).takePlaces(null, 1);
          await importRepository(tx).insertBookmarks({ bookmarks: [row], jobs: [] });
          await importRepository(tx).linkBookmarks(links);
        }),
      ).rejects.toThrow();
    }
    const stored = await asSystem(db, (tx) => tx<{ count: number }[]>`SELECT (SELECT count(*) FROM folder_bookmarks WHERE workspace_id IN (${a}, ${b})) + (SELECT count(*) FROM bookmark_tags WHERE workspace_id IN (${a}, ${b})) AS count`);
    expect(Number(stored[0]?.count)).toBe(0);
  });

  it("take identifiers only", async () => {
    const me = await account();
    const w = await workspace([me]);

    await expect(asMember(w, me, (tx) => importRepository(tx).linkBookmarks({ folders: [{ bookmarkId: "x", folderId: freshId() }], tags: [] }))).rejects.toThrow(/identifiers/);
    await expect(asMember(w, me, (tx) => importRepository(tx).linkBookmarks({ folders: [], tags: [{ bookmarkId: freshId(), tagId: "'; DROP TABLE tags; --" }] }))).rejects.toThrow(/identifiers/);
  });
});
