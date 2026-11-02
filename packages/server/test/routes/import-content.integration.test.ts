import { randomUUID } from "node:crypto";
import { ImportResultSchema } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/import/json, the folders, tags and slugs of the file (doc 04 section 10.9, doc 02 section 13.1, Q30, doc 10 T2 and T13), through the whole chain over the migrated database. The failure scenario:
// importing into a workspace where member A owns the slug `mail` and the folder `Work` changes nothing of A's when member B imports the same names, and B gets their own; a slug that is invalid, that the caller has or
// that an earlier bookmark of the file keeps costs its bookmark the slug and not the import; a dry run says what the import then does and writes nothing; a failed import leaves no folder, tag or link.

const TEST_TIMEOUT_MS = 120_000;
const IMPORT = "/api/v1/import/json";
const PREVIEW = `${IMPORT}?dryRun=true`;
const EXPORT = "/api/v1/export/json";
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

/** Every folder, tag, bookmark and link of the workspace as one text per row, so two readings of the workspace compare as lists. */
async function content(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(
    (tx) => tx<{ item: string }[]>`
      SELECT 'folder:' || id || '/' || coalesce(owner_id::text, '') || '/' || name::text || '/' || icon || '/' || color AS item FROM folders WHERE workspace_id = ${workspaceId}
      UNION ALL SELECT 'tag:' || id || '/' || owner_id || '/' || name::text FROM tags WHERE workspace_id = ${workspaceId}
      UNION ALL SELECT 'bookmark:' || id || '/' || coalesce(owner_id::text, '') || '/' || url || '/' || coalesce(slug, '') || '/' || forwarding || '/' || (pinned_at IS NOT NULL) || '/' || version FROM bookmarks WHERE workspace_id = ${workspaceId}
      UNION ALL SELECT 'filed:' || bookmark_id || '/' || folder_id FROM folder_bookmarks WHERE workspace_id = ${workspaceId}
      UNION ALL SELECT 'tagged:' || bookmark_id || '/' || tag_id FROM bookmark_tags WHERE workspace_id = ${workspaceId}
      ORDER BY 1`,
  );
  return rows.map((row) => row.item);
}

interface Filed {
  readonly url: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly pinned: boolean;
  readonly folders: readonly string[];
  readonly tags: readonly string[];
}

/** The bookmarks of one member with the names of their folders and tags, by URL. */
async function filedBy(workspaceId: string, accountId: string): Promise<Filed[]> {
  const rows = await asSystem(
    (tx) => tx<{ url: string; slug: string | null; forwarding: boolean; pinned: boolean; folders: string[]; tags: string[] }[]>`
      SELECT b.url, b.slug, b.forwarding, b.pinned_at IS NOT NULL AS pinned,
        coalesce((SELECT array_agg(f.name::text ORDER BY f.name::text COLLATE "C") FROM folder_bookmarks fb JOIN folders f ON f.id = fb.folder_id WHERE fb.bookmark_id = b.id), '{}') AS folders,
        coalesce((SELECT array_agg(t.name::text ORDER BY t.name::text COLLATE "C") FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), '{}') AS tags
      FROM bookmarks b WHERE b.workspace_id = ${workspaceId} AND b.owner_id = ${accountId} ORDER BY b.url COLLATE "C"`,
  );
  return rows;
}

const foldersOf = (workspaceId: string, accountId: string) =>
  asSystem((tx) => tx<{ id: string; name: string; icon: string; color: number }[]>`SELECT id, name::text AS name, icon, color FROM folders WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} ORDER BY name::text COLLATE "C"`);

const tagsOf = (workspaceId: string, accountId: string) =>
  asSystem((tx) => tx<{ id: string; name: string }[]>`SELECT id, name::text AS name FROM tags WHERE workspace_id = ${workspaceId} AND owner_id = ${accountId} ORDER BY name::text COLLATE "C"`);

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

describe("POST /import/json, folders, tags and slugs", { timeout: TEST_TIMEOUT_MS }, () => {
  it("leaves member A's slug, folder and tag as they are when member B imports the same names, and gives B their own, with the same answer in a dry run", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, shared } = await setup(world);
    await imported(world, a, {
      format: "slugbase-export",
      version: 1,
      folders: [{ name: "Work", icon: "briefcase", color: 5 }],
      tags: ["News"],
      bookmarks: [{ url: "https://example.com/a", slug: "mail", forwarding: true, folders: ["Work"], tags: ["News"] }],
    });
    const before = await content(shared.workspaceId);
    const file = {
      format: "slugbase-export",
      version: 1,
      folders: [{ name: "work", icon: "star", color: 2 }],
      tags: ["NEWS"],
      bookmarks: [{ url: "https://example.com/b", slug: "mail", forwarding: true, pinned: true, folders: ["WORK"], tags: ["news"] }],
    };

    const previewed = await imported(world, b, file, PREVIEW);
    expect(await content(shared.workspaceId)).toEqual(before);
    const result = await imported(world, b, file);

    expect(result).toEqual(previewed);
    expect(result).toMatchObject({ created: 1, slugsDropped: 0, droppedSlugs: [], foldersCreated: 1, tagsCreated: 1 });
    const after = await content(shared.workspaceId);
    expect(before.every((item) => after.includes(item))).toBe(true);
    expect(after.length).toBe(before.length + 5);
    expect(await filedBy(shared.workspaceId, a.account.id)).toEqual([{ url: "https://example.com/a", slug: "mail", forwarding: true, pinned: false, folders: ["Work"], tags: ["News"] }]);
    expect(await filedBy(shared.workspaceId, b.account.id)).toEqual([{ url: "https://example.com/b", slug: "mail", forwarding: true, pinned: true, folders: ["work"], tags: ["NEWS"] }]);
    expect(await foldersOf(shared.workspaceId, a.account.id)).toMatchObject([{ name: "Work", icon: "briefcase", color: 5 }]);
    expect(await foldersOf(shared.workspaceId, b.account.id)).toMatchObject([{ name: "work", icon: "star", color: 2 }]);
  });

  it("creates every folder and tag of the file, used or not, uses the caller's own of the same name whatever the case with its icon and colour, and falls back to the defaults for an unknown icon or an out-of-range colour", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    await imported(world, a, { format: "slugbase-export", version: 1, folders: [{ name: "Reading", icon: "book-open", color: 6 }], tags: ["Later"], bookmarks: [] });
    const reading = (await foldersOf(shared.workspaceId, a.account.id))[0];

    const result = await imported(world, a, {
      format: "slugbase-export",
      version: 1,
      folders: [
        { name: "reading", icon: "star", color: 1 },
        { name: "Unused", icon: "briefcase", color: 3 },
        { name: "Odd", icon: "no-such-icon", color: 9 },
        { name: "Zero", color: 0 },
        { name: "  \u0000 " },
        { name: "Dev/Tools/Docs" },
        { name: "x".repeat(70) },
      ],
      tags: ["LATER", "Fresh", "", "z".repeat(50)],
      bookmarks: [{ url: "https://example.com/a", folders: ["READING"], tags: ["later"] }],
    });

    expect(result).toMatchObject({ created: 1, foldersCreated: 5, tagsCreated: 2, detected: { folders: 6, tags: 3 } });
    expect((await foldersOf(shared.workspaceId, a.account.id)).map((folder) => [folder.name, folder.icon, folder.color])).toEqual([
      ["Dev/Tools/Docs", "folder", 1],
      ["Odd", "folder", 1],
      ["Reading", "book-open", 6],
      ["Unused", "briefcase", 3],
      ["Zero", "folder", 1],
      ["x".repeat(64), "folder", 1],
    ]);
    expect((await foldersOf(shared.workspaceId, a.account.id)).find((folder) => folder.name === "Reading")?.id).toBe(reading?.id);
    expect((await tagsOf(shared.workspaceId, a.account.id)).map((tag) => tag.name)).toEqual(["Fresh", "Later", "z".repeat(40)]);
    expect(await filedBy(shared.workspaceId, a.account.id)).toEqual([{ url: "https://example.com/a", slug: null, forwarding: false, pinned: false, folders: ["Reading"], tags: ["Later"] }]);
  });

  it("files and tags each bookmark by its own names and keeps its slug, forwarding and pinned state", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    await imported(world, a, [
      { url: "https://example.com/1", slug: "One", forwarding: true, pinned: true, folders: ["Work", "Home"], tags: ["x", "y"] },
      { url: "https://example.com/2", slug: "two", folders: ["work"], tags: ["Y"] },
      { url: "https://example.com/3", forwarding: true, folders: ["Home", "home", "A/B"] },
      { url: "https://example.com/4" },
    ]);

    expect(await filedBy(shared.workspaceId, a.account.id)).toEqual([
      { url: "https://example.com/1", slug: "one", forwarding: true, pinned: true, folders: ["Home", "Work"], tags: ["x", "y"] },
      { url: "https://example.com/2", slug: "two", forwarding: false, pinned: false, folders: ["Work"], tags: ["y"] },
      { url: "https://example.com/3", slug: null, forwarding: false, pinned: false, folders: ["A/B", "Home"], tags: [] },
      { url: "https://example.com/4", slug: null, forwarding: false, pinned: false, folders: [], tags: [] },
    ]);
    expect((await foldersOf(shared.workspaceId, a.account.id)).map((folder) => folder.name)).toEqual(["A/B", "Home", "Work"]);
  });

  it("drops a slug outside the grammar, one the caller has (plan-archived too) and one an earlier bookmark of the file keeps, still imports the bookmark with forwarding off, and lists and counts each drop, the same in a dry run", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, shared } = await setup(world);
    await imported(world, a, [{ url: "https://example.com/old", slug: "taken" }, { url: "https://example.com/archived", slug: "archived" }]);
    await asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE owner_id = ${a.account.id} AND slug = 'archived'`);
    await imported(world, b, [{ url: "https://example.com/members", slug: "members" }]);
    const file = [
      { url: "https://example.com/1", slug: "Fresh", forwarding: true },
      { url: "https://example.com/2", slug: "fresh", forwarding: true },
      { url: "https://example.com/3", slug: "taken", forwarding: true },
      { url: "https://example.com/4", slug: "archived", forwarding: true },
      { url: "https://example.com/5", slug: "not a slug", forwarding: true },
      { url: "https://example.com/6", slug: "-bad" },
      { url: "https://example.com/7", slug: "a".repeat(65) },
      { url: "https://example.com/8", slug: "members", forwarding: true },
    ];

    const previewed = await imported(world, a, file, PREVIEW);
    const result = await imported(world, a, file);

    expect(result).toEqual(previewed);
    expect(result.created).toBe(8);
    expect(result.slugsDropped).toBe(6);
    expect(result.droppedSlugs.map((drop) => [drop.position, drop.slug, drop.reason])).toEqual([
      [2, "fresh", "slug_conflict"],
      [3, "taken", "slug_conflict"],
      [4, "archived", "slug_conflict"],
      [5, "not a slug", "slug_invalid"],
      [6, "-bad", "slug_invalid"],
      [7, "a".repeat(65), "slug_invalid"],
    ]);
    expect((await filedBy(shared.workspaceId, a.account.id)).filter((row) => row.url.match(/\/[1-8]$/)).map((row) => [row.url.slice(-1), row.slug, row.forwarding])).toEqual([
      ["1", "fresh", true],
      ["2", null, false],
      ["3", null, false],
      ["4", null, false],
      ["5", null, false],
      ["6", null, false],
      ["7", null, false],
      ["8", "members", true],
    ]);
    const events = await asSystem((tx) => tx<{ metadata: { slugsDropped: string } }[]>`SELECT metadata FROM audit_events WHERE action = 'import.completed' ORDER BY created_at DESC LIMIT 1`);
    expect(events[0]?.metadata.slugsDropped).toBe("6");
  });

  it("leaves a slug to a later bookmark when the earlier one that has it is a duplicate that is skipped", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    await imported(world, a, [{ url: "https://example.com/dup" }]);

    const result = await imported(world, a, [
      { url: "https://example.com/dup", slug: "wanted" },
      { url: "https://example.com/other", slug: "wanted" },
    ]);

    expect(result).toMatchObject({ created: 1, slugsDropped: 0, droppedSlugs: [] });
    expect((await filedBy(shared.workspaceId, a.account.id)).find((row) => row.url === "https://example.com/other")?.slug).toBe("wanted");
  });

  it("writes nothing in a dry run, not a folder, tag, link or slug, and reports the counts of the import that follows", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const file = [
      { url: "https://example.com/1", slug: "s", folders: ["F1", "F2"], tags: ["T1"] },
      { url: "https://example.com/2", slug: "s", folders: ["f1"], tags: ["T2", "t1"] },
    ];
    const before = await content(shared.workspaceId);

    const previewed = await imported(world, a, file, PREVIEW);

    expect(await content(shared.workspaceId)).toEqual(before);
    expect(previewed).toMatchObject({ created: 2, foldersCreated: 2, tagsCreated: 2, slugsDropped: 1 });
    expect(await imported(world, a, file)).toEqual(previewed);
    expect(await imported(world, a, file, `${IMPORT}?skipDuplicates=false`)).toMatchObject({ foldersCreated: 0, tagsCreated: 0, slugsDropped: 2 });
  });

  it("round-trips a member's export into an empty workspace: the same bookmarks, folders, tags, slugs, forwarding and pinned state", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, c, shared, elsewhere } = await setup(world);
    await imported(world, a, {
      format: "slugbase-export",
      version: 1,
      folders: [{ name: "Reading", icon: "book-open", color: 4 }, { name: "Empty", icon: "star", color: 7 }],
      tags: ["Spare"],
      bookmarks: [
        { url: "https://example.com/one", title: "One", description: "About", slug: "one", forwarding: true, pinned: true, folders: ["Reading"], tags: ["a", "b"] },
        { url: "https://example.com/two", title: "Two", slug: "two", folders: ["Reading", "Work"] },
        { url: "https://example.com/three", title: "Three", tags: ["b"] },
      ],
    });
    const exported = (await (await send(world, "GET", EXPORT, asPerson(a))).json()) as Record<string, unknown>;

    const result = await imported(world, c, exported);
    const reExported = (await (await send(world, "GET", EXPORT, asPerson(c))).json()) as Record<string, unknown>;

    expect(result).toMatchObject({ created: 3, skipped: [], failed: [], slugsDropped: 0, foldersCreated: 3, tagsCreated: 3 });
    const withoutStamp = (document: Record<string, unknown>) => Object.fromEntries(Object.entries(document).filter(([key]) => key !== "exportedAt" && key !== "workspace"));
    expect(withoutStamp(reExported)).toEqual(withoutStamp(exported));
    expect((await filedBy(shared.workspaceId, a.account.id)).length).toBe(3);
    expect((await filedBy(elsewhere.workspaceId, c.account.id)).length).toBe(3);
  });

  it("leaves no folder, tag, link or bookmark when the audit event cannot be written, and the retry with the key creates them", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    await database().owner`
      CREATE FUNCTION refuse_import_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action = 'import.completed' THEN RAISE EXCEPTION 'refused'; END IF;
        RETURN NEW;
      END $$`;
    await database().owner`CREATE TRIGGER refuse_import_event BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_import_event()`;
    const key = randomUUID();
    const file = { format: "slugbase-export", version: 1, folders: [{ name: "Listed" }], tags: ["Listed"], bookmarks: [{ url: "https://example.com/a", slug: "a", folders: ["F"], tags: ["T"] }] };
    const before = await content(shared.workspaceId);

    const failed = await importAs(world, { ...asPerson(a), "idempotency-key": key }, file);

    expect(failed.status).toBe(500);
    expect(await content(shared.workspaceId)).toEqual(before);

    await database().owner`DROP TRIGGER refuse_import_event ON audit_events`;
    const retry = await importAs(world, { ...asPerson(a), "idempotency-key": key }, file);

    expect(retry.status).toBe(200);
    expect(ImportResultSchema.parse(retry.body)).toMatchObject({ created: 1, foldersCreated: 2, tagsCreated: 2 });
    expect((await filedBy(shared.workspaceId, a.account.id))[0]).toMatchObject({ slug: "a", folders: ["F"], tags: ["T"] });
  });

  it("stores hostile folder, tag and slug text as plain text and neither fails nor leaks it, and never splits a name at a slash", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    const result = await imported(world, a, [
      { url: "https://example.com/h", slug: "__proto__", folders: ["<script>alert(1)</script>\u0000", "'; DROP TABLE folders; --", "a\\b/c"], tags: ["‮{\"a\":1}", "constructor"] },
      { url: "https://example.com/i", slug: "x\u0000y" },
    ]);

    expect(result.created).toBe(2);
    expect(result.droppedSlugs.map((drop) => [drop.position, drop.slug, drop.reason])).toEqual([
      [1, "__proto__", "slug_invalid"],
      [2, "xy", "slug_invalid"],
    ]);
    expect((await foldersOf(shared.workspaceId, a.account.id)).map((folder) => folder.name)).toEqual(["'; DROP TABLE folders; --", "<script>alert(1)</script>", "a\\b/c"]);
    expect((await tagsOf(shared.workspaceId, a.account.id)).map((tag) => tag.name)).toEqual(["constructor", "‮{\"a\":1}"]);
  });
});
