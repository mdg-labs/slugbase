import { randomUUID } from "node:crypto";
import { ImportResultSchema } from "@slugbase/contracts";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/import/json, the import that writes (doc 04 section 10.9, doc 02 section 13.1, doc 01 section 7.5, doc 10 T1, T11 and T13), through the whole chain over the migrated database. The failure
// scenario: two imports at the limit minus one that both create their bookmarks because each judged the room before the other raised the counter, a counter that parts from the rows (a plan-archived flag read from
// the file, a place taken for a bookmark that was never written), bookmarks in another order than the file's, a failure of one write that leaves the bookmarks or the counter behind, a retry with the same key
// that creates the bookmarks twice, a dry run that writes, and a row of another workspace that changes.

const TEST_TIMEOUT_MS = 120_000;
const IMPORT = "/api/v1/import/json";
const EXPORT = "/api/v1/export/json";
const CREATED_JOB = "event.bookmark.created";
const FETCH_JOB = "bookmark.fetchMetadata";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`DROP TRIGGER IF EXISTS refuse_import_event ON audit_events`;
  await database().owner`DROP FUNCTION IF EXISTS refuse_import_event()`;
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(() => assertBookmarkCountMatches(database()));

const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });

async function importAs(world: World, headers: Record<string, string>, file: unknown, path = IMPORT) {
  const response = await send(world, "POST", path, headers, file);
  const body: unknown = await response.json();
  return { response, status: response.status, body };
}

async function imported(world: World, as: Person, file: unknown, path = IMPORT) {
  const answer = await importAs(world, asPerson(as), file, path);
  expect(answer.status).toBe(200);
  return ImportResultSchema.parse(answer.body);
}

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

interface Stored {
  readonly bookmarks: number;
  readonly counted: number;
  readonly counter: number;
  readonly audit: number;
  readonly keys: number;
}

/** What the workspace holds: the rows, the rows the counter counts, the counter itself, the audit events and the idempotency keys. */
async function stored(workspaceId: string): Promise<Stored> {
  const rows = await asSystem(
    (tx) => tx<Stored[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS bookmarks,
        (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND plan_archived_at IS NULL)::int AS counted,
        (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter,
        (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId})::int AS audit,
        (SELECT count(*) FROM idempotency_keys)::int AS keys`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("no row");
  }
  return row;
}

/**
 * Starts the requests while this test holds the lock on the workspace's row, waits until `waiting` backends are queued on a lock (pg_locks shows every session's, which pg_stat_activity does not for a role the test is not a member of) (at most ten seconds), and then lets go of the row. A request
 * that never queues ends the wait with an error rather than a pass.
 */
async function whileHoldingWorkspace<T>(workspaceId: string, waiting: number, start: () => Promise<T>[]): Promise<T[]> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held: () => void = () => undefined;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR NO KEY UPDATE`;
    held();
    await released;
  });
  try {
    await holding;
    const answers = start();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const queued = await database().owner<{ count: number }[]>`SELECT count(DISTINCT pid)::int AS count FROM pg_locks WHERE NOT granted`;
      if ((queued[0]?.count ?? 0) >= waiting) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("the requests did not queue on the workspace's row");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    return await Promise.all(answers);
  } finally {
    release();
    await holder.catch(() => undefined);
  }
}

const jobCount = async (name: string) => (await database().owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = ${name}`)[0]?.count;

async function setup(world: World) {
  const a = await harness.person(world);
  const b = await harness.person(world);
  const c = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: a, role: "owner" },
    { person: b, role: "member" },
  ]);
  const elsewhere = await harness.workspaceOf([{ person: c, role: "owner" }]);
  return { a, b, c, shared, elsewhere };
}

const file = (...urls: string[]) => urls.map((url) => ({ url }));
const limited = (max: number) => new LimitedEntitlementSource().grant("bookmarks.max", max);

describe("POST /import/json", { timeout: TEST_TIMEOUT_MS }, () => {
  it("creates the bookmarks of the file in its order with ascending identifiers, raises the counter by what it created, announces each one and records one import.completed", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    const result = await imported(world, a, [
      { url: "https://example.com/zulu", title: "  Zulu  ", description: "About it", pinned: true, slug: "zulu", folders: ["Reading"], tags: ["News"] },
      { url: "javascript:alert(1)", title: "Bad" },
      { url: "https://example.com/alpha" },
      { url: "https://example.com/zulu/?utm_source=x" },
      { url: "https://example.com/mike", planArchived: true },
    ]);

    expect(result).toEqual({
      detected: { bookmarks: 5, folders: 1, tags: 1 },
      created: 3,
      skipped: [{ position: 4, title: "example.com", url: "https://example.com/zulu/?utm_source=x", reason: "duplicate" }],
      failed: [{ position: 2, title: "Bad", url: "javascript:alert(1)", reason: "url_not_allowed" }],
      slugsDropped: 0,
      droppedSlugs: [],
      foldersCreated: 1,
      tagsCreated: 1,
    });
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, counted: 3, counter: 3, audit: 1 });
    const rows = await asSystem(
      (tx) => tx<{ url: string; title: string; description: string | null; owner_id: string; pinned: boolean; archived: boolean; slug: string | null; forwarding: boolean }[]>`
        SELECT url, title, description, owner_id, pinned_at IS NOT NULL AS pinned, plan_archived_at IS NOT NULL AS archived, slug, forwarding
        FROM bookmarks WHERE workspace_id = ${shared.workspaceId} ORDER BY id`,
    );
    expect(rows).toEqual([
      { url: "https://example.com/zulu", title: "Zulu", description: "About it", owner_id: a.account.id, pinned: true, archived: false, slug: "zulu", forwarding: false },
      { url: "https://example.com/alpha", title: "example.com", description: null, owner_id: a.account.id, pinned: false, archived: false, slug: null, forwarding: false },
      { url: "https://example.com/mike", title: "example.com", description: null, owner_id: a.account.id, pinned: false, archived: false, slug: null, forwarding: false },
    ]);
    expect(await jobCount(CREATED_JOB)).toBe(3);
    expect(await jobCount(FETCH_JOB)).toBe(0);
    const events = await asSystem((tx) => tx<{ action: string; actor_type: string; actor_account_id: string; entity_id: string | null; metadata: unknown }[]>`SELECT action, actor_type, actor_account_id, entity_id, metadata FROM audit_events WHERE workspace_id = ${shared.workspaceId}`);
    expect(events).toEqual([
      { action: "import.completed", actor_type: "account", actor_account_id: a.account.id, entity_id: null, metadata: { created: "3", skipped: "1", failed: "1", slugsDropped: "0", foldersCreated: "1", tagsCreated: "1" } },
    ]);
  });

  it("stores a description with its line breaks and tabs, \\r\\n as \\n and every other control character removed, and a title, folder and tag with none, the same in a dry run", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const lines = [
      { url: "https://example.com/one", title: "T\nt\tx", description: "a\nb\tc", folders: ["F\nf"], tags: ["T\tt"] },
      { url: "https://example.com/two", description: "x\r\ny\rz\u0007w\u0085v\u0000u" },
    ];

    const preview = await imported(world, a, lines, `${IMPORT}?dryRun=true`);
    expect(preview.created).toBe(2);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0 });

    expect((await imported(world, a, lines)).created).toBe(2);
    const rows = await asSystem(
      (tx) => tx<{ title: string; description: string | null }[]>`SELECT title, description FROM bookmarks WHERE workspace_id = ${shared.workspaceId} ORDER BY id`,
    );
    expect(rows).toEqual([
      { title: "Ttx", description: "a\nb\tc" },
      { title: "example.com", description: "x\ny\nzwvu" },
    ]);
    const names = await asSystem(
      (tx) => tx<{ name: string }[]>`SELECT name FROM folders WHERE workspace_id = ${shared.workspaceId} UNION ALL SELECT name FROM tags WHERE workspace_id = ${shared.workspaceId} ORDER BY name`,
    );
    expect(names).toEqual([{ name: "Ff" }, { name: "Tt" }]);
  });

  it("reports a javascript link of 3 000 characters as url_not_allowed, and an https one of that length as url_invalid, and stores neither", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    const result = await imported(world, a, [
      { url: `javascript:${"a".repeat(3000)}`, title: "Long bookmarklet" },
      { url: `https://example.com/${"a".repeat(3000)}`, title: "Long address" },
    ]);

    expect(result).toMatchObject({ created: 0 });
    expect(result.failed.map((entry) => [entry.position, entry.reason])).toEqual([
      [1, "url_not_allowed"],
      [2, "url_invalid"],
    ]);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, counter: 0 });
  });

  it("stores hostile text as plain text: control characters removed (a description keeps its line break), a lone surrogate replaced, quotes, backslashes and markup kept as characters, and the title cut to its limit", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    const result = await imported(world, a, [
      { url: "https://example.com/hostile", title: `<script>alert("x")</script>\\ ' \u0000\u0007 \ud800 ${"é".repeat(400)}`, description: "line\nbreak \udc00 {\"a\":1}" },
      { url: "https://example.com/__proto__", title: "__proto__" },
    ]);

    expect(result.created).toBe(2);
    const rows = await asSystem((tx) => tx<{ title: string; description: string | null }[]>`SELECT title, description FROM bookmarks WHERE workspace_id = ${shared.workspaceId} ORDER BY id`);
    expect(Array.from(rows[0]?.title ?? "")).toHaveLength(300);
    expect(rows[0]?.title.startsWith(`<script>alert("x")</script>\\ '  \ufffd `)).toBe(true);
    expect(rows[0]?.description).toBe('line\nbreak \ufffd {"a":1}');
    expect(rows[1]?.title).toBe("__proto__");
  });

  it("lists the bookmarks of a re-export in the order of the file, whatever the clock does between identifiers", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a } = await setup(world);
    const urls = Array.from({ length: 60 }, (_, index) => `https://example.com/${String(index).padStart(3, "0")}`);

    expect((await imported(world, a, file(...urls))).created).toBe(60);

    const exported = (await (await send(world, "GET", EXPORT, asPerson(a))).json()) as { bookmarks: { url: string }[] };
    expect(exported.bookmarks.map((bookmark) => bookmark.url)).toEqual(urls);
  });

  it("imports in full a bookmark that the write paths gave more than 100 folders and more than 100 tags: tagIds with tagNames, and a bulk add_to_folder", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, c } = await setup(world);
    const post = async (path: string, body: unknown, status: number) => {
      const response = await send(world, "POST", path, asPerson(a), body);
      expect(response.status).toBe(status);
      return (await response.json()) as { id: string };
    };
    const folderIds = await Promise.all(Array.from({ length: 101 }, (_, index) => post("/api/v1/folders", { name: `folder ${String(index).padStart(3, "0")}` }, 201)));
    const tagIds = await Promise.all(Array.from({ length: 100 }, (_, index) => post("/api/v1/tags", { name: `tag ${String(index).padStart(3, "0")}` }, 201)));
    const bookmark = await post(
      "/api/v1/bookmarks",
      { url: "https://example.com/full", title: "Full", folderIds: folderIds.slice(0, 100).map((folder) => folder.id), tagIds: tagIds.map((tag) => tag.id), tagNames: Array.from({ length: 100 }, (_, index) => `named ${String(index).padStart(3, "0")}`) },
      201,
    );
    await post("/api/v1/bookmarks", { url: "https://example.com/plain", title: "Plain" }, 201);
    const bulk = await send(world, "POST", "/api/v1/bookmarks/bulk", asPerson(a), { action: "add_to_folder", ids: [bookmark.id], folderId: folderIds[100]?.id });
    expect(bulk.status).toBe(200);

    const exportedResponse = await send(world, "GET", EXPORT, asPerson(a));
    const exported = (await exportedResponse.json()) as { bookmarks: { url: string; folders: string[]; tags: string[] }[] };
    const full = exported.bookmarks.find((entry) => entry.url === "https://example.com/full");
    expect([full?.folders.length, full?.tags.length]).toEqual([101, 200]);

    const again = await imported(world, c, exported);
    expect(again).toMatchObject({ created: 2, failed: [], foldersCreated: 101, tagsCreated: 200, detected: { bookmarks: 2, folders: 101, tags: 200 } });
  });

  it("imports with dryRun=false as it does with no dryRun, and writes nothing for dryRun=true: no bookmark, no counter, no job and no audit event", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const before = await stored(shared.workspaceId);

    const preview = await imported(world, a, file("https://example.com/a", "https://example.com/b"), `${IMPORT}?dryRun=true`);
    expect(preview.created).toBe(2);
    expect(await stored(shared.workspaceId)).toEqual(before);
    expect(await jobCount(CREATED_JOB)).toBe(0);

    expect((await imported(world, a, file("https://example.com/a"), `${IMPORT}?dryRun=false`)).created).toBe(1);
    expect((await imported(world, a, file("https://example.com/b"))).created).toBe(1);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 2, counter: 2, audit: 2 });
  });

  it("skips duplicates of the caller's bookmarks only, and imports them with skipDuplicates=false", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, shared } = await setup(world);
    await imported(world, b, file("https://example.com/members"));
    await imported(world, a, file("https://example.com/mine"));

    const skipping = await imported(world, a, file("https://example.com/mine/", "https://example.com/members", "https://example.com/members"));
    const keeping = await imported(world, a, file("https://example.com/mine"), `${IMPORT}?skipDuplicates=false`);

    expect(skipping).toMatchObject({ created: 1, skipped: [{ position: 1, reason: "duplicate" }, { position: 3, reason: "duplicate" }] });
    expect(keeping).toMatchObject({ created: 1, skipped: [] });
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 4, counter: 4 });
  });

  it("records an import that creates nothing, and records the token that made it", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const token = await harness.token(shared.workspaceId, a, "read-write");
    const tokenId = (await asSystem((tx) => tx<{ id: string }[]>`SELECT id FROM api_tokens WHERE workspace_id = ${shared.workspaceId}`))[0]?.id;

    const empty = await importAs(world, bearer(token), []);
    const bad = await importAs(world, bearer(token), file("ftp://example.com/"));

    expect(empty.status).toBe(200);
    expect(bad.status).toBe(200);
    const events = await asSystem((tx) => tx<{ actor_type: string; actor_token_id: string; metadata: unknown }[]>`SELECT actor_type, actor_token_id, metadata FROM audit_events WHERE workspace_id = ${shared.workspaceId} ORDER BY id`);
    expect(events.map((event) => [event.actor_type, event.actor_token_id])).toEqual([
      ["api_token", tokenId],
      ["api_token", tokenId],
    ]);
    expect(events[1]?.metadata).toEqual({ created: "0", skipped: "0", failed: "1", slugsDropped: "0", foldersCreated: "0", tagsCreated: "0" });
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, counter: 0 });
  });

  it("is a member's write: no session is 401, a read-only token is 403 and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const readOnly = await harness.token(shared.workspaceId, a, "read");

    expect((await importAs(world, {}, file("https://example.com/"))).status).toBe(401);
    expect((await importAs(world, bearer(readOnly), file("https://example.com/"))).status).toBe(403);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, counter: 0, audit: 0 });
  });

  it("changes nothing of another workspace, and counts the bookmarks of every member of this one against its limit", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: limited(3) });
    const { a, b, c, shared, elsewhere } = await setup(world);
    await imported(world, c, file("https://example.com/c1", "https://example.com/c2"));
    const elsewhereBefore = await stored(elsewhere.workspaceId);
    await imported(world, b, file("https://example.com/b1"));

    const result = await imported(world, a, file("https://example.com/a1", "https://example.com/a2", "https://example.com/a3"));

    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([{ position: 3, title: "example.com", url: "https://example.com/a3", reason: "bookmark_limit_reached" }]);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, counter: 3 });
    expect(await stored(elsewhere.workspaceId)).toEqual(elsewhereBefore);
  });

  it("creates one bookmark when two imports at the limit minus one run together, and leaves the counter equal to the rows that are not archived", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: limited(3) });
    const { a, b, c, shared, elsewhere } = await setup(world);
    await imported(world, a, file("https://example.com/one", "https://example.com/two", "https://example.com/three"));
    // A downgrade archived one bookmark: the counter does not count it, so the workspace holds two against its limit of three.
    await asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE url = 'https://example.com/one' AND workspace_id = ${shared.workspaceId}`);
    await asSystem((tx) => tx`UPDATE workspaces SET bookmark_count = bookmark_count - 1 WHERE id = ${shared.workspaceId}`);
    await imported(world, c, file("https://example.com/elsewhere"));
    const elsewhereBefore = await stored(elsewhere.workspaceId);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, counted: 2, counter: 2 });

    // Both imports are in flight at the workspace's row, which the test holds: whatever each judged before the lock, it is judged again by the one that gets the lock second.
    const answers = await whileHoldingWorkspace(shared.workspaceId, 2, () => [
      importAs(world, asPerson(a), file("https://example.com/p1", "https://example.com/p2", "https://example.com/p3")),
      importAs(world, asPerson(b), file("https://example.com/q1", "https://example.com/q2", "https://example.com/q3")),
    ]);

    const results = answers.map((answer) => {
      expect(answer.status).toBe(200);
      return ImportResultSchema.parse(answer.body);
    });
    expect(results.map((result) => result.created).sort()).toEqual([0, 1]);
    expect(results.flatMap((result) => result.skipped.map((entry) => entry.reason))).toEqual(Array(5).fill("bookmark_limit_reached"));
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 4, counted: 3, counter: 3 });
    expect(await stored(elsewhere.workspaceId)).toEqual(elsewhereBefore);
  });

  it("answers the stored result of a retry with the same key and creates nothing again; the same key with another file is 409", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const key = randomUUID();
    const body = file("https://example.com/a", "https://example.com/b");

    const first = await importAs(world, { ...asPerson(a), "idempotency-key": key }, body);
    const afterFirst = await stored(shared.workspaceId);
    const replay = await importAs(world, { ...asPerson(a), "idempotency-key": key }, body);
    const another = await importAs(world, { ...asPerson(a), "idempotency-key": key }, file("https://example.com/c"));

    expect(first.status).toBe(200);
    expect(first.response.headers.get("idempotency-replayed")).toBeNull();
    expect(replay.status).toBe(200);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(another.status).toBe(409);
    expect((another.body as { code: string }).code).toBe("idempotency_conflict");
    expect(afterFirst).toMatchObject({ bookmarks: 2, counter: 2, audit: 1, keys: 1 });
    expect(await stored(shared.workspaceId)).toEqual(afterFirst);
    expect(await jobCount(CREATED_JOB)).toBe(2);
  });

  it("rolls back every bookmark, the counter, the jobs and the key when the audit event cannot be written, and the retry with the key runs", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    await imported(world, a, file("https://example.com/existing"));
    const before = await stored(shared.workspaceId);
    const jobsBefore = await jobCount(CREATED_JOB);
    await database().owner`
      CREATE FUNCTION refuse_import_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action = 'import.completed' THEN RAISE EXCEPTION 'refused'; END IF;
        RETURN NEW;
      END $$`;
    await database().owner`CREATE TRIGGER refuse_import_event BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_import_event()`;
    const key = randomUUID();
    const body = file("https://example.com/a", "https://example.com/b", "https://example.com/c");

    const failed = await importAs(world, { ...asPerson(a), "idempotency-key": key }, body);

    expect(failed.status).toBe(500);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 1, counted: 1, counter: 1, audit: before.audit, keys: 0 });
    expect(await jobCount(CREATED_JOB)).toBe(jobsBefore);

    await database().owner`DROP TRIGGER refuse_import_event ON audit_events`;
    const retry = await importAs(world, { ...asPerson(a), "idempotency-key": key }, body);

    expect(retry.status).toBe(200);
    expect(retry.response.headers.get("idempotency-replayed")).toBeNull();
    expect(ImportResultSchema.parse(retry.body).created).toBe(3);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 4, counter: 4 });
  });

  it("imports 5 000 bookmarks in one request within the heavy test timeout", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const urls = Array.from({ length: 5000 }, (_, index) => `https://example.com/page/${String(index)}`);

    const result = await imported(world, a, file(...urls));

    expect(result.created).toBe(5000);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 5000, counter: 5000, audit: 1 });
    expect(await jobCount(CREATED_JOB)).toBe(5000);
  });
});
