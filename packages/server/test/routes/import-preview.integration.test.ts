import { randomUUID } from "node:crypto";
import { ImportResultSchema } from "@slugbase/contracts";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/import/json?dryRun=true (doc 04 section 10.9, doc 02 section 13.1, doc 01 section 7.5, doc 10 T1 and T13), through the whole chain over the migrated database. The failure scenario: a
// preview that counts the room under the bookmark limit from the rows and not from the workspace's counter, that treats a plan-archived bookmark, another member's bookmark or another workspace's as a
// duplicate, that reads the plan-archived flag of the file, or that writes anything at all (a bookmark, a counter, a job, an audit event).

const TEST_TIMEOUT_MS = 60_000;
const IMPORT = "/api/v1/import/json";
const PREVIEW = `${IMPORT}?dryRun=true`;
const BOOKMARKS = "/api/v1/bookmarks";
const EXPORT = "/api/v1/export/json";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });

async function importAs(world: World, headers: Record<string, string>, file: unknown, path = PREVIEW) {
  const response = await send(world, "POST", path, headers, file);
  const body: unknown = await response.json();
  return { response, status: response.status, body };
}

async function preview(world: World, as: Person, body: unknown, path = PREVIEW) {
  const answer = await importAs(world, asPerson(as), body, path);
  expect(answer.status).toBe(200);
  return ImportResultSchema.parse(answer.body);
}

async function create(world: World, as: Person, url: string, title = "Bookmark"): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, asPerson(as), { url, title });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

/** What the workspace holds: the rows, the counter, and the audit events and idempotency keys that a request leaves. */
async function stored(workspaceId: string) {
  const rows = await asSystem(
    (tx) => tx<{ bookmarks: number; counter: number; audit: number }[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS bookmarks,
        (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter,
        (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId})::int AS audit`,
  );
  const jobs = await database().owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job`;
  return { ...rows[0], jobs: jobs[0]?.count };
}

const keys = () => asSystem((tx) => tx<{ operation: string; status: string }[]>`SELECT operation, status FROM idempotency_keys ORDER BY operation`);

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

describe("POST /import/json?dryRun=true", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers what an import of a plain array would do, in the shape the later parts keep, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    await create(world, a, "https://example.com/existing");
    const before = await stored(shared.workspaceId);

    const result = await preview(world, a, [
      { url: "https://example.com/new", title: "  New  ", description: "About it", slug: "new", folders: ["Reading", "reading"], tags: ["News", "later"] },
      { url: "https://example.com/existing/" },
      { url: "javascript:alert(1)", title: "Bad" },
      { url: "ftp://example.com/file" },
      { url: "" },
      { url: "https://example.org/", title: "   ", folders: ["Work"] },
    ]);

    expect(result).toEqual({
      detected: { bookmarks: 6, folders: 2, tags: 2 },
      created: 2,
      skipped: [{ position: 2, title: "example.com", url: "https://example.com/existing/", reason: "duplicate" }],
      failed: [
        { position: 3, title: "Bad", url: "javascript:alert(1)", reason: "url_not_allowed" },
        { position: 4, title: "", url: "ftp://example.com/file", reason: "url_not_allowed" },
        { position: 5, title: "", url: "", reason: "url_invalid" },
      ],
      slugsDropped: 0,
      droppedSlugs: [],
      foldersCreated: 0,
      tagsCreated: 0,
    });
    expect(await stored(shared.workspaceId)).toEqual(before);
  });

  it("reads the export document of the same format: the round trip of the caller's own export is all duplicates, and another member's import of it is all new", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, shared } = await setup(world);
    await create(world, a, "https://example.com/one", "One");
    await create(world, a, "https://example.com/two", "Two");
    const exported = (await (await send(world, "GET", EXPORT, asPerson(a))).json()) as { bookmarks: unknown[] };
    expect(exported.bookmarks).toHaveLength(2);

    const mine = await preview(world, a, exported);
    const theirs = await preview(world, b, exported);

    expect(mine).toMatchObject({ detected: { bookmarks: 2, folders: 0, tags: 0 }, created: 0, failed: [] });
    expect(mine.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [1, "duplicate"],
      [2, "duplicate"],
    ]);
    expect(theirs).toMatchObject({ created: 2, skipped: [], failed: [] });
    expect((await stored(shared.workspaceId)).bookmarks).toBe(2);
  });

  it("finds duplicates by canonical URL within the file and against the caller's non-archived bookmarks only, and imports them all with skipDuplicates=false", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, c, shared } = await setup(world);
    await create(world, a, "https://example.com/mine");
    await create(world, b, "https://example.com/members");
    await create(world, c, "https://example.com/elsewhere");
    const archived = await create(world, a, "https://example.com/archived");
    await asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${archived}`);
    const body = [
      ...file("https://EXAMPLE.com/mine?utm_source=x", "https://example.com/members", "https://example.com/elsewhere", "https://example.com/archived#frag"),
      ...file("https://example.com/twice?b=2&a=1", "https://example.com/twice/?a=1&b=2&fbclid=z#top"),
      { url: "https://example.com/flagged", planArchived: true },
      { url: "https://example.com/flagged", planArchived: false },
    ];

    const skipping = await preview(world, a, body);
    const keeping = await preview(world, a, body, `${PREVIEW}&skipDuplicates=false`);
    const explicit = await preview(world, a, body, `${PREVIEW}&skipDuplicates=true`);

    expect(skipping.created).toBe(5);
    expect(skipping.skipped.map((entry) => entry.position)).toEqual([1, 6, 8]);
    expect(skipping.skipped.every((entry) => entry.reason === "duplicate")).toBe(true);
    expect(keeping).toMatchObject({ created: 8, skipped: [], failed: [] });
    expect(explicit).toEqual(skipping);
    expect((await stored(shared.workspaceId)).counter).toBe(3);
  });

  it("adds at most bookmarks.max - bookmark_count, read from the counter and not from the rows, and reports the rest as bookmark_limit_reached; a flag in the file never changes it", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: new LimitedEntitlementSource().grant("bookmarks.max", 4) });
    const { a, shared } = await setup(world);
    await create(world, a, "https://example.com/one");
    await create(world, a, "https://example.com/two");
    await create(world, a, "https://example.com/three");
    // A downgrade archived two bookmarks and gave their count back: three rows, a counter of one.
    await asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE url IN ('https://example.com/one', 'https://example.com/two')`);
    await asSystem((tx) => tx`UPDATE workspaces SET bookmark_count = 1 WHERE id = ${shared.workspaceId}`);
    const before = await stored(shared.workspaceId);
    expect(before).toMatchObject({ bookmarks: 3, counter: 1 });

    const result = await preview(world, a, [...file("https://example.com/a", "https://example.com/b", "https://example.com/c"), { url: "https://example.com/d", planArchived: true }, ...file("https://example.com/e", "bogus")]);

    expect(result.created).toBe(3);
    expect(result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [4, "bookmark_limit_reached"],
      [5, "bookmark_limit_reached"],
    ]);
    expect(result.failed.map((entry) => entry.position)).toEqual([6]);
    expect(await stored(shared.workspaceId)).toEqual(before);
  });

  it("creates nothing under a ceiling the workspace has reached, and imports without limit under an unlimited one", async () => {
    const source = new LimitedEntitlementSource().grant("bookmarks.max", 1);
    const world = harness.serve({ env: RELAXED, entitlementSource: source });
    const { a, shared } = await setup(world);
    await create(world, a, "https://example.com/only");

    const full = await preview(world, a, file("https://example.com/x", "https://example.com/y"));
    source.grant("bookmarks.max", "unlimited");
    await asSystem((tx) => tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = ${shared.workspaceId}`);
    const unlimited = await preview(world, a, file("https://example.com/x", "https://example.com/y"));

    expect(full).toMatchObject({ created: 0 });
    expect(full.skipped.map((entry) => entry.reason)).toEqual(["bookmark_limit_reached", "bookmark_limit_reached"]);
    expect(unlimited).toMatchObject({ created: 2, skipped: [] });
  });

  it("refuses a dryRun that is not true or false and a query it does not declare, tells a caller with no right to ask so first, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const before = await stored(shared.workspaceId);

    for (const path of [`${IMPORT}?dryRun=yes`, `${IMPORT}?dryRun=1`, `${PREVIEW}&skipDuplicates=maybe`, `${PREVIEW}&other=1`]) {
      const answer = await importAs(world, asPerson(a), file("https://example.com/"), path);
      expect(answer.status, path).toBe(422);
      expect((answer.body as { code: string }).code).toBe("validation_failed");
    }
    expect((await importAs(world, {}, file("https://example.com/"), PREVIEW)).status).toBe(401);
    expect((await importAs(world, {}, file("https://example.com/"), IMPORT)).status).toBe(401);
    expect(await stored(shared.workspaceId)).toEqual(before);
  });

  it("stores its answer under an Idempotency-Key and replays it, and changes nothing else", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const before = await stored(shared.workspaceId);
    const key = randomUUID();
    const body = file("https://example.com/a", "https://example.com/b");

    const first = await importAs(world, { ...asPerson(a), "idempotency-key": key }, body);
    const replay = await importAs(world, { ...asPerson(a), "idempotency-key": key }, body);
    const another = await importAs(world, { ...asPerson(a), "idempotency-key": key }, file("https://example.com/c"));

    expect(first.status).toBe(200);
    expect(first.response.headers.get("idempotency-replayed")).toBeNull();
    expect(replay.status).toBe(200);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(another.status).toBe(409);
    expect((another.body as { code: string }).code).toBe("idempotency_conflict");
    expect(await keys()).toEqual([{ operation: "importJson", status: "done" }]);
    expect(await stored(shared.workspaceId)).toEqual(before);
  });

  it("is a member's write: no session is 401, a read-only token is 403, and a read-write token previews", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const readOnly = await harness.token(shared.workspaceId, a, "read");
    const readWrite = await harness.token(shared.workspaceId, a, "read-write");

    const anonymous = await importAs(world, {}, file("https://example.com/"));
    const refused = await importAs(world, bearer(readOnly), file("https://example.com/"));
    const allowed = await importAs(world, bearer(readWrite), file("https://example.com/"));

    expect(anonymous.status).toBe(401);
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe("token_scope");
    expect(allowed.status).toBe(200);
    expect(ImportResultSchema.parse(allowed.body).created).toBe(1);
  });
});
