import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queuedJobCount } from "../invitations/support.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST, GET, PATCH and DELETE of /api/v1/bookmarks (doc 04 sections 2.3, 2.4, 3.2 and 10.6, doc 02 sections 5.1, 5.3 and 5.6, doc 05
// sections 2.2 and 2.4, doc 10 T1, T2, T12 and T13), through the whole chain over the migrated database: what is stored for the URL, the
// title and the description, the answer of a creation (201 and the version), that only the owner reads, changes and deletes
// a bookmark and that another member's, another workspace's and an unknown one are the same 404, that a token needs the write scope to
// create, change and delete and the read scope to read, that a refused creation writes, counts and announces nothing, that a change
// is a merge patch under an optimistic version check, and that a delete is hard and gives the place under the ceiling back.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const CREATED_JOB = "event.bookmark.created";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { readonly path: string; readonly code: string }[];
}

interface Bookmark {
  readonly id: string;
  readonly ownerId: string | null;
  readonly url: string;
  readonly host: string;
  readonly title: string;
  readonly description: string | null;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly pinned: boolean;
  readonly openCount: number;
  readonly lastOpenedAt: string | null;
  readonly folders: readonly { readonly id: string; readonly name: string; readonly icon: string; readonly color: number }[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const create = (world: World, as: Person, body: unknown) => send(world, "POST", BOOKMARKS, { cookie: as.cookie }, body);
const read = (world: World, as: Person, id: string) => send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie });
const patch = (world: World, as: Person, id: string, body: unknown, headers: Record<string, string> = {}) =>
  send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: as.cookie, ...headers }, body);
const remove = (world: World, as: Person, id: string) => send(world, "DELETE", `${BOOKMARKS}/${id}`, { cookie: as.cookie });

async function created(world: World, as: Person, body: unknown): Promise<Bookmark> {
  const response = await create(world, as, body);
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

interface Stored {
  readonly rows: number;
  readonly counter: number;
  readonly jobs: number;
}

async function stored(workspaceId: string): Promise<Stored> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ rows: number; counter: number }[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows, (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter`;
  });
  return { rows: rows[0]?.rows ?? -1, counter: rows[0]?.counter ?? -1, jobs: await queuedJobCount(database(), CREATED_JOB) };
}

/** A workspace of an owner and a member, and one of a stranger. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

describe("createBookmark", () => {
  it(
    "answers 201 with the bookmark and its version in the body, stores it for the caller, counts it and announces it once",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);

      const response = await create(world, owner, { url: "https://example.com/docs", title: "Docs", description: "The docs", pinned: true });

      expect(response.status).toBe(201);
      const bookmark = (await response.json()) as Bookmark;
      expect(bookmark).toEqual({
        id: bookmark.id,
        ownerId: owner.account.id,
        url: "https://example.com/docs",
        host: "example.com",
        title: "Docs",
        description: "The docs",
        slug: null,
        forwarding: false,
        pinned: true,
        openCount: 0,
        lastOpenedAt: null,
        folders: [],
        tags: [],
        version: 1,
        createdAt: bookmark.createdAt,
        updatedAt: bookmark.updatedAt,
      });
      expect(Number.isNaN(Date.parse(bookmark.createdAt))).toBe(false);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("etag")).toBeNull();
      expect(await stored(shared.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
      const jobs = await database().owner<{ data: Record<string, string> }[]>`SELECT data FROM pgboss.job WHERE name = ${CREATED_JOB}`;
      expect(jobs[0]?.data).toMatchObject({ workspaceId: shared.workspaceId, bookmarkId: bookmark.id, accountId: owner.account.id });
      expect(Object.keys(jobs[0]?.data ?? {}).sort()).toEqual(["accountId", "bookmarkId", "eventId", "workspaceId"]);
    },
    TEST_TIMEOUT_MS,
  );

  it("stores the URL normalised and the canonical form and host the cache keys and the facets read", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    const bookmark = await created(world, owner, { url: "  HTTPS://Bücher.Example:443/Docs/?b=2&a=1&utm_source=feed#intro ", title: "  Books  " });

    expect(bookmark.url).toBe("https://xn--bcher-kva.example/Docs/?b=2&a=1&utm_source=feed#intro");
    expect(bookmark.host).toBe("xn--bcher-kva.example");
    expect(bookmark.title).toBe("Books");
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ url_canonical: string; owner_id: string; pinned_at: Date | null }[]>`SELECT url_canonical, owner_id, pinned_at FROM bookmarks WHERE id = ${bookmark.id}`;
    });
    expect(rows[0]).toEqual({ url_canonical: "https://xn--bcher-kva.example/Docs?a=1&b=2", owner_id: owner.account.id, pinned_at: null });
  });

  it("stores an empty description as none and leaves a bookmark unpinned unless asked", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect(await created(world, owner, { url: "https://example.com/", title: "A", description: "   " })).toMatchObject({ description: null, pinned: false });
    expect(await created(world, owner, { url: "https://example.com/", title: "B", pinned: false })).toMatchObject({ description: null, pinned: false });
  });

  it.each([
    ["javascript:alert(document.cookie)"],
    ["JavaScript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["vbscript:msgbox(1)"],
    ["ftp://example.com/file"],
    ["//example.com/a"],
    ["example.com/a"],
    ["   javascript:alert(1)"],
  ])("refuses the URL %j with 422 url_not_allowed and writes nothing", async (url) => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);

    const response = await create(world, owner, { url, title: "Hostile" });

    expect(response.status).toBe(422);
    expect(await problemOf(response)).toMatchObject({ code: "url_not_allowed", status: 422, errors: [{ path: "url", code: "url_not_allowed" }] });
    expect(await stored(shared.workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
  });

  it("refuses an empty, over-long and malformed URL with 422 validation_failed naming the url, and writes nothing", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);

    for (const url of ["", "   ", `https://example.com/${"a".repeat(2048)}`, "https://", "https://exa mple.com/", `https://example.com/${"a b".repeat(600)}`]) {
      const response = await create(world, owner, { url, title: "Bad" });
      expect(response.status, url.slice(0, 40)).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code, url.slice(0, 40)).toBe("validation_failed");
      expect(problem.errors?.map((error) => error.path), url.slice(0, 40)).toEqual(["url"]);
    }
    expect(await stored(shared.workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
  });

  it("accepts a URL of 2 048 characters", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const prefix = "https://example.com/";

    const bookmark = await created(world, owner, { url: prefix + "a".repeat(2048 - prefix.length), title: "Long" });

    expect(bookmark.url).toHaveLength(2048);
  });

  it("refuses a title or a description outside its length, a missing title and a field it does not declare with 422 validation_failed", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const url = "https://example.com/";

    const bodies: [unknown, string][] = [
      [{ url, title: "" }, "title"],
      [{ url, title: "   " }, "title"],
      [{ url, title: "t".repeat(301) }, "title"],
      [{ url }, "title"],
      [{ title: "No URL" }, "url"],
      [{ url, title: "Docs", description: "d".repeat(1001) }, "description"],
      [{ url, title: "Docs", pinned: "yes" }, "pinned"],
      [{ url, title: "Docs", slug: 3 }, "slug"],
      [{ url, title: "Docs", slug: null }, "slug"],
      [{ url, title: "Docs", forwarding: "yes" }, "forwarding"],
      [{ url, title: "Docs", ownerId: "0192f3a0-aaaa-7000-8000-000000000001" }, "ownerId"],
      [{ url, title: "Docs", workspaceId: "0192f3a0-aaaa-7000-8000-000000000001" }, "workspaceId"],
    ];
    for (const [body, path] of bodies) {
      const response = await create(world, owner, body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors?.map((error) => error.path)).toContain(path);
    }
    expect(await stored(shared.workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
  });

  it("holds a title of 300 characters and a description of 1 000, counted as characters", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    const bookmark = await created(world, owner, { url: "https://example.com/", title: "😀".repeat(300), description: "d".repeat(1000) });

    expect(Array.from(bookmark.title)).toHaveLength(300);
    expect(bookmark.description).toHaveLength(1000);
  });

  it("is refused without a session, and to an account that acts in no workspace", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const homeless = await harness.person(world);

    const anonymous = await send(world, "POST", BOOKMARKS, {}, { url: "https://example.com/", title: "A" });
    const noWorkspace = await create(world, homeless, { url: "https://example.com/", title: "A" });

    expect(anonymous.status).toBe(401);
    expect(noWorkspace.status).toBe(404);
    expect((await problemOf(noWorkspace)).code).toBe("not_found");
    expect((await create(world, owner, { url: "https://example.com/", title: "A" })).status).toBe(201);
  });

  it("is refused from another site: the cross-site rules apply to a cookie request", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);

    const response = await send(world, "POST", BOOKMARKS, { cookie: owner.cookie, origin: "https://evil.example" }, { url: "https://example.com/", title: "A" });

    expect(response.status).toBe(403);
    expect((await problemOf(response)).code).toBe("cross_site_request");
    expect(await stored(shared.workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
  });
});

describe("getBookmark", () => {
  it("returns the caller's own bookmark with its version in the body and the ETag", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs", description: "The docs" });

    const response = await read(world, owner, made.id);

    expect(response.status).toBe(200);
    expect((await response.json()) as Bookmark).toEqual(made);
    expect(response.headers.get("etag")).toBe('"1"');
  });

  it("answers 404, as for a bookmark that does not exist, for another member's bookmark of the same workspace (T2)", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    const theirs = await created(world, owner, { url: "https://example.com/private", title: "Owner's private bookmark" });

    const response = await read(world, member, theirs.id);
    const unknown = await read(world, member, "0192f3a0-aaaa-7000-8000-00000000dead");

    expect(response.status).toBe(404);
    const problem = await problemOf(response);
    expect(problem.code).toBe("not_found");
    expect(JSON.stringify(problem)).not.toContain("private");
    expect(JSON.stringify(problem)).not.toContain(theirs.id);
    expect(unknown.status).toBe(404);
    expect((await problemOf(unknown)).code).toBe("not_found");
  });

  it("answers 404 for a bookmark of another workspace, and for it by a member of both only in the workspace it acts in (T1)", async () => {
    const world = harness.serve();
    const { owner, stranger } = await setup(world);
    const ofOwner = await created(world, owner, { url: "https://example.com/mine", title: "Mine" });
    const ofStranger = await created(world, stranger, { url: "https://example.com/theirs", title: "Theirs" });

    expect((await read(world, stranger, ofOwner.id)).status).toBe(404);
    expect((await read(world, owner, ofStranger.id)).status).toBe(404);
    expect((await read(world, stranger, ofStranger.id)).status).toBe(200);
  });

  it("answers 422 for an identifier that is no UUID and 401 without a session", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect((await read(world, owner, "not-a-uuid")).status).toBe(422);
    expect((await send(world, "GET", `${BOOKMARKS}/0192f3a0-aaaa-7000-8000-00000000dead`, {})).status).toBe(401);
  });

  it("leaves out a plan-archived bookmark", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/", title: "Archived soon" });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${made.id}`;
    });

    expect((await read(world, owner, made.id)).status).toBe(404);
  });
});

describe("API tokens", () => {
  it("lets a read-write token create and read, and answers a read-only token's creation 403 token_scope, writing nothing", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
    const readOnly = await harness.token(shared.workspaceId, owner, "read");

    const made = await send(world, "POST", BOOKMARKS, bearer(readWrite), { url: "https://example.com/token", title: "By token" });
    expect(made.status).toBe(201);
    const bookmark = (await made.json()) as Bookmark;
    expect(bookmark.ownerId).toBe(owner.account.id);
    expect(await stored(shared.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });

    const refused = await send(world, "POST", BOOKMARKS, bearer(readOnly), { url: "https://example.com/token", title: "By read token" });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("token_scope");
    expect(await stored(shared.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });

    expect((await send(world, "GET", `${BOOKMARKS}/${bookmark.id}`, bearer(readOnly))).status).toBe(200);
    expect((await send(world, "GET", `${BOOKMARKS}/${bookmark.id}`, bearer(readWrite))).status).toBe(200);
  });

  it("answers a token of another member 404 for a bookmark it does not own, and a token bound to another workspace 404", async () => {
    const world = harness.serve();
    const { owner, member, stranger, shared, other } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/", title: "Owner's" });
    const memberToken = await harness.token(shared.workspaceId, member, "read-write");
    const strangerToken = await harness.token(other.workspaceId, stranger, "read-write");

    expect((await send(world, "GET", `${BOOKMARKS}/${made.id}`, bearer(memberToken))).status).toBe(404);
    expect((await send(world, "GET", `${BOOKMARKS}/${made.id}`, bearer(strangerToken))).status).toBe(404);
  });
});

interface Row {
  readonly url: string;
  readonly url_canonical: string;
  readonly host: string;
  readonly title: string;
  readonly description: string | null;
  readonly pinned_at: Date | null;
  readonly version: number;
  readonly plan_archived_at: Date | null;
}

async function rowOf(id: string): Promise<Row | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Row[]>`SELECT url, url_canonical, host, title, description, pinned_at, version, plan_archived_at FROM bookmarks WHERE id = ${id}`;
  });
  return rows[0];
}

async function archive(id: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${id}`;
    await tx`UPDATE workspaces SET bookmark_count = bookmark_count - 1 WHERE id = (SELECT workspace_id FROM bookmarks WHERE id = ${id})`;
  });
}

describe("updateBookmark", () => {
  it("applies a merge patch to the title, description, destination and pin, derives the canonical form and host again and bumps the version", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs", description: "The docs" });

    const response = await patch(world, owner, made.id, { url: "HTTPS://Bücher.Example:443/New/?b=2&a=1&utm_source=feed#top", title: "  New title  ", description: "New description", pinned: true });

    expect(response.status).toBe(200);
    const bookmark = (await response.json()) as Bookmark;
    expect(bookmark).toMatchObject({
      id: made.id,
      ownerId: owner.account.id,
      url: "https://xn--bcher-kva.example/New/?b=2&a=1&utm_source=feed#top",
      host: "xn--bcher-kva.example",
      title: "New title",
      description: "New description",
      pinned: true,
      slug: null,
      forwarding: false,
      version: 2,
      createdAt: made.createdAt,
    });
    expect(response.headers.get("etag")).toBe('"2"');
    expect(await rowOf(made.id)).toMatchObject({ url_canonical: "https://xn--bcher-kva.example/New?a=1&b=2", host: "xn--bcher-kva.example", version: 2 });
    expect((await rowOf(made.id))?.pinned_at).toBeInstanceOf(Date);
    expect((await (await read(world, owner, made.id)).json()) as Bookmark).toEqual(bookmark);
  });

  it("leaves a field that is left out as it is, clears the description with null and with an empty string, and unpins", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs", description: "The docs", pinned: true });

    const titleOnly = (await (await patch(world, owner, made.id, { title: "Renamed" })).json()) as Bookmark;
    expect(titleOnly).toMatchObject({ title: "Renamed", description: "The docs", pinned: true, url: "https://example.com/docs", version: 2 });

    const cleared = (await (await patch(world, owner, made.id, { description: null, pinned: false })).json()) as Bookmark;
    expect(cleared).toMatchObject({ title: "Renamed", description: null, pinned: false, version: 3 });
    expect((await rowOf(made.id))?.pinned_at).toBeNull();

    await patch(world, owner, made.id, { description: "Back" });
    const emptied = (await (await patch(world, owner, made.id, { description: "   " })).json()) as Bookmark;
    expect(emptied).toMatchObject({ description: null, version: 5 });
  });

  it("answers 200 with the unchanged ETag and writes nothing for an empty patch and for a patch that names the values the bookmark has", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs", description: "The docs", pinned: true });
    const before = await rowOf(made.id);

    for (const body of [{}, { title: "Docs" }, { url: "https://EXAMPLE.com:443/docs", description: "The docs", pinned: true }]) {
      const response = await patch(world, owner, made.id, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(response.headers.get("etag")).toBe('"1"');
      expect(((await response.json()) as Bookmark).updatedAt).toBe(made.updatedAt);
    }
    expect(await rowOf(made.id)).toEqual(before);
  });

  it("refuses a stale If-Match with 412 precondition_failed and writes nothing, and applies a current one, a list holding it and *", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    expect((await patch(world, owner, made.id, { title: "Second" }, { "if-match": '"1"' })).status).toBe(200);

    const stale = await patch(world, owner, made.id, { title: "Overwrite" }, { "if-match": '"1"' });

    expect(stale.status).toBe(412);
    expect((await problemOf(stale)).code).toBe("precondition_failed");
    expect(await rowOf(made.id)).toMatchObject({ title: "Second", version: 2 });
    const current = await patch(world, owner, made.id, { title: "Third" }, { "if-match": '"2"' });
    expect(current.status).toBe(200);
    expect(current.headers.get("etag")).toBe('"3"');
    expect((await patch(world, owner, made.id, { title: "Fourth" }, { "if-match": '"1", "3"' })).status).toBe(200);
    expect((await patch(world, owner, made.id, { title: "Fifth" }, { "if-match": "*" })).status).toBe(200);
    expect(await rowOf(made.id)).toMatchObject({ title: "Fifth", version: 5 });
    for (const header of ['W/"5"', "5", "", '"abc"']) {
      expect((await patch(world, owner, made.id, { title: "Weak" }, { "if-match": header })).status, header).toBe(412);
    }
    expect(await rowOf(made.id)).toMatchObject({ title: "Fifth", version: 5 });
  });

  it("applies a patch without If-Match, as an API token does, and answers the ETag of the new version", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    const token = await harness.token(shared.workspaceId, owner, "read-write");

    const response = await send(world, "PATCH", `${BOOKMARKS}/${made.id}`, bearer(token), { title: "By token" });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"2"');
    expect(((await response.json()) as Bookmark).title).toBe("By token");
  });

  it("answers 404, and leaves the row and the counter as they are, when another member of the workspace patches the owner's private bookmark by id (T2)", async () => {
    const world = harness.serve();
    const { owner, member, shared } = await setup(world);
    const theirs = await created(world, owner, { url: "https://example.com/private", title: "Owner's private bookmark" });
    const before = await rowOf(theirs.id);
    const counted = await stored(shared.workspaceId);

    const response = await patch(world, member, theirs.id, { title: "Hijacked", url: "https://evil.example/", description: "x", pinned: true });
    const withVersion = await patch(world, member, theirs.id, { title: "Hijacked" }, { "if-match": '"1"' });
    const staleVersion = await patch(world, member, theirs.id, { title: "Hijacked" }, { "if-match": '"9"' });

    for (const refused of [response, withVersion, staleVersion]) {
      expect(refused.status).toBe(404);
      const problem = await problemOf(refused);
      expect(problem.code).toBe("not_found");
      expect(JSON.stringify(problem)).not.toContain("private");
    }
    expect(await rowOf(theirs.id)).toEqual(before);
    expect(await stored(shared.workspaceId)).toEqual(counted);
  });

  it("answers 404 for a bookmark of another workspace, an unknown one and a plan-archived one, whichever version the caller names", async () => {
    const world = harness.serve();
    const { owner, stranger, other } = await setup(world);
    const ofOwner = await created(world, owner, { url: "https://example.com/mine", title: "Mine" });
    const archived = await created(world, owner, { url: "https://example.com/archived", title: "Archived" });
    await archive(archived.id);
    const ofStranger = await created(world, stranger, { url: "https://example.com/theirs", title: "Theirs" });

    expect((await patch(world, stranger, ofOwner.id, { title: "Hijacked" })).status).toBe(404);
    expect((await patch(world, owner, ofStranger.id, { title: "Hijacked" })).status).toBe(404);
    expect((await patch(world, owner, "0192f3a0-aaaa-7000-8000-00000000dead", { title: "Nothing" }, { "if-match": '"1"' })).status).toBe(404);
    // Archiving moved the version to 2; the caller names the version the row has and is still refused.
    expect((await patch(world, owner, archived.id, { title: "Edited" }, { "if-match": '"2"' })).status).toBe(404);
    expect(await rowOf(ofOwner.id)).toMatchObject({ title: "Mine", version: 1 });
    expect(await rowOf(ofStranger.id)).toMatchObject({ title: "Theirs", version: 1 });
    expect(await rowOf(archived.id)).toMatchObject({ title: "Archived", version: 2 });
    expect((await stored(other.workspaceId)).rows).toBe(1);
  });

  it("refuses a URL that is not http or https with 422 url_not_allowed, and an empty, over-long or malformed one with validation_failed, and writes nothing", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });

    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//example.com/", "example.com"]) {
      const response = await patch(world, owner, made.id, { url });
      expect(response.status, url).toBe(422);
      expect(await problemOf(response), url).toMatchObject({ code: "url_not_allowed", errors: [{ path: "url", code: "url_not_allowed" }] });
    }
    for (const url of ["", `https://example.com/${"a".repeat(2048)}`, "https://", "https://exa mple.com/"]) {
      const response = await patch(world, owner, made.id, { url });
      expect(response.status, url.slice(0, 30)).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors?.map((error) => error.path)).toEqual(["url"]);
    }
    expect(await rowOf(made.id)).toMatchObject({ url: "https://example.com/docs", version: 1 });
  });

  it("refuses a blank, over-long or null title, an over-long description, null where it is not allowed and a field the operation does not declare, with 422 validation_failed", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });

    const bodies: [unknown, string][] = [
      [{ title: "" }, "title"],
      [{ title: "   " }, "title"],
      [{ title: "t".repeat(301) }, "title"],
      [{ title: null }, "title"],
      [{ url: null }, "url"],
      [{ pinned: null }, "pinned"],
      [{ description: "d".repeat(1001) }, "description"],
      [{ pinned: "yes" }, "pinned"],
      [{ slug: 3 }, "slug"],
      [{ forwarding: null }, "forwarding"],
      [{ ownerId: "0192f3a0-aaaa-7000-8000-000000000001" }, "ownerId"],
      [{ version: 9 }, "version"],
      [{ workspaceId: "0192f3a0-aaaa-7000-8000-000000000001" }, "workspaceId"],
      [{ planArchivedAt: null }, "planArchivedAt"],
    ];
    for (const [body, path] of bodies) {
      const response = await patch(world, owner, made.id, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors?.map((error) => error.path)).toContain(path);
    }
    expect((await patch(world, owner, "not-a-uuid", { title: "X" })).status).toBe(422);
    expect(await rowOf(made.id)).toMatchObject({ title: "Docs", version: 1 });
  });

  it("is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and writes nothing", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    const readOnly = await harness.token(shared.workspaceId, owner, "read");

    expect((await send(world, "PATCH", `${BOOKMARKS}/${made.id}`, {}, { title: "Anonymous" })).status).toBe(401);
    const crossSite = await send(world, "PATCH", `${BOOKMARKS}/${made.id}`, { cookie: owner.cookie, origin: "https://evil.example" }, { title: "Cross site" });
    expect(crossSite.status).toBe(403);
    expect((await problemOf(crossSite)).code).toBe("cross_site_request");
    const scoped = await send(world, "PATCH", `${BOOKMARKS}/${made.id}`, bearer(readOnly), { title: "Read-only" });
    expect(scoped.status).toBe(403);
    expect((await problemOf(scoped)).code).toBe("token_scope");
    expect(await rowOf(made.id)).toMatchObject({ title: "Docs", version: 1 });
  });

  it("lets two patches against one version make one change: the second is refused with 412", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });

    const [first, second] = await Promise.all([
      patch(world, owner, made.id, { title: "From tab one" }, { "if-match": '"1"' }),
      patch(world, owner, made.id, { title: "From tab two" }, { "if-match": '"1"' }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 412]);
    expect((await rowOf(made.id))?.version).toBe(2);
  });
});

describe("deleteBookmark", () => {
  it("deletes the caller's bookmark for good with 204, gives its place back, leaves no row with its slug and answers 404 to a repeat", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    const other = await created(world, owner, { url: "https://example.com/other", title: "Other" });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE bookmarks SET slug = 'docs', forwarding = true WHERE id = ${made.id}`;
    });
    expect((await stored(shared.workspaceId)).counter).toBe(2);

    const response = await remove(world, owner, made.id);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await rowOf(made.id)).toBeUndefined();
    expect(await rowOf(other.id)).toBeDefined();
    expect((await stored(shared.workspaceId))).toMatchObject({ rows: 1, counter: 1 });
    expect((await read(world, owner, made.id)).status).toBe(404);
    const again = await remove(world, owner, made.id);
    expect(again.status).toBe(404);
    expect((await problemOf(again)).code).toBe("not_found");
    expect((await stored(shared.workspaceId))).toMatchObject({ rows: 1, counter: 1 });
    // The slug lives on the row, so no row holds it once the bookmark is gone.
    const holders = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${shared.workspaceId} AND slug = 'docs'`;
    });
    expect(holders[0]?.n).toBe(0);
  });

  it("answers 404, and leaves the row and the counter as they are, when another member of the workspace deletes the owner's private bookmark by id (T2)", async () => {
    const world = harness.serve();
    const { owner, member, shared } = await setup(world);
    const theirs = await created(world, owner, { url: "https://example.com/private", title: "Owner's private bookmark" });
    const before = await rowOf(theirs.id);
    const counted = await stored(shared.workspaceId);

    const response = await remove(world, member, theirs.id);

    expect(response.status).toBe(404);
    const problem = await problemOf(response);
    expect(problem.code).toBe("not_found");
    expect(JSON.stringify(problem)).not.toContain("private");
    expect(await rowOf(theirs.id)).toEqual(before);
    expect(await stored(shared.workspaceId)).toEqual(counted);
    expect((await remove(world, owner, theirs.id)).status).toBe(204);
  });

  it("answers 404 for a bookmark of another workspace and an unknown one, and leaves the other workspace's bookmark and counter alone (T1)", async () => {
    const world = harness.serve();
    const { owner, stranger, shared, other } = await setup(world);
    const ofOwner = await created(world, owner, { url: "https://example.com/mine", title: "Mine" });
    const ofStranger = await created(world, stranger, { url: "https://example.com/theirs", title: "Theirs" });

    expect((await remove(world, stranger, ofOwner.id)).status).toBe(404);
    expect((await remove(world, owner, ofStranger.id)).status).toBe(404);
    expect((await remove(world, owner, "0192f3a0-aaaa-7000-8000-00000000dead")).status).toBe(404);
    expect(await stored(shared.workspaceId)).toMatchObject({ rows: 1, counter: 1 });
    expect(await stored(other.workspaceId)).toMatchObject({ rows: 1, counter: 1 });
  });

  it("keeps the counter at the number of bookmarks that are not plan-archived: deleting one of each kind leaves the counter equal to the rows counted", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const live = await created(world, owner, { url: "https://example.com/live", title: "Live" });
    const archived = await created(world, owner, { url: "https://example.com/archived", title: "Archived" });
    const kept = await created(world, owner, { url: "https://example.com/kept", title: "Kept" });
    await archive(archived.id);
    const counter = async () =>
      (
        await database().owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          return tx<{ counter: number; live: number; total: number }[]>`
            SELECT (SELECT bookmark_count FROM workspaces WHERE id = ${shared.workspaceId}) AS counter,
                   (SELECT count(*) FROM bookmarks WHERE workspace_id = ${shared.workspaceId} AND plan_archived_at IS NULL)::int AS live,
                   (SELECT count(*) FROM bookmarks WHERE workspace_id = ${shared.workspaceId})::int AS total`;
        })
      )[0];
    expect(await counter()).toEqual({ counter: 2, live: 2, total: 3 });

    expect((await remove(world, owner, live.id)).status).toBe(204);
    expect(await counter()).toEqual({ counter: 1, live: 1, total: 2 });
    // The owner may delete a bookmark the plan archived; the counter never counted it.
    expect((await remove(world, owner, archived.id)).status).toBe(204);
    expect(await counter()).toEqual({ counter: 1, live: 1, total: 1 });
    expect((await remove(world, owner, kept.id)).status).toBe(204);
    expect(await counter()).toEqual({ counter: 0, live: 0, total: 0 });
  });

  it("is refused without a session (401), from another site (403 cross_site_request) and to a read-only token (403 token_scope), and deletes nothing; a read-write token deletes", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const made = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    expect((await send(world, "DELETE", `${BOOKMARKS}/${made.id}`, {})).status).toBe(401);
    const crossSite = await send(world, "DELETE", `${BOOKMARKS}/${made.id}`, { cookie: owner.cookie, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect((await problemOf(crossSite)).code).toBe("cross_site_request");
    const scoped = await send(world, "DELETE", `${BOOKMARKS}/${made.id}`, bearer(readOnly));
    expect(scoped.status).toBe(403);
    expect((await problemOf(scoped)).code).toBe("token_scope");
    expect(await rowOf(made.id)).toBeDefined();

    expect((await send(world, "DELETE", `${BOOKMARKS}/${made.id}`, bearer(readWrite))).status).toBe(204);
    expect(await rowOf(made.id)).toBeUndefined();
  });

  it("answers 422 for an identifier that is no UUID", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect((await remove(world, owner, "not-a-uuid")).status).toBe(422);
  });
});
