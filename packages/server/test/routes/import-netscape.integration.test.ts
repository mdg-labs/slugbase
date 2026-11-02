import { ImportResultSchema } from "@slugbase/contracts";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import { NETSCAPE, bookmarkFile, multipart, upload, type FileLink } from "./netscape-upload.ts";

// POST /api/v1/import/netscape (doc 04 sections 5, 6.3 and 10.9, doc 02 section 13.1, doc 10 T1, T5 and T13), through the whole chain over the migrated database. The failure scenario: an upload that is
// not judged by the rules of the JSON import (another answer for the same bookmarks, a dry run that writes, an import.completed that is missing or twice), a request another site can make, a token that
// reaches it, a retry with the same key and another file that replays the first answer, and a retry of the same file, which a browser sends with another boundary, that conflicts.

const TEST_TIMEOUT_MS = 120_000;
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };
const KEY_HEADER = "idempotency-key";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

interface Stored {
  readonly bookmarks: number;
  readonly counter: number;
  readonly folders: number;
  readonly tags: number;
  readonly links: number;
  readonly completed: number;
  readonly events: number;
}

/** What the workspace holds: the rows, the counter, the folders, the tags and their links, and the import audit events. */
async function stored(workspaceId: string): Promise<Stored> {
  const events = await database().owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'event.bookmark.created'`;
  const [row] = await asSystem(
    (tx) => tx<Omit<Stored, "events">[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS bookmarks,
        (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter,
        (SELECT count(*) FROM folders WHERE workspace_id = ${workspaceId})::int AS folders,
        (SELECT count(*) FROM tags WHERE workspace_id = ${workspaceId})::int AS tags,
        (SELECT count(*) FROM folder_bookmarks WHERE workspace_id = ${workspaceId})::int + (SELECT count(*) FROM bookmark_tags WHERE workspace_id = ${workspaceId})::int AS links,
        (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'import.completed')::int AS completed`,
  );
  if (row === undefined) {
    throw new Error("no row");
  }
  return { ...row, events: events[0]?.count ?? -1 };
}

async function titles(workspaceId: string): Promise<[string, string, string[], string[]][]> {
  const rows = await asSystem(
    (tx) => tx<{ url: string; title: string; folders: string[]; tags: string[] }[]>`
      SELECT b.url, b.title,
        coalesce((SELECT array_agg(f.name::text ORDER BY f.name) FROM folder_bookmarks fb JOIN folders f ON f.id = fb.folder_id WHERE fb.bookmark_id = b.id), '{}') AS folders,
        coalesce((SELECT array_agg(t.name::text ORDER BY t.name) FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id), '{}') AS tags
      FROM bookmarks b WHERE b.workspace_id = ${workspaceId} ORDER BY b.url`,
  );
  return rows.map((row) => [row.url, row.title, row.folders, row.tags]);
}

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

async function imported(world: World, as: Person, content: string, path = NETSCAPE, headers: Record<string, string> = {}) {
  const response = await upload(world, as, content, { path, headers });
  expect(response.status).toBe(200);
  return ImportResultSchema.parse(await response.json());
}

const LINKS: readonly FileLink[] = [
  { url: "https://example.com/news", title: "News", folder: "Reading", tags: ["News", "tech"] },
  { url: "https://example.com/more?b=2&a=1", title: "More", folder: "Reading" },
  { url: "https://example.com/loose", title: "" },
  { url: "javascript:void(0)", title: "A bookmarklet" },
  { url: "place:sort=8", title: "A query", folder: "Reading" },
];

describe("POST /import/netscape", { timeout: TEST_TIMEOUT_MS }, () => {
  it("creates the bookmarks of the file with their folders and tags, reports the links it refuses, raises the counter by what it created and records one import.completed", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);

    const result = await imported(world, a, bookmarkFile(LINKS));

    expect(result).toMatchObject({ detected: { bookmarks: 5, folders: 1, tags: 2 }, created: 3, skipped: [], slugsDropped: 0, foldersCreated: 1, tagsCreated: 2 });
    expect(result.failed.map((entry) => [entry.position, entry.reason])).toEqual([
      [2, "url_not_allowed"],
      [5, "url_not_allowed"],
    ]);
    expect(await titles(shared.workspaceId)).toEqual([
      ["https://example.com/loose", "example.com", [], []],
      ["https://example.com/more?b=2&a=1", "More", ["Reading"], []],
      ["https://example.com/news", "News", ["Reading"], ["News", "tech"]],
    ]);
    expect(await stored(shared.workspaceId)).toEqual({ bookmarks: 3, counter: 3, folders: 1, tags: 2, links: 4, completed: 1, events: 3 });
  });

  it("answers a dry run as the write answers it, writes nothing and records no import.completed", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const html = bookmarkFile(LINKS);

    const preview = await imported(world, a, html, `${NETSCAPE}?dryRun=true`);

    expect(await stored(shared.workspaceId)).toEqual({ bookmarks: 0, counter: 0, folders: 0, tags: 0, links: 0, completed: 0, events: 0 });
    const result = await imported(world, a, html);
    expect(preview).toEqual(result);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, completed: 1 });
  });

  it("judges the bookmarks of the file as the JSON import judges them: the same answer, the same duplicates, folders and tags matched without regard to case", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, c, shared, elsewhere } = await setup(world);
    const html = bookmarkFile([...LINKS, { url: "https://EXAMPLE.com/news/?utm_source=x", title: "Again", folder: "reading", tags: ["NEWS"] }]);
    // The file lists the links that name no folder first, then each folder's.
    const asJson = [
      { url: "https://example.com/loose", title: "" },
      { url: "javascript:void(0)", title: "A bookmarklet" },
      { url: "https://example.com/news", title: "News", folders: ["Reading"], tags: ["News", "tech"] },
      { url: "https://example.com/more?b=2&a=1", title: "More", folders: ["Reading"] },
      { url: "place:sort=8", title: "A query", folders: ["Reading"] },
      { url: "https://EXAMPLE.com/news/?utm_source=x", title: "Again", folders: ["reading"], tags: ["NEWS"] },
    ];

    const fromHtml = await imported(world, a, html);
    const fromJson = ImportResultSchema.parse(await (await send(world, "POST", "/api/v1/import/json", { cookie: c.cookie }, asJson)).json());

    expect(fromHtml).toEqual(fromJson);
    expect(fromHtml.skipped.map((entry) => [entry.position, entry.reason])).toEqual([[6, "duplicate"]]);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, folders: 1, tags: 2 });
    expect(await stored(elsewhere.workspaceId)).toMatchObject({ bookmarks: 3, folders: 1, tags: 2 });

    // The caller has all of it now: a second upload creates nothing, and with skipDuplicates=false it creates the bookmarks again under the folders and tags that are there.
    const again = await imported(world, a, html);
    expect(again).toMatchObject({ created: 0, foldersCreated: 0, tagsCreated: 0 });
    expect(again.skipped).toHaveLength(4);
    const forced = await imported(world, a, html, `${NETSCAPE}?skipDuplicates=false`);
    expect(forced).toMatchObject({ created: 4, skipped: [], foldersCreated: 0, tagsCreated: 0 });
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 7, folders: 1, tags: 2, completed: 3 });
  });

  it("refuses an upload of more than 5 000 links with 422, in the dry run and in the write, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const html = bookmarkFile(Array.from({ length: 5001 }, (_, index) => ({ url: `https://example.com/${String(index)}` })));

    for (const path of [NETSCAPE, `${NETSCAPE}?dryRun=true`]) {
      const response = await upload(world, a, html, { path });
      expect(response.status, path).toBe(422);
      expect(await response.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "", code: "too_big" }] });
    }
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, completed: 0 });
  });

  it("refuses a file that would create more than 10 000 new folders and tags, as the JSON import does, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const html = bookmarkFile([{ url: "https://example.com/many", tags: Array.from({ length: 1000 }, (_, index) => `t${String(index)}`) }, ...Array.from({ length: 10 }, (_, index) => ({ url: `https://example.com/${String(index)}`, tags: Array.from({ length: 1000 }, (_value, tag) => `u${String(index)}-${String(tag)}`) }))]);

    const response = await upload(world, a, html);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: [{ path: "", code: "too_many_new_names" }] });
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, tags: 0, completed: 0 });
  });

  it("is an operation of the application's own page: a cookie request with another content type is 403 cross_site_request, one from another origin is too, and JSON is 415", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const body = bookmarkFile(LINKS);
    const headers = (contentType: string, extra: Record<string, string> = {}) => ({ origin: world.origin, cookie: a.cookie, "content-type": contentType, ...extra });
    const attempt = (init: Record<string, string>, content: string = body) => world.server.fetch(new Request(new URL(NETSCAPE, world.origin), { method: "POST", headers: init, body: content }));

    for (const contentType of ["text/plain", "text/html", "application/x-www-form-urlencoded", "application/octet-stream", "application/vnd.api+json"]) {
      const response = await attempt(headers(contentType));
      expect(response.status, contentType).toBe(403);
      expect(await response.json(), contentType).toMatchObject({ code: "cross_site_request" });
    }
    const foreign = await upload(world, a, body, { headers: { origin: "https://evil.example" } });
    const withoutOrigin = await upload(world, a, body, { headers: { origin: "" } });
    const fetchSite = await upload(world, a, body, { headers: { "sec-fetch-site": "cross-site" } });
    expect([foreign.status, withoutOrigin.status, fetchSite.status]).toEqual([403, 403, 403]);
    expect(await foreign.json()).toMatchObject({ code: "cross_site_request" });

    const asJson = await attempt(headers("application/json"), JSON.stringify([{ url: "https://example.com/" }]));
    const noBody = await attempt(headers("application/json"), "");
    expect(asJson.status).toBe(415);
    expect(await asJson.json()).toMatchObject({ code: "unsupported_media_type" });
    expect(noBody.status).toBe(415);
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, completed: 0 });
  });

  it("is a session's operation: no session is 401, and an API token of either scope is refused by policy, with the file or without, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, shared } = await setup(world);
    const html = bookmarkFile(LINKS);
    const writing = await harness.token(shared.workspaceId, a, "read-write");
    const reading = await harness.token(shared.workspaceId, a, "read");

    const anonymous = await upload(world, a, html, { cookie: null });
    expect(anonymous.status).toBe(401);
    for (const token of [writing, reading]) {
      const asJson = await send(world, "POST", NETSCAPE, bearer(token), { url: "https://example.com/" });
      expect(asJson.status).toBe(403);
      expect(await asJson.json()).toMatchObject({ code: "forbidden" });
      // The cross-site stage does not look at a bearer request, so the content type of its upload is held by the body-limits stage: a token cannot send the file at all.
      const asUpload = await upload(world, a, html, { cookie: null, headers: bearer(token) });
      expect(asUpload.status).toBe(415);
      expect(await asUpload.json()).toMatchObject({ code: "unsupported_media_type" });
    }
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 0, completed: 0 });
  });

  it("is the member's own: the file is imported into the workspace of the request for the caller, and a bookmark of another member or workspace is no duplicate of it", async () => {
    const world = harness.serve({ env: RELAXED });
    const { a, b, shared, elsewhere } = await setup(world);

    await imported(world, b, bookmarkFile([{ url: "https://example.com/news", title: "B's", folder: "Reading" }]));
    const result = await imported(world, a, bookmarkFile([{ url: "https://example.com/news", title: "A's", folder: "Reading" }]));

    expect(result).toMatchObject({ created: 1, skipped: [], foldersCreated: 1 });
    expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 2, folders: 2, completed: 2 });
    expect(await stored(elsewhere.workspaceId)).toMatchObject({ bookmarks: 0, folders: 0, completed: 0 });
  });

  describe("with an Idempotency-Key", () => {
    it("answers the stored answer to the same file, sent again with another boundary, creates nothing twice, and conflicts for another file", async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      const key = crypto.randomUUID();
      const html = bookmarkFile(LINKS);

      const first = await upload(world, a, html, { headers: { [KEY_HEADER]: key } });
      const firstBody = await first.json();
      const replay = await upload(world, a, html, { headers: { [KEY_HEADER]: key }, filename: "renamed.html" });
      const conflict = await upload(world, a, bookmarkFile([...LINKS, { url: "https://example.com/one-more" }]), { headers: { [KEY_HEADER]: key } });
      const sameSizeConflict = await upload(world, a, html.replace("example.com/loose", "example.com/lease"), { headers: { [KEY_HEADER]: key } });
      const asDryRun = await upload(world, a, html, { path: `${NETSCAPE}?dryRun=true`, headers: { [KEY_HEADER]: key } });

      expect(first.status).toBe(200);
      expect(first.headers.get("idempotency-replayed")).toBeNull();
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.json()).toEqual(firstBody);
      for (const refused of [conflict, sameSizeConflict, asDryRun]) {
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: "idempotency_conflict" });
      }
      expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, counter: 3, completed: 1 });
    });

    it("does not give a key of the JSON import to the upload, or the other way round", async () => {
      const world = harness.serve({ env: RELAXED });
      const { a } = await setup(world);
      const key = crypto.randomUUID();

      expect((await send(world, "POST", "/api/v1/import/json", { cookie: a.cookie, [KEY_HEADER]: key }, [{ url: "https://example.com/json" }])).status).toBe(200);
      const upload2 = await upload(world, a, bookmarkFile([{ url: "https://example.com/json" }]), { headers: { [KEY_HEADER]: key } });

      expect(upload2.status).toBe(409);
    });

    it("stores nothing for an upload that fails, so that the retry with the same key runs", async () => {
      const world = harness.serve({ env: RELAXED });
      const { a, shared } = await setup(world);
      const key = crypto.randomUUID();

      const refused = await multipart(world, a, "--b--\r\n", "multipart/form-data; boundary=b", { [KEY_HEADER]: key });
      const retried = await upload(world, a, bookmarkFile(LINKS), { headers: { [KEY_HEADER]: key } });

      expect(refused.status).toBe(422);
      expect(retried.status).toBe(200);
      expect(retried.headers.get("idempotency-replayed")).toBeNull();
      expect(await stored(shared.workspaceId)).toMatchObject({ bookmarks: 3, completed: 1 });
    });
  });
});
