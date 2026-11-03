import { ExportDocumentSchema } from "@slugbase/contracts";
import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The selection of GET /api/v1/export/json and /export/netscape (doc 04 section 10.9, doc 02 section 5.8, doc 10 T1 and T2), through the whole chain over the migrated database. The failure scenario: an identifier of a bookmark
// the caller can neither own nor read (another member's that is not shared with them, one of another workspace, a shared one a downgrade archived, none at all) is named, and the file, the count header or the audit event differs from the
// one of the same request without it, which tells the caller that the bookmark exists. Besides that: the caller's own bookmarks of a selection are in full and the shared ones are their readable fields alone, the filters of the list select
// what the list shows, a selection over the select-all cap is refused and not cut, and a request that names no selection is still the whole export.

const TEST_TIMEOUT_MS = 90_000;
const JSON_EXPORT = "/api/v1/export/json";
const NETSCAPE_EXPORT = "/api/v1/export/netscape";
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const SELECT_ALL_CAP = 5000;
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };
const NO_SUCH_BOOKMARK = "0192f3a0-9999-7000-8000-000000000001";

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

async function create(world: World, as: Person, path: string, body: Record<string, unknown>): Promise<string> {
  const response = await send(world, "POST", path, asPerson(as), body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const bookmark = (world: World, as: Person, title: string, extra: Record<string, unknown> = {}) => create(world, as, BOOKMARKS, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...extra });

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

const archive = (bookmarkId: string) => asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${bookmarkId}`);

const ids = (...named: readonly string[]): string => named.map((id) => `id=${id}`).join("&");

const exportEvents = (workspaceId: string) =>
  asSystem((tx) => tx<{ metadata: Record<string, string> }[]>`SELECT metadata FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'export.created' ORDER BY created_at, id`);

interface Asked {
  readonly status: number;
  readonly text: string;
  readonly count: string | null;
}

async function ask(world: World, as: Person, path: string, query: string): Promise<Asked> {
  const response = await send(world, "GET", `${path}?${query}`, asPerson(as));
  return { status: response.status, text: await response.text(), count: response.headers.get("x-export-count") };
}

/** The document with the one timestamp that differs between two exports taken out. */
const withoutTime = (text: string): unknown => ({ ...(JSON.parse(text) as object), exportedAt: "" });

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

async function share(world: World, owner: Person, path: string, target: Record<string, string>): Promise<void> {
  expect((await send(world, "POST", path, asPerson(owner), target)).status).toBe(201);
}

/** B's library: two own bookmarks (one filed and tagged), one shared with B by A, and the bookmarks B can not read. */
async function library(world: World) {
  const { a, b, c, shared } = await setup(world);
  const reading = await create(world, b, FOLDERS, { name: "Reading", icon: "book-open", color: 4 });
  const other = await create(world, b, FOLDERS, { name: "Unselected folder" });
  const news = await create(world, b, TAGS, { name: "news" });
  const unrelated = await create(world, b, TAGS, { name: "unrelated" });
  const filed = await bookmark(world, b, "Filed", { slug: "filed", forwarding: true, pinned: true, description: "Mine" });
  const loose = await bookmark(world, b, "Loose");
  const elsewhereOnly = await bookmark(world, b, "Unselected");
  expect((await send(world, "PATCH", `${BOOKMARKS}/${filed}`, asPerson(b), { folderIds: [reading], tagIds: [news] })).status).toBe(200);
  expect((await send(world, "PATCH", `${BOOKMARKS}/${elsewhereOnly}`, asPerson(b), { folderIds: [other], tagIds: [unrelated] })).status).toBe(200);
  const theirs = await bookmark(world, a, "Shared with B", { slug: "theirs", description: "About it" });
  const privateTag = await create(world, a, TAGS, { name: "owner-private-tag" });
  expect((await send(world, "PATCH", `${BOOKMARKS}/${theirs}`, asPerson(a), { tagIds: [privateTag] })).status).toBe(200);
  await share(world, a, `${BOOKMARKS}/${theirs}/shares`, { accountId: b.account.id });
  const hers = await bookmark(world, a, "Not shared with B");
  const archivedShare = await bookmark(world, a, "Archived share");
  await share(world, a, `${BOOKMARKS}/${archivedShare}/shares`, { accountId: b.account.id });
  await archive(archivedShare);
  const foreign = await bookmark(world, c, "Of another workspace");
  return { a, b, c, shared, filed, loose, elsewhereOnly, theirs, hers, archivedShare, foreign };
}

describe("GET /export/json with id", () => {
  it(
    "exports the caller's own bookmarks of the selection in full and the shared ones as their readable fields, with the folders and tags those own bookmarks use and nothing else",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);

      const answer = await ask(world, l.b, JSON_EXPORT, ids(l.filed, l.loose, l.theirs));

      expect(answer.status).toBe(200);
      const document = ExportDocumentSchema.parse(JSON.parse(answer.text));
      expect(document.bookmarks).toEqual([
        { ref: "b1", url: "https://example.com/Filed", title: "Filed", description: "Mine", slug: "filed", forwarding: true, pinned: true, planArchived: false, folders: ["Reading"], tags: ["news"] },
        { ref: "b2", url: "https://example.com/Loose", title: "Loose", description: null, slug: null, forwarding: false, pinned: false, planArchived: false, folders: [], tags: [] },
      ]);
      expect(document.folders).toEqual([{ name: "Reading", icon: "book-open", color: 4 }]);
      expect(document.tags).toEqual(["news"]);
      expect(document.goPreferences).toEqual([]);
      expect(document.shared).toHaveLength(1);
      expect(document.shared[0]).toMatchObject({ url: "https://example.com/Shared%20with%20B", title: "Shared with B", description: "About it", slug: "theirs", shared: true });
      expect(Object.keys(document.shared[0] ?? {}).sort()).toEqual(["description", "ownerName", "shared", "slug", "title", "url"]);
      expect(answer.text).not.toMatch(/owner-private-tag|Unselected|unrelated|Not shared with B|Archived share|Another workspace/);
      expect(answer.count).toBe("3");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores the identifier of a bookmark the caller can neither own nor read: the file, the count header and the audit event are those of the request without it",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      const readable = [l.filed, l.theirs];

      const plain = await ask(world, l.b, JSON_EXPORT, ids(...readable));
      const noisy = await ask(world, l.b, JSON_EXPORT, ids(...readable, l.hers, l.archivedShare, l.foreign, NO_SUCH_BOOKMARK));
      const onlyUnreadable = await ask(world, l.b, JSON_EXPORT, ids(l.hers, l.archivedShare, l.foreign, NO_SUCH_BOOKMARK));
      const onlyNothing = await ask(world, l.b, JSON_EXPORT, ids(NO_SUCH_BOOKMARK));

      expect([plain.status, noisy.status, onlyUnreadable.status, onlyNothing.status]).toEqual([200, 200, 200, 200]);
      expect(withoutTime(noisy.text)).toEqual(withoutTime(plain.text));
      expect(noisy.count).toBe(plain.count);
      expect(plain.count).toBe("2");
      expect(withoutTime(onlyUnreadable.text)).toEqual(withoutTime(onlyNothing.text));
      expect(onlyUnreadable.count).toBe("0");
      const document = ExportDocumentSchema.parse(JSON.parse(onlyUnreadable.text));
      expect([document.bookmarks, document.shared, document.folders, document.tags]).toEqual([[], [], [], []]);
      const events = await exportEvents(l.shared.workspaceId);
      expect(events.map((event) => event.metadata)).toEqual([
        { bookmarks: "1", folders: "1", tags: "1", shared: "1" },
        { bookmarks: "1", folders: "1", tags: "1", shared: "1" },
        { bookmarks: "0", folders: "0", tags: "0", shared: "0" },
        { bookmarks: "0", folders: "0", tags: "0", shared: "0" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exports a bookmark of the caller's that a downgrade archived, flagged, and still leaves out a shared one that was archived",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      await archive(l.loose);

      const document = ExportDocumentSchema.parse(JSON.parse((await ask(world, l.b, JSON_EXPORT, ids(l.loose, l.archivedShare))).text));

      expect(document.bookmarks.map((entry) => [entry.title, entry.planArchived])).toEqual([["Loose", true]]);
      expect(document.shared).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a go preference only for a bookmark of the selection",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      const second = await bookmark(world, l.b, "Second", { slug: "filed-too", forwarding: true });
      await asSystem(
        (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${l.shared.workspaceId}, ${l.b.account.id}, 'filed', ${l.filed}), (${l.shared.workspaceId}, ${l.b.account.id}, 'filed-too', ${second})`,
      );

      const document = ExportDocumentSchema.parse(JSON.parse((await ask(world, l.b, JSON_EXPORT, ids(second))).text));

      expect(document.bookmarks.map((entry) => entry.slug)).toEqual(["filed-too"]);
      expect(document.goPreferences).toEqual([{ slug: "filed-too", bookmarkRef: "b1" }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses more than 100 identifiers, an identifier combined with a filter or includeShared, and one that is no identifier, records nothing, and leaves a request without a selection the whole export",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      const hundred = Array.from({ length: 100 }, (_, index) => `0192f3a0-9999-7000-8000-${String(index).padStart(12, "0")}`);

      expect((await ask(world, l.b, JSON_EXPORT, ids(...hundred))).status).toBe(200);
      const events = (await exportEvents(l.shared.workspaceId)).length;
      for (const query of [ids(...hundred, NO_SUCH_BOOKMARK), `${ids(l.filed)}&pinned=true`, `${ids(l.filed)}&scope=mine`, `${ids(l.filed)}&includeShared=true`, "id=not-an-identifier", "includeShared=true&q=docs", "sort=recent"]) {
        const refused = await ask(world, l.b, JSON_EXPORT, query);
        expect([query, refused.status]).toEqual([query, 422]);
        expect(refused.count).toBeNull();
      }
      expect((await exportEvents(l.shared.workspaceId)).length).toBe(events);
      const whole = ExportDocumentSchema.parse(JSON.parse(await (await send(world, "GET", JSON_EXPORT, asPerson(l.b))).text()));
      expect(whole.bookmarks.map((entry) => entry.title)).toEqual(["Filed", "Loose", "Unselected"]);
      expect(whole.shared).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /export/json with the filters of the list", () => {
  it(
    "selects what the list shows: the scope all, which is the default, holds the caller's own bookmarks and the shared ones, mine only the first, shared_with_me only the second",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);

      expect(titles((await ask(world, l.b, JSON_EXPORT, "scope=all")).text)).toEqual({ own: ["Filed", "Loose", "Unselected"], shared: ["Shared with B"] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "hasSlug=true")).text)).toEqual({ own: ["Filed"], shared: ["Shared with B"] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "scope=mine")).text)).toEqual({ own: ["Filed", "Loose", "Unselected"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "scope=shared_with_me")).text)).toEqual({ own: [], shared: ["Shared with B"] });
      expect((await ask(world, l.b, JSON_EXPORT, "scope=all")).count).toBe("4");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "selects by folder, tag, pin, slug, forwarding and text, as the list does",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      const folderId = ((await (await send(world, "GET", FOLDERS, asPerson(l.b))).json()) as { items: { id: string; name: string }[] }).items.find((folder) => folder.name === "Reading")?.id ?? "";
      const tagId = ((await (await send(world, "GET", TAGS, asPerson(l.b))).json()) as { items: { id: string; name: string }[] }).items.find((tag) => tag.name === "news")?.id ?? "";

      expect(titles((await ask(world, l.b, JSON_EXPORT, `folderId=${folderId}`)).text)).toEqual({ own: ["Filed"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, `tag=${tagId}`)).text)).toEqual({ own: ["Filed"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "pinned=true")).text)).toEqual({ own: ["Filed"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "forwarding=true&scope=mine")).text)).toEqual({ own: ["Filed"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "q=loose")).text)).toEqual({ own: ["Loose"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "q=about")).text)).toEqual({ own: [], shared: ["Shared with B"] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, "url=https%3A%2F%2Fexample.com%2FLoose")).text)).toEqual({ own: ["Loose"], shared: [] });
      expect(titles((await ask(world, l.b, JSON_EXPORT, `folderId=${NO_SUCH_BOOKMARK}`)).text)).toEqual({ own: [], shared: [] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds nothing of another member's folder or tag, or of another workspace, whatever it is named",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      const hisFolder = await create(world, l.a, FOLDERS, { name: "Olga folder" });
      const hisTag = await create(world, l.a, TAGS, { name: "olga-tag" });
      const theirFolder = await create(world, l.c, FOLDERS, { name: "Carl folder" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${l.hers}`, asPerson(l.a), { folderIds: [hisFolder], tagIds: [hisTag] })).status).toBe(200);

      for (const query of [`folderId=${hisFolder}`, `tag=${hisTag}`, `folderId=${theirFolder}`]) {
        const answer = await ask(world, l.b, JSON_EXPORT, query);
        expect([query, answer.status, answer.count]).toEqual([query, 200, "0"]);
        expect(titles(answer.text)).toEqual({ own: [], shared: [] });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a url that cannot be a bookmark's, and a selection of more than the select-all cap instead of cutting it, and records neither",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);

      const refusedUrl = await ask(world, l.b, JSON_EXPORT, "url=ftp%3A%2F%2Fexample.com%2F");
      expect(refusedUrl.status).toBe(422);
      const events = (await exportEvents(l.shared.workspaceId)).length;

      await asSystem(
        (tx) => tx`
          INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
          SELECT gen_random_uuid(), ${l.shared.workspaceId}, ${l.b.account.id}, 'https://example.com/bulk/' || n, 'https://example.com/bulk/' || n, 'example.com', 'Bulk ' || n FROM generate_series(1, ${SELECT_ALL_CAP - 3 + 1}) AS n`,
      );
      const over = await ask(world, l.b, JSON_EXPORT, "scope=mine");
      expect(over.status).toBe(422);
      expect(over.count).toBeNull();
      expect(over.text).toContain("narrow");
      expect((await exportEvents(l.shared.workspaceId)).length).toBe(events);

      await asSystem((tx) => tx`DELETE FROM bookmarks WHERE workspace_id = ${l.shared.workspaceId} AND title = 'Bulk 1'`);
      const exactly = await ask(world, l.b, JSON_EXPORT, "scope=mine");
      expect(exactly.status).toBe(200);
      expect(exactly.count).toBe(String(SELECT_ALL_CAP));
    },
    TEST_TIMEOUT_MS * 2,
  );
});

describe("GET /export/netscape with a selection", () => {
  it(
    "writes the selected own bookmarks under their folders and the shared ones at the top level with no tags, ignoring an identifier the caller cannot read",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);
      const readable = [l.filed, l.loose, l.theirs];

      const plain = await ask(world, l.b, NETSCAPE_EXPORT, ids(...readable));
      const noisy = await ask(world, l.b, NETSCAPE_EXPORT, ids(...readable, l.hers, l.archivedShare, l.foreign, NO_SUCH_BOOKMARK));

      expect(plain.status).toBe(200);
      expect(noisy.text).toBe(plain.text);
      expect(noisy.count).toBe(plain.count);
      expect(plain.count).toBe("3");
      expect(plain.text).toContain("<DT><H3>Reading</H3>");
      expect(plain.text).toContain('<A HREF="https://example.com/Filed" SHORTCUTURL="filed" TAGS="news">Filed</A>');
      expect(plain.text).toContain('<A HREF="https://example.com/Loose">Loose</A>');
      expect(plain.text).toContain('<A HREF="https://example.com/Shared%20with%20B" SHORTCUTURL="theirs">Shared with B</A>');
      expect(plain.text).not.toMatch(/Unselected|owner-private-tag|Not shared with B|Archived share|Another workspace|unrelated/);
      const events = await exportEvents(l.shared.workspaceId);
      expect(events.map((event) => event.metadata)).toEqual([
        { bookmarks: "2", folders: "1", tags: "1", shared: "1" },
        { bookmarks: "2", folders: "1", tags: "1", shared: "1" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "selects by the filters of the list and refuses the same requests as the JSON export",
    async () => {
      const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
      const l = await library(world);

      const all = await ask(world, l.b, NETSCAPE_EXPORT, "hasSlug=true");
      expect(all.status).toBe(200);
      expect(all.count).toBe("2");
      expect(all.text).toMatch(/>Filed<\/A>[\s\S]*>Shared with B<\/A>|>Shared with B<\/A>[\s\S]*>Filed<\/A>/);
      expect(all.text).not.toContain(">Loose</A>");
      for (const query of [`${ids(l.filed)}&pinned=true`, `${ids(l.filed)}&includeShared=true`, "id=not-an-identifier"]) {
        expect([query, (await ask(world, l.b, NETSCAPE_EXPORT, query)).status]).toEqual([query, 422]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

const titles = (text: string): { own: string[]; shared: string[] } => {
  const document = ExportDocumentSchema.parse(JSON.parse(text));
  return { own: document.bookmarks.map((entry) => entry.title), shared: document.shared.map((entry) => entry.title) };
};
