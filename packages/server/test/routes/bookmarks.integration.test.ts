import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queuedJobCount } from "../invitations/support.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/bookmarks and GET /api/v1/bookmarks/{id} (doc 04 sections 2.3, 2.4, 3.2 and 10.6, doc 02 section 5.1, doc 05 sections
// 2.2 and 2.4, doc 10 T1, T2, T12 and T13), through the whole chain over the migrated database: what is stored for the URL, the title
// and the description, the answer of a creation (201, Location, ETag, the version), that only the owner reads a bookmark and that
// another member's, another workspace's and an unknown one are the same 404, that a token needs the write scope to create and the read
// scope to read, and that a refused creation writes, counts and announces nothing.

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
    "answers 201 with the bookmark, its version in the body and in the ETag and its address in Location, stores it for the caller, counts it and announces it once",
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
        version: 1,
        createdAt: bookmark.createdAt,
        updatedAt: bookmark.updatedAt,
      });
      expect(Number.isNaN(Date.parse(bookmark.createdAt))).toBe(false);
      expect(response.headers.get("location")).toBe(`/api/v1/bookmarks/${bookmark.id}`);
      expect(response.headers.get("etag")).toBe('"1"');
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
      [{ url, title: "Docs", slug: "docs" }, "slug"],
      [{ url, title: "Docs", forwarding: true }, "forwarding"],
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
