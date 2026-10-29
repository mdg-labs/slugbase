import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/bookmarks (doc 04 sections 6.1, 6.2 and 10.6, doc 02 section 5.7, Q42, doc 10 T1 and T2), through the whole chain over the
// migrated database: that only the caller's own bookmarks of the workspace are listed, that every sort pages through them exactly once, that
// the filters and the capped total are right, and the failure scenario: a cursor issued for one sort that is replayed with another, one with
// a byte of its payload flipped, and one issued to another member or for other filters are refused with 400 bad_request.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"] as const;

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

interface Listed {
  readonly items: readonly { readonly id: string; readonly title: string; readonly ownerId: string | null }[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly totalAtLeast?: number;
}

const list = (world: World, as: Person, query = "") => send(world, "GET", `${BOOKMARKS}${query === "" ? "" : `?${query}`}`, { cookie: as.cookie });

async function listed(world: World, as: Person, query = ""): Promise<Listed> {
  const response = await list(world, as, query);
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
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

interface Seed {
  readonly title: string;
  readonly createdAt?: string;
  readonly openCount?: number;
  readonly lastOpenedAt?: string | null;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly canonical?: string;
}

async function seed(workspaceId: string, owner: Person, rows: readonly Seed[]): Promise<string[]> {
  const ids: string[] = [];
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    for (const [index, row] of rows.entries()) {
      const [made] = await tx<{ id: string }[]>`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, plan_archived_at, open_count, last_opened_at, created_at)
        VALUES (gen_random_uuid(), ${workspaceId}, ${owner.account.id}, ${row.canonical ?? `https://example.com/${String(index)}`}, ${row.canonical ?? `https://example.com/${String(index)}`}, 'example.com',
                ${row.title}, ${row.slug ?? null}, ${row.forwarding ?? false}, ${row.pinned === true ? "2026-01-01T00:00:00Z" : null}::text::timestamptz,
                ${row.archived === true ? "2026-01-01T00:00:00Z" : null}::text::timestamptz, ${row.openCount ?? 0}, ${row.lastOpenedAt ?? null}::text::timestamptz,
                ${row.createdAt ?? "2026-03-01T10:00:00Z"}::text::timestamptz)
        RETURNING id`;
      ids.push(made?.id ?? "");
    }
  });
  return ids;
}

/** `count` filler bookmarks of the owner, written by the database in one statement. */
async function fill(workspaceId: string, owner: Person, count: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      SELECT gen_random_uuid(), ${workspaceId}, ${owner.account.id}, 'https://example.com/f' || n, 'https://example.com/f' || n, 'example.com', 'Filler ' || n
      FROM generate_series(1, ${count}) AS n`;
  });
}

const titles = (page: Listed): string[] => page.items.map((item) => item.title);

/** Reads every page of a list, following `nextCursor`, `limit` bookmarks at a time. */
async function walk(world: World, as: Person, query: string, limit: number): Promise<Listed["items"]> {
  const items: Listed["items"][number][] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100; pages += 1) {
    const page: Listed = await listed(world, as, `${query}&limit=${String(limit)}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    items.push(...page.items);
    if (page.nextCursor === null) {
      return items;
    }
    cursor = page.nextCursor;
  }
  throw new Error("a list of a few dozen bookmarks did not end");
}

describe("listBookmarks", () => {
  it("lists the caller's bookmarks newest first, with the page's cursor and the total, and leaves out another member's, another workspace's and plan-archived ones (T1, T2)", async () => {
    const world = harness.serve();
    const { owner, member, stranger, shared, other } = await setup(world);
    await seed(shared.workspaceId, owner, [
      { title: "Old", createdAt: "2026-03-01T10:00:00Z" },
      { title: "New", createdAt: "2026-03-03T10:00:00Z" },
      { title: "Middle", createdAt: "2026-03-02T10:00:00Z" },
      { title: "Archived", createdAt: "2026-03-04T10:00:00Z", archived: true },
    ]);
    await seed(shared.workspaceId, member, [{ title: "The member's", createdAt: "2026-03-05T10:00:00Z" }]);
    await seed(other.workspaceId, stranger, [{ title: "The stranger's", createdAt: "2026-03-06T10:00:00Z" }]);

    const page = await listed(world, owner);

    expect(titles(page)).toEqual(["New", "Middle", "Old"]);
    expect(page.items.every((item) => item.ownerId === owner.account.id)).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(3);
    expect(page).not.toHaveProperty("totalAtLeast");
    expect(titles(await listed(world, member))).toEqual(["The member's"]);
    expect(titles(await listed(world, stranger))).toEqual(["The stranger's"]);
  }, TEST_TIMEOUT_MS);

  it("answers an empty list with a total of 0 to a member who has no bookmarks", async () => {
    const world = harness.serve();
    const { member } = await setup(world);

    expect(await listed(world, member)).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("returns 48 bookmarks when the limit is left out and at most 100 when it is asked for, and refuses a limit outside 1 to 100 with 422", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await fill(shared.workspaceId, owner, 120);

    const byDefault = await listed(world, owner);
    expect(byDefault.items).toHaveLength(48);
    expect(byDefault.nextCursor).not.toBeNull();
    expect(byDefault.total).toBe(120);
    expect((await listed(world, owner, "limit=100")).items).toHaveLength(100);
    expect((await listed(world, owner, "limit=1")).items).toHaveLength(1);
    for (const limit of ["0", "101", "-1", "1.5", "many"]) {
      const response = await list(world, owner, `limit=${limit}`);
      expect(response.status, limit).toBe(422);
      expect((await problemOf(response)).code).toBe("validation_failed");
    }
  }, TEST_TIMEOUT_MS);

  it.each(SORTS)("pages through every bookmark exactly once, in the order of the database, when the sort is %s", async (sort) => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const rows: Seed[] = [];
    for (let n = 0; n < 23; n += 1) {
      rows.push({
        title: n % 2 === 0 ? `Alpha ${String(n % 4)}` : `alpha ${String(n % 4)}`,
        createdAt: `2026-03-01T10:00:${String(Math.floor(n / 3)).padStart(2, "0")}.123456Z`,
        openCount: n % 4,
        lastOpenedAt: n % 3 === 0 ? null : `2026-03-02T10:00:${String(Math.floor(n / 4)).padStart(2, "0")}.654321Z`,
      });
    }
    await seed(shared.workspaceId, owner, rows);
    const order = {
      recent: "created_at DESC, id DESC",
      oldest: "created_at ASC, id ASC",
      title_asc: "lower(title) ASC, id ASC",
      title_desc: "lower(title) DESC, id DESC",
      most_used: "open_count DESC, id DESC",
      recently_opened: "last_opened_at DESC NULLS LAST, id DESC",
    }[sort];
    const expected = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx.unsafe<{ id: string }[]>(`SELECT id FROM bookmarks WHERE workspace_id = $1 ORDER BY ${order}`, [shared.workspaceId]);
    });

    const items = await walk(world, owner, `sort=${sort}`, 5);

    expect(items.map((item) => item.id)).toEqual(expected.map((row) => row.id));
    expect(new Set(items.map((item) => item.id)).size).toBe(23);
  }, TEST_TIMEOUT_MS);

  it("lists a bookmark that was never opened after every opened one under recently_opened", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await seed(shared.workspaceId, owner, [
      { title: "Never", lastOpenedAt: null, createdAt: "2026-03-09T10:00:00Z" },
      { title: "Long ago", lastOpenedAt: "2026-01-01T10:00:00Z" },
      { title: "Today", lastOpenedAt: "2026-03-01T10:00:00Z" },
    ]);

    expect(titles(await listed(world, owner, "sort=recently_opened"))).toEqual(["Today", "Long ago", "Never"]);
    expect(titles(await listed(world, owner, "sort=most_used&limit=1"))).toHaveLength(1);
  });

  it("filters on pinning, slug and forwarding, each as true and as false, and the filters together", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await seed(shared.workspaceId, owner, [
      { title: "Plain" },
      { title: "Pinned", pinned: true },
      { title: "Slug", slug: "slug-a" },
      { title: "Forwarding", slug: "slug-b", forwarding: true },
      { title: "All", slug: "slug-c", forwarding: true, pinned: true },
    ]);
    const filtered = async (query: string) => titles(await listed(world, owner, `${query}&sort=title_asc`)).sort();

    expect(await filtered("pinned=true")).toEqual(["All", "Pinned"]);
    expect(await filtered("pinned=false")).toEqual(["Forwarding", "Plain", "Slug"]);
    expect(await filtered("hasSlug=true")).toEqual(["All", "Forwarding", "Slug"]);
    expect(await filtered("hasSlug=false")).toEqual(["Pinned", "Plain"]);
    expect(await filtered("forwarding=true")).toEqual(["All", "Forwarding"]);
    expect(await filtered("forwarding=false")).toEqual(["Pinned", "Plain", "Slug"]);
    expect(await filtered("pinned=true&forwarding=true&hasSlug=true")).toEqual(["All"]);
    expect((await listed(world, owner, "pinned=true")).total).toBe(2);
    expect(await filtered("scope=mine")).toEqual(["All", "Forwarding", "Pinned", "Plain", "Slug"]);
    expect(await filtered("scope=all")).toEqual(["All", "Forwarding", "Pinned", "Plain", "Slug"]);
  });

  it("finds the caller's bookmarks whose canonical URL is that of the value, for the duplicate warning, and none of another member's", async () => {
    const world = harness.serve();
    const { owner, member, shared } = await setup(world);
    await seed(shared.workspaceId, owner, [
      { title: "First", canonical: "https://example.com/a" },
      { title: "Second", canonical: "https://example.com/a" },
      { title: "Elsewhere", canonical: "https://example.com/b" },
    ]);
    await seed(shared.workspaceId, member, [{ title: "The member's", canonical: "https://example.com/a" }]);

    const found = await listed(world, owner, `url=${encodeURIComponent("  HTTPS://Example.com:443/a/?utm_source=x#top ")}&sort=title_asc`);

    expect(titles(found)).toEqual(["First", "Second"]);
    expect(found.total).toBe(2);
    expect(titles(await listed(world, member, `url=${encodeURIComponent("https://example.com/a")}`))).toEqual(["The member's"]);
    expect(titles(await listed(world, owner, `url=${encodeURIComponent("https://example.com/none")}`))).toEqual([]);
  });

  it("refuses a url that cannot be a bookmark's with 422 validation_failed naming the url", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    for (const url of ["javascript:alert(1)", "not a url", "https://"]) {
      const response = await list(world, owner, `url=${encodeURIComponent(url)}`);
      expect(response.status, url).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors?.map((error) => error.path)).toEqual(["url"]);
    }
  });

  it("refuses a boolean other than true or false, an unknown sort or scope and a parameter the operation does not declare with 422", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    for (const query of ["pinned=yes", "pinned=1", "hasSlug=TRUE", "forwarding=", "sort=newest", "scope=shared", "folderId=not-an-identifier", "search=docs"]) {
      const response = await list(world, owner, query);
      expect(response.status, query).toBe(422);
      expect((await problemOf(response)).code).toBe("validation_failed");
    }
  });

  it("counts exactly up to 10 000 and gives null with totalAtLeast above", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await fill(shared.workspaceId, owner, 10_000);

    const atCap = await listed(world, owner, "limit=1");
    expect(atCap.total).toBe(10_000);
    expect(atCap).not.toHaveProperty("totalAtLeast");

    await fill(shared.workspaceId, owner, 1);

    const above = await listed(world, owner, "limit=1");
    expect(above.total).toBeNull();
    expect(above.totalAtLeast).toBe(10_000);
    expect(above.items).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("refuses a cursor issued for sort=recent when it is replayed with sort=most_used, and a cursor with a byte of its payload flipped, with 400 bad_request", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await fill(shared.workspaceId, owner, 12);
    const first = await listed(world, owner, "sort=recent&limit=5");
    const cursor = first.nextCursor ?? "";
    expect(cursor).not.toBe("");
    expect((await list(world, owner, `sort=recent&limit=5&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);

    const replayed = await list(world, owner, `sort=most_used&limit=5&cursor=${encodeURIComponent(cursor)}`);
    expect(replayed.status).toBe(400);
    expect((await problemOf(replayed)).code).toBe("bad_request");

    const [payload = "", signature = ""] = cursor.split(".");
    const bytes = Buffer.from(payload, "base64url");
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0x01;
    const flipped = `${bytes.toString("base64url")}.${signature}`;
    const tampered = await list(world, owner, `sort=recent&limit=5&cursor=${encodeURIComponent(flipped)}`);
    expect(tampered.status).toBe(400);
    expect((await problemOf(tampered)).code).toBe("bad_request");
  }, TEST_TIMEOUT_MS);

  it("pages past bookmarks with the longest title under both title sorts: the cursor of a 300-character multibyte title is accepted", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const longest = "\u6f22".repeat(300);
    await seed(shared.workspaceId, owner, [{ title: longest }, { title: `${longest.slice(1)}\u6f23` }, { title: "Z last" }]);

    for (const sort of ["title_asc", "title_desc"]) {
      const first = await listed(world, owner, `sort=${sort}&limit=2`);
      expect(first.nextCursor?.length ?? 0).toBeGreaterThan(512);
      const walked = await walk(world, owner, `sort=${sort}`, 1);
      expect(walked).toHaveLength(3);
      expect(new Set(walked.map((item) => item.id)).size).toBe(3);
    }
  }, TEST_TIMEOUT_MS);

  it("refuses a cursor that was never issued, one issued for other filters and one issued to another member, with 400 bad_request", async () => {
    const world = harness.serve();
    const { owner, member, shared } = await setup(world);
    await fill(shared.workspaceId, owner, 12);
    await fill(shared.workspaceId, member, 12);
    const cursor = (await listed(world, owner, "limit=5")).nextCursor ?? "";
    const forged = Buffer.from(JSON.stringify({ key: ["2026-03-01 10:00:00+00", "0192f3a0-aaaa-7000-8000-00000000dead"] })).toString("base64url");

    const refusals = [
      await list(world, owner, `limit=5&cursor=${encodeURIComponent("not-a-cursor")}`),
      await list(world, owner, `limit=5&cursor=${encodeURIComponent(`${forged}.AAAA`)}`),
      await list(world, owner, `limit=5&scope=mine&cursor=${encodeURIComponent(cursor)}`),
      await list(world, owner, `limit=5&pinned=false&cursor=${encodeURIComponent(cursor)}`),
      await list(world, owner, `limit=5&hasSlug=false&cursor=${encodeURIComponent(cursor)}`),
      await list(world, member, `limit=5&cursor=${encodeURIComponent(cursor)}`),
    ];

    for (const response of refusals) {
      expect(response.status).toBe(400);
      expect((await problemOf(response)).code).toBe("bad_request");
    }
  }, TEST_TIMEOUT_MS);

  it("narrows the list to the bookmarks a text matches by title, host, slug and description, in the order asked for and with the total of the matches, and leaves out those no member may read (T1, T2)", async () => {
    const world = harness.serve();
    const { owner, member, stranger, shared, other } = await setup(world);
    await seed(shared.workspaceId, owner, [
      { title: "Kubernetes handbook", createdAt: "2026-03-01T10:00:00Z" },
      { title: "Reading list", createdAt: "2026-03-02T10:00:00Z", slug: "kube-list" },
      { title: "Cooking", createdAt: "2026-03-03T10:00:00Z" },
      { title: "Kubernetes archived", createdAt: "2026-03-04T10:00:00Z", archived: true },
      { title: "Another kubernetes", createdAt: "2026-03-05T10:00:00Z" },
    ]);
    await seed(shared.workspaceId, member, [{ title: "The member's kubernetes", createdAt: "2026-03-06T10:00:00Z" }]);
    await seed(other.workspaceId, stranger, [{ title: "The stranger's kubernetes", createdAt: "2026-03-07T10:00:00Z" }]);

    const newest = await listed(world, owner, "q=kube");
    const alphabetical = await listed(world, owner, `q=${encodeURIComponent("  KUBE ")}&sort=title_asc`);

    expect(titles(newest)).toEqual(["Another kubernetes", "Reading list", "Kubernetes handbook"]);
    expect(newest.total).toBe(3);
    expect(newest.nextCursor).toBeNull();
    expect(titles(alphabetical)).toEqual(["Another kubernetes", "Kubernetes handbook", "Reading list"]);
    expect(titles(await listed(world, member, "q=kube"))).toEqual(["The member's kubernetes"]);
    expect(titles(await listed(world, stranger, "q=kube"))).toEqual(["The stranger's kubernetes"]);
    expect(await listed(world, owner, "q=nothingmatchesthis")).toMatchObject({ items: [], total: 0 });
  }, TEST_TIMEOUT_MS);

  it("keeps the filters and pages through the matches exactly once with the cursor, whatever the sort", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await seed(
      shared.workspaceId,
      owner,
      Array.from({ length: 14 }, (_, n) => ({ title: n % 3 === 0 ? `Widget ${String(n)}` : `Gadget ${String(n)}`, createdAt: `2026-03-01T10:00:${String(10 + n)}Z`, openCount: n % 4, pinned: n % 2 === 0, slug: n % 3 === 0 ? `widget-${String(n)}` : null })),
    );

    for (const sort of SORTS) {
      const pages = await walk(world, owner, `q=widget&sort=${sort}`, 2);
      expect(pages.map((item) => item.title).sort(), sort).toEqual(["Widget 0", "Widget 12", "Widget 3", "Widget 6", "Widget 9"]);
    }
    expect(titles(await listed(world, owner, "q=widget&pinned=true&sort=title_asc"))).toEqual(["Widget 0", "Widget 12", "Widget 6"]);
    expect(titles(await listed(world, owner, "q=widget&hasSlug=true&pinned=false&sort=title_asc"))).toEqual(["Widget 3", "Widget 9"]);
    expect((await listed(world, owner, "q=widget&pinned=true")).total).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("refuses a cursor issued for q=a that is replayed with q=b, with another case of the text or without it, with 400 bad_request, and opens it again for the same text", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await seed(
      shared.workspaceId,
      owner,
      Array.from({ length: 12 }, (_, n) => ({ title: `Alpha ${String(n)}`, createdAt: `2026-03-01T10:00:${String(10 + n)}Z` })),
    );
    await seed(
      shared.workspaceId,
      owner,
      Array.from({ length: 12 }, (_, n) => ({ title: `Beta ${String(n)}`, createdAt: `2026-03-02T10:00:${String(10 + n)}Z` })),
    );
    const first = await listed(world, owner, "q=alpha&limit=5");
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    expect(first.nextCursor).not.toBeNull();

    for (const replay of [`q=beta&limit=5&cursor=${cursor}`, `q=ALPHA&limit=5&cursor=${cursor}`, `limit=5&cursor=${cursor}`]) {
      const response = await list(world, owner, replay);
      expect(response.status, replay).toBe(400);
      expect((await problemOf(response)).code, replay).toBe("bad_request");
    }
    const next = await listed(world, owner, `q=alpha&limit=5&cursor=${cursor}`);
    expect(next.items).toHaveLength(5);
    expect(next.items.every((item) => item.title.startsWith("Alpha"))).toBe(true);
    // A cursor issued for a list without a text opens no list with one either.
    const plain = (await listed(world, owner, "limit=5")).nextCursor ?? "";
    expect((await list(world, owner, `q=alpha&limit=5&cursor=${encodeURIComponent(plain)}`)).status).toBe(400);
  }, TEST_TIMEOUT_MS);

  it("lists with a text that holds a NUL or another control character as the search reads it, and a text of nothing else lists nothing, never a 500", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await seed(shared.workspaceId, owner, [{ title: "Kubernetes handbook" }, { title: "Cooking" }]);

    expect(titles(await listed(world, owner, "q=kube%00"))).toEqual(["Kubernetes handbook"]);
    expect(titles(await listed(world, owner, `q=${encodeURIComponent("\u0007kube\u0000")}`))).toEqual(["Kubernetes handbook"]);
    expect(await listed(world, owner, "q=a%00b")).toMatchObject({ items: [], total: 0 });
    expect(await listed(world, owner, `q=${encodeURIComponent("\u0000\u0001")}`)).toMatchObject({ items: [], total: 0 });
  }, TEST_TIMEOUT_MS);

  it("refuses a text that is empty, blank or over 100 characters, with 422", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    for (const query of ["q=", `q=${encodeURIComponent("   ")}`, `q=${"a".repeat(101)}`]) {
      const response = await list(world, owner, query);
      expect(response.status, query).toBe(422);
      expect((await problemOf(response)).code, query).toBe("validation_failed");
    }
    expect((await list(world, owner, `q=${"a".repeat(100)}`)).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("refuses the cursor of another list: the cursor of the member list is no bookmark cursor", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await fill(shared.workspaceId, owner, 3);
    const members = await send(world, "GET", "/api/v1/members?limit=1", { cookie: owner.cookie });
    const cursor = ((await members.json()) as { nextCursor: string | null }).nextCursor ?? "";
    expect(cursor).not.toBe("");

    expect((await list(world, owner, `cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });

  it("is refused without a session with 401, and answers a read-only token its own workspace's bookmarks only", async () => {
    const world = harness.serve();
    const { owner, stranger, shared, other } = await setup(world);
    await seed(shared.workspaceId, owner, [{ title: "Owner's" }]);
    await seed(other.workspaceId, stranger, [{ title: "Stranger's" }]);
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const strangerToken = await harness.token(other.workspaceId, stranger, "read");

    expect((await send(world, "GET", BOOKMARKS, {})).status).toBe(401);
    expect(titles((await (await send(world, "GET", BOOKMARKS, bearer(readOnly))).json()) as Listed)).toEqual(["Owner's"]);
    expect(titles((await (await send(world, "GET", BOOKMARKS, bearer(strangerToken))).json()) as Listed)).toEqual(["Stranger's"]);
  });
});
