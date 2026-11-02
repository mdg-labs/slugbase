import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The reads of the import preview (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1). The failure scenario: a duplicate found among another member's bookmarks, a plan-archived bookmark, a bookmark with no
// owner or another workspace's, and a room under the limit worked out from the rows and not from the counter of the workspace's row.

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
  const row = (id: string, ownerId: string, url: string, overrides: Partial<{ title: string; description: string | null; pinned: boolean }> = {}) => ({
    id,
    ownerId,
    url,
    urlCanonical: url,
    host: "example.com",
    title: "Title",
    description: null,
    pinned: false,
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
