import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertBookmarkCountMatches, bookmarkCountDrift, useTestDatabase, type TestDatabase } from "../src/db.ts";

// The drift check of workspaces.bookmark_count (doc 05 section 2.2, doc 10 T11): the helper that the integration tests end with, and the
// statement of the operator page that finds the same workspaces except one that is being deleted, and changes nothing. The deletion job
// purges a workspace's rows in batches, each committed on its own, and leaves the counter until the workspace row goes, so the two differ
// there on purpose and only the helper, which compares every workspace, lists it. Each case seeds the rows and the counter by hand, as
// slugbase_system, so that the counter can be moved away from the rows.

const PAGE = resolve(import.meta.dirname, "../../../docs/self-hosting/check-bookmark-counter.md");
const WORKSPACE_A = "0192f3a0-3480-7000-8000-00000000a001";
const WORKSPACE_B = "0192f3a0-3480-7000-8000-00000000b001";
const WORKSPACE_C = "0192f3a0-3480-7000-8000-00000000c001";

const database = useTestDatabase();

beforeEach(async () => {
  await database().owner`TRUNCATE workspaces CASCADE`;
});

let nextBookmark = 0;

/** A workspace with its counter set as given, and `live` bookmarks that count and `archived` that a plan limit archived. */
async function seed(db: TestDatabase, workspaceId: string, counter: number, live: number, archived = 0, deleting = false): Promise<void> {
  await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspaces (id, name, bookmark_count, deleting_at) VALUES (${workspaceId}, 'Count workspace', ${counter}, ${deleting ? new Date() : null})`;
    for (let index = 0; index < live + archived; index += 1) {
      nextBookmark += 1;
      const id = `0192f3a0-3481-7000-8000-${String(nextBookmark).padStart(12, "0")}`;
      const url = `https://example.com/count/${String(nextBookmark)}`;
      await tx`
        INSERT INTO bookmarks (id, workspace_id, url, url_canonical, host, title, plan_archived_at)
        VALUES (${id}, ${workspaceId}, ${url}, ${url}, 'example.com', 'Count bookmark', ${index < live ? null : new Date()})`;
    }
  });
}

async function setCounter(db: TestDatabase, workspaceId: string, counter: number): Promise<void> {
  await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET bookmark_count = ${counter} WHERE id = ${workspaceId}`;
  });
}

describe("assertBookmarkCountMatches", () => {
  it("passes for no workspace, for an empty one and for one whose counter is the rows that are not archived", async () => {
    const db = database();
    await expect(assertBookmarkCountMatches(db)).resolves.toBeUndefined();

    await seed(db, WORKSPACE_A, 0, 0);
    await seed(db, WORKSPACE_B, 3, 3, 2);

    await expect(assertBookmarkCountMatches(db)).resolves.toBeUndefined();
    expect(await bookmarkCountDrift(db)).toEqual([]);
  });

  it("fails once the counter is moved by hand, in either direction, and names the workspace with both numbers", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 2, 2);
    await seed(db, WORKSPACE_B, 4, 4);
    await assertBookmarkCountMatches(db);

    await setCounter(db, WORKSPACE_A, 3);
    await expect(assertBookmarkCountMatches(db)).rejects.toThrow(`workspace ${WORKSPACE_A}: bookmark_count is 3, the bookmarks that are not plan-archived number 2`);

    await setCounter(db, WORKSPACE_A, 2);
    await setCounter(db, WORKSPACE_B, 3);
    await expect(assertBookmarkCountMatches(db)).rejects.toThrow(`workspace ${WORKSPACE_B}: bookmark_count is 3, the bookmarks that are not plan-archived number 4`);
  });

  it("fails for a counter that counts an archived bookmark, and for a row that was added without moving the counter", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 3, 2, 1);
    await seed(db, WORKSPACE_B, 1, 1);

    expect(await bookmarkCountDrift(db)).toEqual([{ workspaceId: WORKSPACE_A, counter: 3, rows: 2 }]);

    await db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO bookmarks (id, workspace_id, url, url_canonical, host, title)
        VALUES ('0192f3a0-3482-7000-8000-000000000001', ${WORKSPACE_B}, 'https://example.com/unlisted', 'https://example.com/unlisted', 'example.com', 'Unlisted')`;
    });

    expect(await bookmarkCountDrift(db)).toEqual([
      { workspaceId: WORKSPACE_A, counter: 3, rows: 2 },
      { workspaceId: WORKSPACE_B, counter: 1, rows: 2 },
    ]);
  });

  it("leaves the rows and the counters as they were", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 5, 2);
    const before = await snapshot(db);

    await expect(assertBookmarkCountMatches(db)).rejects.toThrow("bookmark_count");

    expect(await snapshot(db)).toBe(before);
  });
});

/** The statement of the operator page: the first code block of the page, as it is written there. */
function pageStatement(): string {
  const page = readFileSync(PAGE, "utf8");
  const blocks = [...page.matchAll(/^```sql\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");
  expect(blocks).toHaveLength(1);
  return blocks[0] ?? "";
}

/** A digest of every workspace and bookmark row, read as slugbase_system. */
async function snapshot(db: TestDatabase): Promise<string> {
  const rows = await db.owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w), '') ||
        coalesce((SELECT string_agg(b::text, '|' ORDER BY b.id) FROM bookmarks b), '')
      ) AS digest`;
  });
  return rows[0]?.digest ?? "";
}

interface Listed {
  readonly workspace_id: string;
  readonly counter: number;
  readonly bookmarks: string;
  readonly difference: string;
}

/**
 * Runs the page's script one statement after the other on a connection of its own, as psql would, and answers the rows of its SELECT. The
 * transaction is ended whatever happened. The page's statements hold no `;` inside a literal, so cutting at each one is exact.
 */
async function runScript(db: TestDatabase, script: string): Promise<Listed[]> {
  const connection = await db.owner.reserve();
  try {
    let listed: Listed[] | undefined;
    for (const statement of script.split(";").map((part) => part.trim()).filter((part) => part !== "")) {
      const result = await connection.unsafe<Listed[]>(statement);
      if (/^select\b/i.test(statement)) {
        listed = [...result];
      }
    }
    if (listed === undefined) {
      throw new Error("the script ran no SELECT");
    }
    return listed;
  } finally {
    await connection.unsafe("ROLLBACK").catch(() => undefined);
    connection.release();
  }
}

describe("the statement of docs/self-hosting/check-bookmark-counter.md", () => {
  it("lists nothing when every counter matches", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 2, 2);
    await seed(db, WORKSPACE_B, 1, 1, 4);
    await seed(db, WORKSPACE_C, 0, 0);

    expect(await runScript(db, pageStatement())).toEqual([]);
  });

  it("lists exactly the workspaces the helper finds that are not being deleted, with the counter, the bookmarks and the difference", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 4, 2);
    await seed(db, WORKSPACE_B, 2, 2, 1);
    await seed(db, WORKSPACE_C, 1, 3, 2);

    const listed = await runScript(db, pageStatement());

    expect(listed.map((row) => ({ workspaceId: row.workspace_id, counter: row.counter, rows: Number(row.bookmarks) }))).toEqual(await bookmarkCountDrift(db));
    expect(listed).toEqual([
      { workspace_id: WORKSPACE_A, counter: 4, bookmarks: "2", difference: "2" },
      { workspace_id: WORKSPACE_C, counter: 1, bookmarks: "3", difference: "-2" },
    ]);
  });

  it("leaves out a workspace that is being deleted, whose bookmarks the deletion job removes in batches while the counter stays", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 3, 0, 0, true);
    await seed(db, WORKSPACE_B, 2, 1);

    expect((await runScript(db, pageStatement())).map((row) => row.workspace_id)).toEqual([WORKSPACE_B]);
    expect((await bookmarkCountDrift(db)).map((item) => item.workspaceId)).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  it("changes no row", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 9, 2);
    const before = await snapshot(db);

    expect(await runScript(db, pageStatement())).toHaveLength(1);

    expect(await snapshot(db)).toBe(before);
  });

  it("opens a transaction that refuses a write, so a drifted counter cannot be repaired by it", async () => {
    const db = database();
    await seed(db, WORKSPACE_A, 9, 2);
    const withoutEnd = pageStatement().replace(/^COMMIT;\s*$/m, "");
    expect(withoutEnd).not.toContain("COMMIT");

    await expect(runScript(db, `${withoutEnd}\nUPDATE workspaces SET bookmark_count = 2;`)).rejects.toMatchObject({ code: "25006" });

    expect(await bookmarkCountDrift(db)).toEqual([{ workspaceId: WORKSPACE_A, counter: 9, rows: 2 }]);
  });
});
