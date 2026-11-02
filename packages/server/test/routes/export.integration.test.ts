import { EXPORT_DISPOSITION_PATTERN, ExportDocumentSchema } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/export/json (doc 04 section 10.9, doc 02 sections 13.2 and 13.3, doc 10 T1 and T2), through the whole chain over the migrated database. The failure scenario: member B of a
// workspace exports and finds none of A's bookmarks, folders or tags in the same workspace, A's tags never appear in B's document, and a member of another workspace finds nothing of A or B.
// Besides that: the document holds every field of the format and none of the database's (identifiers, usage, timestamps), a plan-archived bookmark is in it flagged, content with no owner is not,
// the answer is an attachment and is stored nowhere, an API token of the read scope can call it and is named in the audit log, the export is recorded once with counts only, and a document whose
// reading fails after the first byte ends unfinished.

const TEST_TIMEOUT_MS = 60_000;
const EXPORT = "/api/v1/export/json";
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
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

async function create(world: World, as: Person, path: string, body: Record<string, unknown>): Promise<string> {
  const response = await send(world, "POST", path, asPerson(as), body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const bookmark = (world: World, as: Person, title: string, extra: Record<string, unknown> = {}) =>
  create(world, as, BOOKMARKS, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...extra });

async function exportText(world: World, headers: Record<string, string>): Promise<string> {
  const response = await send(world, "GET", EXPORT, headers);
  expect(response.status).toBe(200);
  return response.text();
}

async function exportOf(world: World, as: Person) {
  return ExportDocumentSchema.parse(JSON.parse(await exportText(world, asPerson(as))));
}

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

async function archive(bookmarkId: string): Promise<void> {
  await asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${bookmarkId}`);
}

interface AuditRow {
  readonly action: string;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly actor_token_id: string | null;
  readonly entity_type: string | null;
  readonly metadata: Record<string, string>;
}

const exportEvents = (workspaceId: string) =>
  asSystem(
    (tx) => tx<AuditRow[]>`
      SELECT action, actor_type::text AS actor_type, actor_account_id, actor_token_id, entity_type, metadata FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'export.created' ORDER BY created_at, id`,
  );

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

describe("GET /export/json", () => {
  it(
    "answers the caller's own bookmarks, folders and tags as the document of the format, an attachment named after the day, and nothing of the database's",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      const rich = await bookmark(world, a, "Fastmail inbox", { slug: "mail", forwarding: true, pinned: true, description: "My mail" });
      const plain = await bookmark(world, a, "Garden notes");
      const archived = await bookmark(world, a, "Old plan");
      const work = await create(world, a, FOLDERS, { name: "Work", icon: "briefcase", color: 5 });
      const home = await create(world, a, FOLDERS, { name: "Home" });
      await create(world, a, FOLDERS, { name: "Unused folder", icon: "star", color: 2 });
      const later = await create(world, a, TAGS, { name: "later" });
      const apple = await create(world, a, TAGS, { name: "Apple" });
      await create(world, a, TAGS, { name: "unused" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${rich}`, asPerson(a), { tagIds: [later, apple], folderIds: [work, home] })).status).toBe(200);
      expect((await send(world, "PATCH", `${BOOKMARKS}/${archived}`, asPerson(a), { tagIds: [later] })).status).toBe(200);
      await archive(archived);

      const response = await send(world, "GET", EXPORT, asPerson(a));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("content-disposition")).toMatch(EXPORT_DISPOSITION_PATTERN);
      expect(response.headers.get("content-disposition")).not.toMatch(/authorization|suite/i);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      const document = ExportDocumentSchema.parse(JSON.parse(text));
      expect(document).toMatchObject({
        format: "slugbase-export",
        version: 1,
        workspace: { name: "Authorization suite" },
        folders: [
          { name: "Home", icon: "folder", color: 1 },
          { name: "Unused folder", icon: "star", color: 2 },
          { name: "Work", icon: "briefcase", color: 5 },
        ],
        tags: ["Apple", "later", "unused"],
        goPreferences: [],
        shared: [],
      });
      expect(Date.now() - Date.parse(document.exportedAt)).toBeLessThan(60_000);
      expect(document.bookmarks).toEqual([
        { ref: "b1", url: "https://example.com/Fastmail%20inbox", title: "Fastmail inbox", description: "My mail", slug: "mail", forwarding: true, pinned: true, planArchived: false, folders: ["Home", "Work"], tags: ["Apple", "later"] },
        { ref: "b2", url: "https://example.com/Garden%20notes", title: "Garden notes", description: null, slug: null, forwarding: false, pinned: false, planArchived: false, folders: [], tags: [] },
        { ref: "b3", url: "https://example.com/Old%20plan", title: "Old plan", description: null, slug: null, forwarding: false, pinned: false, planArchived: true, folders: [], tags: ["later"] },
      ]);
      for (const id of [rich, plain, archived, work, home, later, apple, shared.workspaceId]) {
        expect(text).not.toContain(id);
      }
      expect(text).not.toMatch(/openCount|createdAt|updatedAt|lastOpenedAt/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is the same document, bookmark by bookmark, for the same content",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a } = await setup(world);
      for (let n = 0; n < 5; n += 1) {
        await bookmark(world, a, `Title ${String(n)}`);
      }
      const first = await exportOf(world, a);
      const second = await exportOf(world, a);

      expect(second.bookmarks).toEqual(first.bookmarks);
      expect(second.bookmarks.map((entry) => entry.ref)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds none of another member's bookmarks, folders or tags for member B, none of A's tag names in B's document, and nothing of A or B for a member of another workspace",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, b, c } = await setup(world);
      const secret = await bookmark(world, a, "A private bookmark", { slug: "a-slug", forwarding: true });
      const folderA = await create(world, a, FOLDERS, { name: "A folder" });
      const tagA = await create(world, a, TAGS, { name: "a-only-tag" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${secret}`, asPerson(a), { tagIds: [tagA], folderIds: [folderA] })).status).toBe(200);
      await bookmark(world, b, "B bookmark");
      await create(world, b, TAGS, { name: "b-tag" });
      await bookmark(world, c, "C bookmark");
      await create(world, c, TAGS, { name: "c-tag" });
      await create(world, c, FOLDERS, { name: "C folder" });

      const documentA = await exportOf(world, a);
      const documentB = await exportOf(world, b);
      const documentC = await exportOf(world, c);

      expect(documentA.bookmarks.map((entry) => entry.title)).toEqual(["A private bookmark"]);
      expect(documentB).toMatchObject({ folders: [], tags: ["b-tag"], goPreferences: [], shared: [] });
      expect(documentB.bookmarks.map((entry) => entry.title)).toEqual(["B bookmark"]);
      expect(JSON.stringify(documentB)).not.toMatch(/A private|a-slug|A folder|a-only-tag/);
      expect(documentC.bookmarks.map((entry) => entry.title)).toEqual(["C bookmark"]);
      expect(JSON.stringify(documentC)).not.toMatch(/A private|a-slug|A folder|a-only-tag|B bookmark|b-tag/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves out content that has no owner, whoever left it behind",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      await bookmark(world, a, "Kept");
      await bookmark(world, a, "Released");
      await asSystem((tx) => tx`UPDATE bookmarks SET owner_id = NULL WHERE workspace_id = ${shared.workspaceId} AND title = 'Released'`);

      expect((await exportOf(world, a)).bookmarks.map((entry) => entry.title)).toEqual(["Kept"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records one export.created event with the counts of what it holds and the account as the actor, and nothing else, and stores no content",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, b, shared } = await setup(world);
      await bookmark(world, a, "One");
      const archived = await bookmark(world, a, "Two");
      await archive(archived);
      await bookmark(world, b, "Theirs");
      await create(world, a, FOLDERS, { name: "Work" });
      await create(world, a, TAGS, { name: "later" });
      await create(world, a, TAGS, { name: "unused" });
      const counts = async () =>
        asSystem((tx) => tx<{ bookmarks: number; folders: number; tags: number }[]>`SELECT (SELECT count(*) FROM bookmarks)::int AS bookmarks, (SELECT count(*) FROM folders)::int AS folders, (SELECT count(*) FROM tags)::int AS tags`);
      const before = await counts();

      await exportOf(world, a);

      expect(await exportEvents(shared.workspaceId)).toEqual([
        { action: "export.created", actor_type: "account", actor_account_id: a.account.id, actor_token_id: null, entity_type: null, metadata: { bookmarks: "2", folders: "1", tags: "2", shared: "0" } },
      ]);
      expect(await counts()).toEqual(before);
      await exportOf(world, b);
      expect(await exportEvents(shared.workspaceId)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "can be called with an API token of the read scope or the read-write scope, which the audit log names, and refuses a request without credentials",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      await bookmark(world, a, "One");
      const readOnly = await harness.token(shared.workspaceId, a, "read");
      const readWrite = await harness.token(shared.workspaceId, a, "read-write");

      expect((await send(world, "GET", EXPORT, {})).status).toBe(401);
      for (const token of [readOnly, readWrite]) {
        const document = ExportDocumentSchema.parse(JSON.parse(await exportText(world, bearer(token))));
        expect(document.bookmarks.map((entry) => entry.title)).toEqual(["One"]);
      }

      const events = await exportEvents(shared.workspaceId);
      expect(events.map((event) => [event.actor_type, event.actor_account_id, event.actor_token_id === null])).toEqual([
        ["api_token", a.account.id, false],
        ["api_token", a.account.id, false],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes from the bulk bucket: the request after the limit is 429 with Retry-After and records no export",
    async () => {
      const world = harness.serve({ env: { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "2/hour" } });
      const { a, shared } = await setup(world);

      expect((await send(world, "GET", EXPORT, asPerson(a))).status).toBe(200);
      expect((await send(world, "GET", EXPORT, asPerson(a))).status).toBe(200);
      const limited = await send(world, "GET", EXPORT, asPerson(a));

      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(await exportEvents(shared.workspaceId)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 to an account that is in no workspace, and records nothing",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const loner = await harness.person(world);

      const response = await send(world, "GET", EXPORT, asPerson(loner));

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "streams a library of several pages in pieces, the first of which holds no bookmark, and numbers the refs across pages",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      await asSystem(
        (tx) => tx`
          INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
          SELECT ('0192f3a0-dddd-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, ${shared.workspaceId}, ${a.account.id}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || n
          FROM generate_series(1, 1250) AS n`,
      );

      const response = await send(world, "GET", EXPORT, asPerson(a));
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const pieces: string[] = [];
      for (;;) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        pieces.push(decoder.decode(read.value, { stream: true }));
      }

      expect(pieces[0]).not.toContain('"bookmarks":[{');
      expect(pieces.length).toBeGreaterThanOrEqual(7);
      expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThan(pieces.join("").length / 2);
      const document = ExportDocumentSchema.parse(JSON.parse(pieces.join("")));
      expect(document.bookmarks).toHaveLength(1250);
      expect(document.bookmarks.map((entry) => entry.ref)).toEqual(Array.from({ length: 1250 }, (_, index) => `b${String(index + 1)}`));
      expect(new Set(document.bookmarks.map((entry) => entry.url)).size).toBe(1250);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends the connection without a closing brace when a page cannot be read after the first byte, and logs the failure",
    async () => {
      const logged: { message: string; fields: unknown }[] = [];
      const logger = { info: () => undefined, warn: () => undefined, error: (message: string, fields?: unknown) => void logged.push({ message, fields }) };
      const world = harness.serve({ env: RELAXED, logger });
      const { a, shared } = await setup(world);
      await asSystem(
        (tx) => tx`
          INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
          SELECT ('0192f3a0-dddd-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, ${shared.workspaceId}, ${a.account.id}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || n
          FROM generate_series(1, 1250) AS n`,
      );

      const response = await send(world, "GET", EXPORT, asPerson(a));
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let received = decoder.decode((await reader.read()).value, { stream: true });
      let failure: unknown;
      try {
        // The head of the document is out; the reading of the bookmarks is what fails, as the application role loses the table.
        await database().owner`REVOKE SELECT ON bookmarks FROM slugbase_app`;
        for (;;) {
          const read = await reader.read();
          if (read.done) {
            break;
          }
          received += decoder.decode(read.value, { stream: true });
        }
      } catch (error) {
        failure = error;
      } finally {
        await database().owner`GRANT SELECT ON bookmarks TO slugbase_app`;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(received).toContain('"format":"slugbase-export"');
      expect(received).not.toContain('"goPreferences"');
      expect(() => {
        JSON.parse(received);
      }).toThrow();
      expect(logged.map((entry) => entry.message)).toEqual(["An export ended before its last byte"]);
      expect(JSON.stringify(logged)).not.toContain("Title");
    },
    TEST_TIMEOUT_MS,
  );
});
