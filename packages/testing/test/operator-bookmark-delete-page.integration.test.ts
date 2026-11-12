import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertBookmarkCountMatches, useTestDatabase, type TestDatabase } from "../src/db.ts";

// The operator page docs/self-hosting/remove-bookmark.md (doc 05 section 3.3, doc 10 section 2.10): the two code blocks of the page are run as written,
// the way psql runs them for the migration login, against a database that holds the bookmark the page's example values name. A page that drifts from
// sys_bookmark_operator_delete, from the role it sets or from the identifiers it shows fails here. The function's own cases are in
// packages/db/test/operator-bookmark-delete.integration.test.ts.

const PAGE = resolve(import.meta.dirname, "../../../docs/self-hosting/remove-bookmark.md");
const WORKSPACE = "0192f3a0-3480-7000-8000-00000000a001";
const OTHER_WORKSPACE = "0192f3a0-3480-7000-8000-00000000b001";
const BOOKMARK = "0192f3a0-3481-7000-8000-000000000001";
const EVENT = "5b0e6a1c-0f58-4d6e-9a53-0b3c1d7f2e44";
const REASON = "Court order, ref. 2026-123";
const TITLE = "Terms of an author";

const database = useTestDatabase();

beforeEach(async () => {
  await database().owner`TRUNCATE workspaces CASCADE`;
});

/** The page's code blocks, as written there: the lookup and the removal. */
function pageStatements(): { lookup: string; removal: string } {
  const page = readFileSync(PAGE, "utf8");
  const blocks = [...page.matchAll(/^```sql\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");
  expect(blocks).toHaveLength(2);
  const [lookup, removal] = blocks;
  return { lookup: lookup ?? "", removal: removal ?? "" };
}

/** A workspace with its counter and the given bookmarks, written as slugbase_system, which stands for the operations that write what a request may not. */
async function seed(db: TestDatabase, workspaceId: string, bookmarks: readonly { id: string; url: string; slug: string | null; ownerless?: boolean }[]): Promise<void> {
  await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO workspaces (id, name, bookmark_count) VALUES (${workspaceId}, ${`Workspace ${workspaceId.slice(-4)}`}, ${bookmarks.length})`;
    for (const bookmark of bookmarks) {
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
        VALUES (${bookmark.id}, ${workspaceId}, NULL, ${bookmark.url}, ${bookmark.url}, 'example.com', ${TITLE}, ${bookmark.slug}, ${bookmark.slug !== null})`;
    }
  });
}

async function seedPage(db: TestDatabase): Promise<void> {
  await seed(db, WORKSPACE, [
    { id: BOOKMARK, url: "https://example.com/page", slug: "terms" },
    { id: "0192f3a0-3481-7000-8000-000000000002", url: "https://example.com/other", slug: null },
  ]);
  await seed(db, OTHER_WORKSPACE, [{ id: "0192f3a0-3481-7000-8000-000000000003", url: "https://example.com/page", slug: "terms" }]);
}

/**
 * Runs the page's script one statement after the other on a connection of its own, as psql would for the migration login: a session with no role set.
 * Answers the rows of its last SELECT. The transaction is ended whatever happened. The page's statements hold no `;` inside a literal, so cutting at each
 * one is exact.
 */
async function runScript<Row extends object>(db: TestDatabase, script: string): Promise<Row[]> {
  const connection = await db.owner.reserve();
  try {
    await connection.unsafe("SET ROLE NONE");
    let listed: Row[] | undefined;
    for (const statement of script.split(";").map((part) => part.trim()).filter((part) => part !== "")) {
      const result = await connection.unsafe<Row[]>(statement);
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
    await connection.unsafe("RESET ROLE").catch(() => undefined);
    connection.release();
  }
}

function failureCode(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(
    () => undefined,
    (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown"),
  );
}

/** A digest of every workspace, bookmark and audit event row, read as slugbase_system. */
async function snapshot(db: TestDatabase): Promise<string> {
  const rows = await db.owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w), '') ||
        coalesce((SELECT string_agg(b::text, '|' ORDER BY b.id) FROM bookmarks b), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e), '')
      ) AS digest`;
  });
  return rows[0]?.digest ?? "";
}

async function bookmarkIds(db: TestDatabase, workspaceId: string): Promise<string[]> {
  const rows = await db.owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`;
  });
  return rows.map((row) => row.id);
}

async function counterOf(db: TestDatabase, workspaceId: string): Promise<number> {
  const rows = await db.owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`;
  });
  return rows[0]?.bookmark_count ?? Number.NaN;
}

interface EventRow {
  readonly id: string;
  readonly action: string;
  readonly actor_type: string;
  readonly actor_label: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly metadata: Record<string, string>;
  readonly row: string;
}

async function eventsOf(db: TestDatabase, workspaceId: string): Promise<EventRow[]> {
  const rows = await db.owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<EventRow[]>`
      SELECT id, action, actor_type, actor_label, entity_type, entity_id, metadata, e::text AS row
      FROM audit_events e WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
}

describe("the lookup of docs/self-hosting/remove-bookmark.md", () => {
  it("lists the bookmark by its address or its slug in every workspace that holds it, with the identifiers the removal needs", async () => {
    const db = database();
    await seedPage(db);

    const listed = await runScript<{ workspace_id: string; workspace: string; bookmark_id: string; title: string; url: string; slug: string | null; ownerless: boolean }>(db, pageStatements().lookup);

    expect(listed).toEqual([
      { workspace_id: WORKSPACE, workspace: "Workspace a001", bookmark_id: BOOKMARK, title: TITLE, url: "https://example.com/page", slug: "terms", ownerless: true },
      { workspace_id: OTHER_WORKSPACE, workspace: "Workspace b001", bookmark_id: "0192f3a0-3481-7000-8000-000000000003", title: TITLE, url: "https://example.com/page", slug: "terms", ownerless: true },
    ]);
  });

  it("changes no row, and its transaction refuses a write", async () => {
    const db = database();
    await seedPage(db);
    const before = await snapshot(db);
    const { lookup } = pageStatements();

    expect(await runScript(db, lookup)).toHaveLength(2);
    expect(await snapshot(db)).toBe(before);

    const withoutEnd = lookup.replace(/^COMMIT;\s*$/m, "");
    expect(withoutEnd).not.toContain("COMMIT");
    expect(await failureCode(runScript(db, `${withoutEnd}\nDELETE FROM bookmarks;`))).toBe("25006");
    expect(await snapshot(db)).toBe(before);
  });
});

describe("the removal of docs/self-hosting/remove-bookmark.md", () => {
  it("removes the bookmark, lowers the counter, writes the event with the reason and the login, and answers t", async () => {
    const db = database();
    await seedPage(db);

    const answer = await runScript<{ sys_bookmark_operator_delete: boolean }>(db, pageStatements().removal);

    expect(answer).toEqual([{ sys_bookmark_operator_delete: true }]);
    expect(await bookmarkIds(db, WORKSPACE)).toEqual(["0192f3a0-3481-7000-8000-000000000002"]);
    expect(await bookmarkIds(db, OTHER_WORKSPACE)).toEqual(["0192f3a0-3481-7000-8000-000000000003"]);
    expect([await counterOf(db, WORKSPACE), await counterOf(db, OTHER_WORKSPACE)]).toEqual([1, 1]);
    const events = await eventsOf(db, WORKSPACE);
    expect(events.map((event) => ({ id: event.id, action: event.action, actor_type: event.actor_type, actor_label: event.actor_label, entity_type: event.entity_type, entity_id: event.entity_id, metadata: event.metadata }))).toEqual([
      { id: EVENT, action: "bookmark.operator_deleted", actor_type: "system", actor_label: "slugbase_migrator", entity_type: "bookmark", entity_id: BOOKMARK, metadata: { reason: REASON } },
    ]);
    // The page promises that the event shows neither the title nor the address of the bookmark.
    for (const text of [TITLE, "example.com", "terms"]) {
      expect(events[0]?.row, `the event must not hold ${text}`).not.toContain(text);
    }
    expect(await eventsOf(db, OTHER_WORKSPACE)).toEqual([]);
    await assertBookmarkCountMatches(db);
  });

  it("answers f and changes nothing when it runs again for a bookmark that is gone", async () => {
    const db = database();
    await seedPage(db);
    const { removal } = pageStatements();
    await runScript(db, removal);
    const before = await snapshot(db);

    const answer = await runScript<{ sys_bookmark_operator_delete: boolean }>(db, removal);

    expect(answer).toEqual([{ sys_bookmark_operator_delete: false }]);
    expect(await snapshot(db)).toBe(before);
    await assertBookmarkCountMatches(db);
  });

  it("is refused to the migration login without the role the page sets, and removes nothing", async () => {
    const db = database();
    await seedPage(db);
    const withoutRole = pageStatements().removal.replace(/^SET LOCAL ROLE slugbase_system;\s*$/m, "");
    expect(withoutRole).not.toContain("SET LOCAL ROLE");
    const before = await snapshot(db);

    expect(await failureCode(runScript(db, withoutRole))).toBe("42501");

    expect(await snapshot(db)).toBe(before);
    await assertBookmarkCountMatches(db);
  });
});
