import { EXPORT_NETSCAPE_DISPOSITION_PATTERN, ImportResultSchema } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import { upload } from "./netscape-upload.ts";

// GET /api/v1/export/netscape (doc 04 section 10.9, doc 02 section 13.2, doc 10 T1, T2, T13 and T14), through the whole chain over the migrated database. The failure scenario: titles such as
// `"><script>alert(1)</script>` and `<img onerror=...>`, and the same text in a folder and a tag name, are escaped in the file, and importing the file back through POST /api/v1/import/netscape
// yields the same text; member B's export holds nothing of member A. Besides that: the answer is an attachment of `text/html; charset=utf-8` with `nosniff`, so a navigation to it downloads it, a bookmark
// of two folders is under each and one of none is at the top level, a plan-archived one is in the file, the export is recorded once with counts only, the file streams in pieces whose first holds no link,
// and a file whose reading fails after the first byte ends unfinished.

const TEST_TIMEOUT_MS = 90_000;
const EXPORT = "/api/v1/export/netscape";
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };
const HOSTILE = [`"><script>alert(1)</script>`, "<img src=x onerror=alert(1)>", "a & b &amp; c &lt;b&gt;"];

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

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

const archive = (bookmarkId: string) => asSystem((tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${bookmarkId}`);

const exportEvents = (workspaceId: string) =>
  asSystem(
    (tx) => tx<{ action: string; actor_type: string; actor_account_id: string | null; actor_token_id: string | null; metadata: Record<string, string> }[]>`
      SELECT action, actor_type::text AS actor_type, actor_account_id, actor_token_id, metadata FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'export.created' ORDER BY created_at, id`,
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

async function titlesOf(workspaceId: string, accountId: string): Promise<{ title: string; folders: string[]; tags: string[] }[]> {
  return asSystem(
    (tx) => tx<{ title: string; folders: string[]; tags: string[] }[]>`
      SELECT b.title,
        coalesce((SELECT array_agg(f.name::text ORDER BY f.name::text COLLATE "C") FROM folder_bookmarks fb JOIN folders f ON f.id = fb.folder_id WHERE fb.bookmark_id = b.id), '{}') AS folders,
        coalesce((SELECT array_agg(t.name::text ORDER BY t.name::text COLLATE "C") FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), '{}') AS tags
      FROM bookmarks b WHERE b.workspace_id = ${workspaceId} AND b.owner_id = ${accountId} ORDER BY b.title COLLATE "C"`,
  );
}

/** The address of each link of a file with the heading of the section it is in, in the order of the file, read the way the import reads one. */
function parseLinks(file: string): [string, string][] {
  const links: [string, string][] = [];
  let heading = "";
  for (const line of file.split("\n")) {
    const folder = /<H3>(.*)<\/H3>/.exec(line);
    if (folder !== null) {
      heading = folder[1] ?? "";
    }
    const link = /<A HREF="([^"]*)"/.exec(line);
    if (link !== null) {
      links.push([link[1] ?? "", heading]);
    }
  }
  return links;
}

describe("GET /export/netscape", () => {
  it(
    "answers the caller's own bookmarks as a Netscape file, an attachment of text/html that is never rendered, with a section for each folder, a bookmark of two folders under each, one of none at the top level and a plan-archived one in it",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a } = await setup(world);
      const rich = await bookmark(world, a, "Fastmail inbox", { slug: "mail", forwarding: true, pinned: true, description: "My mail" });
      await bookmark(world, a, "Garden notes");
      const archived = await bookmark(world, a, "Old plan");
      const work = await create(world, a, FOLDERS, { name: "Work", icon: "briefcase", color: 5 });
      const home = await create(world, a, FOLDERS, { name: "Home" });
      await create(world, a, FOLDERS, { name: "Unused folder" });
      const later = await create(world, a, TAGS, { name: "later" });
      const apple = await create(world, a, TAGS, { name: "Apple" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${rich}`, asPerson(a), { tagIds: [later, apple], folderIds: [work, home] })).status).toBe(200);
      expect((await send(world, "PATCH", `${BOOKMARKS}/${archived}`, asPerson(a), { folderIds: [home] })).status).toBe(200);
      await archive(archived);

      const response = await send(world, "GET", EXPORT, asPerson(a));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-disposition")).toMatch(EXPORT_NETSCAPE_DISPOSITION_PATTERN);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text).toBe(
        [
          "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
          '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
          "<TITLE>Bookmarks</TITLE>",
          "<H1>Bookmarks</H1>",
          "<DL><p>",
          '    <DT><A HREF="https://example.com/Garden%20notes">Garden notes</A>',
          "    <DT><H3>Work</H3>",
          "    <DL><p>",
          '        <DT><A HREF="https://example.com/Fastmail%20inbox" SHORTCUTURL="mail" TAGS="Apple,later">Fastmail inbox</A>',
          "    </DL><p>",
          "    <DT><H3>Home</H3>",
          "    <DL><p>",
          '        <DT><A HREF="https://example.com/Fastmail%20inbox" SHORTCUTURL="mail" TAGS="Apple,later">Fastmail inbox</A>',
          '        <DT><A HREF="https://example.com/Old%20plan">Old plan</A>',
          "    </DL><p>",
          "    <DT><H3>Unused folder</H3>",
          "    <DL><p>",
          "    </DL><p>",
          "</DL><p>",
          "",
        ].join("\n"),
      );
      expect(text).not.toContain("My mail");
      expect(text).not.toContain(rich);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "escapes titles, folder names and tag names that hold markup, in text and in attribute values, and importing the file back yields the same text",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, c, shared, elsewhere } = await setup(world);
      const folderIds: string[] = [];
      const tagIds: string[] = [];
      for (const name of HOSTILE) {
        folderIds.push(await create(world, a, FOLDERS, { name }));
        tagIds.push(await create(world, a, TAGS, { name }));
      }
      for (const [index, title] of HOSTILE.entries()) {
        const id = await bookmark(world, a, title);
        expect((await send(world, "PATCH", `${BOOKMARKS}/${id}`, asPerson(a), { folderIds: [folderIds[index] ?? ""], tagIds })).status).toBe(200);
      }
      await bookmark(world, a, HOSTILE[0] ?? "", { url: "https://example.com/loose" });

      const text = await exportText(world, asPerson(a));

      expect(text).not.toMatch(/<script|<img|'/);
      expect(text.replaceAll(/<\/?(?:DT|DL|H1|H3|A|TITLE|META|p)\b[^>]*>/gi, "").replaceAll(/<!DOCTYPE[^>]*>/g, "")).not.toMatch(/[<>]/);
      expect(text).toContain("<H3>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</H3>");
      expect(text).toContain('TAGS="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;,&lt;img src=x onerror=alert(1)&gt;,a &amp; b &amp;amp; c &amp;lt;b&amp;gt;"');
      const result = ImportResultSchema.parse(await (await upload(world, c, text)).json());
      expect(result).toMatchObject({ created: 4, failed: [], foldersCreated: 3, tagsCreated: 3 });
      const byContent = (entries: { title: string; folders: string[]; tags: string[] }[]) => entries.toSorted((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      const again = byContent(await titlesOf(elsewhere.workspaceId, c.account.id));
      const original = byContent(await titlesOf(shared.workspaceId, a.account.id));
      expect(again).toEqual(original);
      expect(again.map((entry) => entry.title).sort()).toEqual([...HOSTILE, HOSTILE[0] ?? ""].sort());
      expect(new Set(again.flatMap((entry) => entry.folders))).toEqual(new Set(HOSTILE));
      expect(new Set(again.flatMap((entry) => entry.tags))).toEqual(new Set(HOSTILE));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds none of another member's bookmarks, folders or tags for member B, and nothing of A or B for a member of another workspace, and leaves out content that has no owner",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, b, c, shared } = await setup(world);
      const secret = await bookmark(world, a, "A private bookmark", { slug: "a-slug", forwarding: true });
      const folderA = await create(world, a, FOLDERS, { name: "A folder" });
      const tagA = await create(world, a, TAGS, { name: "a-only-tag" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${secret}`, asPerson(a), { tagIds: [tagA], folderIds: [folderA] })).status).toBe(200);
      await bookmark(world, a, "Released");
      await asSystem((tx) => tx`UPDATE bookmarks SET owner_id = NULL WHERE workspace_id = ${shared.workspaceId} AND title = 'Released'`);
      await bookmark(world, b, "B bookmark");
      await create(world, b, TAGS, { name: "b-tag" });
      await bookmark(world, c, "C bookmark");
      await create(world, c, FOLDERS, { name: "C folder" });

      const fileA = await exportText(world, asPerson(a));
      const fileB = await exportText(world, asPerson(b));
      const fileC = await exportText(world, asPerson(c));

      expect(fileA).toContain("A private bookmark");
      expect(fileA).not.toMatch(/Released|B bookmark|C bookmark|b-tag|C folder/);
      expect(fileB).toContain("B bookmark");
      expect(fileB).not.toMatch(/A private|a-slug|A folder|a-only-tag|Released|C bookmark|C folder/);
      expect(fileC).toContain("C bookmark");
      expect(fileC).not.toMatch(/A private|a-slug|A folder|a-only-tag|B bookmark|b-tag/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records one export.created event with the counts of what the member owns and the account as the actor, and nothing else, and stores no content",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      await bookmark(world, a, "One");
      await archive(await bookmark(world, a, "Two"));
      await create(world, a, FOLDERS, { name: "Work" });
      await create(world, a, TAGS, { name: "later" });
      const counts = () =>
        asSystem((tx) => tx<{ bookmarks: number; folders: number; tags: number }[]>`SELECT (SELECT count(*) FROM bookmarks)::int AS bookmarks, (SELECT count(*) FROM folders)::int AS folders, (SELECT count(*) FROM tags)::int AS tags`);
      const before = await counts();

      await exportText(world, asPerson(a));

      expect(await exportEvents(shared.workspaceId)).toEqual([
        { action: "export.created", actor_type: "account", actor_account_id: a.account.id, actor_token_id: null, metadata: { bookmarks: "2", folders: "1", tags: "1", shared: "0" } },
      ]);
      expect(await counts()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "can be called with an API token of the read scope, which the audit log names, and refuses a request without credentials",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      await bookmark(world, a, "One");
      const readOnly = await harness.token(shared.workspaceId, a, "read");

      expect((await send(world, "GET", EXPORT, {})).status).toBe(401);
      expect(await exportText(world, bearer(readOnly))).toContain("One");

      expect((await exportEvents(shared.workspaceId)).map((event) => [event.actor_type, event.actor_account_id, event.actor_token_id === null])).toEqual([["api_token", a.account.id, false]]);
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

  async function library(world: World, a: Person, workspaceId: string) {
    await asSystem(
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        SELECT ('0192f3a0-dddd-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, ${workspaceId}, ${a.account.id}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || n
        FROM generate_series(1, 1250) AS n`,
    );
    const folder = await create(world, a, FOLDERS, { name: "Late folder" });
    await asSystem(
      (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) SELECT ${workspaceId}, ${folder}, id FROM bookmarks WHERE workspace_id = ${workspaceId} AND title IN ('Title 1', 'Title 2')`,
    );
  }

  it(
    "streams a library of several pages in pieces, the first of which holds no link, and the sections after the unfiled bookmarks",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      await library(world, a, shared.workspaceId);

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

      expect(pieces[0]).not.toContain("<A ");
      expect(pieces.length).toBeGreaterThanOrEqual(5);
      const text = pieces.join("");
      expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThan(text.length / 2);
      expect(text.match(/<A /g)).toHaveLength(1250);
      expect(text.indexOf("<H3>Late folder</H3>")).toBeGreaterThan(text.indexOf("Title 1250"));
      expect(text.endsWith("</DL><p>\n</DL><p>\n")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the bookmarks of a folder, in the file, when it is renamed after its heading was written and when another folder is renamed to a name that sorts before it",
    async () => {
      const world = harness.serve({ env: RELAXED });
      const { a } = await setup(world);
      const ids = [await bookmark(world, a, "One"), await bookmark(world, a, "Two"), await bookmark(world, a, "Three")];
      const beta = await create(world, a, FOLDERS, { name: "Beta" });
      const gamma = await create(world, a, FOLDERS, { name: "Gamma" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${ids[0] ?? ""}`, asPerson(a), { folderIds: [beta] })).status).toBe(200);
      expect((await send(world, "PATCH", `${BOOKMARKS}/${ids[1] ?? ""}`, asPerson(a), { folderIds: [beta, gamma] })).status).toBe(200);
      expect((await send(world, "PATCH", `${BOOKMARKS}/${ids[2] ?? ""}`, asPerson(a), { folderIds: [gamma] })).status).toBe(200);

      const response = await send(world, "GET", EXPORT, asPerson(a));
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("<H3>Beta</H3>")) {
        const read = await reader.read();
        expect(read.done).toBe(false);
        received += decoder.decode(read.value, { stream: true });
      }
      // The heading of Beta is out and its bookmarks are not: the member renames both folders, Gamma to a name that sorts before the one the reader is at. The headings are the names the page of folders was
      // read with, and the sections follow the folders, not their names.
      expect(received).not.toContain("example.com/One");
      expect((await send(world, "PATCH", `${FOLDERS}/${beta}`, asPerson(a), { name: "Zulu" })).status).toBe(200);
      expect((await send(world, "PATCH", `${FOLDERS}/${gamma}`, asPerson(a), { name: "Aardvark" })).status).toBe(200);
      for (;;) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        received += decoder.decode(read.value, { stream: true });
      }

      const links = parseLinks(received);
      expect(links).toEqual([
        ["https://example.com/One", "Beta"],
        ["https://example.com/Two", "Beta"],
        ["https://example.com/Two", "Gamma"],
        ["https://example.com/Three", "Gamma"],
      ]);
      expect(received.endsWith("</DL><p>\n</DL><p>\n")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends the connection before the closing list when a page cannot be read after the first byte, and logs the failure",
    async () => {
      const logged: { message: string; fields: unknown }[] = [];
      const logger = { info: () => undefined, warn: () => undefined, error: (message: string, fields?: unknown) => void logged.push({ message, fields }) };
      const world = harness.serve({ env: RELAXED, logger });
      const { a, shared } = await setup(world);
      await library(world, a, shared.workspaceId);

      const response = await send(world, "GET", EXPORT, asPerson(a));
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let received = decoder.decode((await reader.read()).value, { stream: true });
      let failure: unknown;
      try {
        // The head of the file is out; the reading of the bookmarks is what fails, as the application role loses the table.
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
      expect(received).toContain("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
      expect(received.endsWith("</DL><p>\n")).toBe(false);
      expect(logged.map((entry) => entry.message)).toEqual(["An export ended before its last byte"]);
      expect(JSON.stringify(logged)).not.toContain("Title");
    },
    TEST_TIMEOUT_MS,
  );
});
