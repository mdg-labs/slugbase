import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, MEMBERS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// Slugs and forwarding on bookmarks (doc 04 sections 1, 10.6 and 10.7, doc 02 sections 3.5 and 6.1, doc 05 section 2.4, doc 10 T1, T2 and T12): `slug`
// and `forwarding` on the creation and the change of a bookmark and GET /slugs/availability, through the whole chain over the migrated database. The
// failure scenarios: two requests that set one slug on two bookmarks of one owner at once, which make one success and one 409 and never two rows, and
// two members who each own `mail` and both leave, which the unique key of the ownerless namespace refused for the second.

const BOOKMARKS = "/api/v1/bookmarks";
const AVAILABILITY = "/api/v1/slugs/availability";
const UNKNOWN = "0192f3a0-aaaa-7000-8000-00000000dead";

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
  readonly detail: string;
  readonly errors?: readonly { readonly path: string; readonly code: string }[];
}

interface Bookmark {
  readonly id: string;
  readonly ownerId: string | null;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly version: number;
}

interface Availability {
  readonly status: string;
  readonly othersUseCount: number;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const create = (world: World, as: Person, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  send(world, "POST", BOOKMARKS, { cookie: as.cookie, ...headers }, { url: "https://example.com/docs", title: "Docs", ...body });
const patch = (world: World, as: Person, id: string, body: unknown, headers: Record<string, string> = {}) => send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: as.cookie, ...headers }, body);
const read = async (world: World, as: Person, id: string): Promise<Bookmark> => (await (await send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie })).json()) as Bookmark;

async function created(world: World, as: Person, body: Record<string, unknown> = {}): Promise<Bookmark> {
  const response = await create(world, as, body);
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

async function availability(world: World, as: Person, query: string): Promise<Availability> {
  const response = await send(world, "GET", `${AVAILABILITY}?${query}`, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as Availability;
}

interface Stored {
  readonly id: string;
  readonly owner_id: string | null;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly url: string;
}

async function stored(): Promise<Stored[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Stored[]>`SELECT id, owner_id, slug, forwarding, url FROM bookmarks ORDER BY id`;
  });
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

describe("creating a bookmark with a slug", () => {
  it("stores the slug trimmed and lower-cased, with forwarding on when the request says nothing", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    const response = await create(world, owner, { slug: "  Mail " });

    expect(response.status).toBe(201);
    const bookmark = (await response.json()) as Bookmark;
    expect(bookmark).toMatchObject({ slug: "mail", forwarding: true, version: 1 });
    expect(await read(world, owner, bookmark.id)).toMatchObject({ slug: "mail", forwarding: true });
    expect((await stored()).map((row) => [row.slug, row.forwarding])).toEqual([["mail", true]]);
  });

  it("keeps forwarding off when the request says so, and stores a bookmark without a slug as before", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect(await created(world, owner, { slug: "later", forwarding: false })).toMatchObject({ slug: "later", forwarding: false });
    expect(await created(world, owner, { forwarding: false })).toMatchObject({ slug: null, forwarding: false });
    expect(await created(world, owner)).toMatchObject({ slug: null, forwarding: false });
  });

  it.each(["", "   ", "-leading", "has space", "under_score", "Ünicode", "a".repeat(65), "a/b", "mail?x=1"])(
    "answers 422 validation_failed on slug for %j, with an explanation, and writes nothing",
    async (slug) => {
      const world = harness.serve();
      const { owner } = await setup(world);

      const response = await create(world, owner, { slug });

      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors).toEqual([{ path: "slug", code: "invalid_slug" }]);
      expect(problem.detail).toMatch(/lower-case letters, digits and hyphens/);
      expect(await stored()).toEqual([]);
    },
  );

  it("accepts the longest slug and one that starts with a digit, and no word is reserved", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    for (const slug of ["a".repeat(64), "0-ok", "login", "api", "go", "settings"]) {
      expect(await created(world, owner, { slug }), slug).toMatchObject({ slug });
    }
  });

  it("answers 422 validation_failed on forwarding when it is on and there is no slug, and writes nothing", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    const response = await create(world, owner, { forwarding: true });

    expect(response.status).toBe(422);
    expect((await problemOf(response)).errors).toEqual([{ path: "forwarding", code: "forwarding_requires_slug" }]);
    expect(await stored()).toEqual([]);
  });

  it("answers 409 slug_taken for a slug the caller already uses, whatever its case, and lets another member have it", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    await created(world, owner, { slug: "mail" });

    for (const slug of ["mail", "Mail", " MAIL "]) {
      const response = await create(world, owner, { slug });
      expect(response.status, slug).toBe(409);
      const problem = await problemOf(response);
      expect(problem.code).toBe("slug_taken");
      expect(problem.errors).toEqual([{ path: "slug", code: "slug_taken" }]);
      expect(problem.detail).toBe('You already use the slug "mail" in this workspace.');
    }
    expect(await created(world, member, { slug: "mail" })).toMatchObject({ slug: "mail", forwarding: true });
    expect((await stored()).filter((row) => row.slug === "mail")).toHaveLength(2);
    expect(await stored()).toHaveLength(2);
  });

  it("takes no place under the bookmark count for a refused slug", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await created(world, owner, { slug: "mail" });
    await create(world, owner, { slug: "mail" });
    await create(world, owner, { slug: "Bad Slug" });

    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${shared.workspaceId}`;
    });
    expect(rows[0]?.bookmark_count).toBe(1);
  });

  it("runs the retry of a refused creation with the same Idempotency-Key, since a refusal keeps no key", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const first = await created(world, owner, { slug: "mail" });
    const key = crypto.randomUUID();

    const refused = await create(world, owner, { slug: "mail" }, { "idempotency-key": key });
    expect(refused.status).toBe(409);
    expect(await patch(world, owner, first.id, { slug: "inbox" })).toHaveProperty("status", 200);
    const retried = await create(world, owner, { slug: "mail" }, { "idempotency-key": key });

    expect(retried.status).toBe(201);
    expect(retried.headers.get("idempotency-replayed")).toBeNull();
  });
});

describe("changing the slug and forwarding of a bookmark", () => {
  it("sets, changes and clears the slug, and turns forwarding off and on, moving the ETag each time", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const { id } = await created(world, owner);

    const set = await patch(world, owner, id, { slug: "Mail", forwarding: true });
    expect(set.status).toBe(200);
    expect(set.headers.get("etag")).toBe('"2"');
    expect(await set.json()).toMatchObject({ slug: "mail", forwarding: true, version: 2 });
    expect(await (await patch(world, owner, id, { slug: "inbox" })).json()).toMatchObject({ slug: "inbox", forwarding: true, version: 3 });
    expect(await (await patch(world, owner, id, { forwarding: false })).json()).toMatchObject({ slug: "inbox", forwarding: false, version: 4 });
    expect(await (await patch(world, owner, id, { forwarding: true })).json()).toMatchObject({ slug: "inbox", forwarding: true, version: 5 });
    expect(await (await patch(world, owner, id, { slug: null, forwarding: false })).json()).toMatchObject({ slug: null, forwarding: false, version: 6 });
    const same = await patch(world, owner, id, { slug: null });
    expect(same.status).toBe(200);
    expect(same.headers.get("etag")).toBe('"6"');
  });

  it("sets a slug on a bookmark that has none without turning forwarding on, and a patch that names the stored values keeps the ETag", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const { id } = await created(world, owner);

    expect(await (await patch(world, owner, id, { slug: "mail" })).json()).toMatchObject({ slug: "mail", forwarding: false, version: 2 });
    const same = await patch(world, owner, id, { slug: "MAIL", forwarding: false });
    expect(same.status).toBe(200);
    expect(same.headers.get("etag")).toBe('"2"');
  });

  it("answers 422 on forwarding for clearing the slug while forwarding stays on, and for turning forwarding on without a slug, and writes nothing", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const forwarding = await created(world, owner, { slug: "mail" });
    const plain = await created(world, owner);

    for (const [id, body] of [
      [forwarding.id, { slug: null }],
      [forwarding.id, { slug: null, forwarding: true }],
      [plain.id, { forwarding: true }],
      [plain.id, { slug: null, forwarding: true }],
    ] as const) {
      const response = await patch(world, owner, id, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors).toEqual([{ path: "forwarding", code: "forwarding_requires_slug" }]);
    }
    expect(await read(world, owner, forwarding.id)).toMatchObject({ slug: "mail", forwarding: true, version: 1 });
    expect(await read(world, owner, plain.id)).toMatchObject({ slug: null, forwarding: false, version: 1 });
  });

  it("answers 422 validation_failed on slug for a slug outside the grammar, and writes nothing", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const { id } = await created(world, owner, { slug: "mail" });

    for (const slug of ["", "Not Valid", "-x", "x".repeat(65)]) {
      const response = await patch(world, owner, id, { slug });
      expect(response.status, slug).toBe(422);
      expect((await problemOf(response)).errors).toEqual([{ path: "slug", code: "invalid_slug" }]);
    }
    expect(await read(world, owner, id)).toMatchObject({ slug: "mail", version: 1 });
  });

  it("answers 409 slug_taken for a slug the caller uses on another bookmark and writes nothing, and lets another member have it", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    await created(world, owner, { slug: "mail" });
    const mine = await created(world, owner);
    const theirs = await created(world, member);

    const response = await patch(world, owner, mine.id, { slug: "Mail" });

    expect(response.status).toBe(409);
    const problem = await problemOf(response);
    expect(problem.code).toBe("slug_taken");
    expect(problem.errors).toEqual([{ path: "slug", code: "slug_taken" }]);
    expect(await read(world, owner, mine.id)).toMatchObject({ slug: null, version: 1 });
    expect((await patch(world, member, theirs.id, { slug: "mail", forwarding: true })).status).toBe(200);
  });

  it("refuses a stale version before it looks at the slug, and another member's bookmark with 404", async () => {
    const world = harness.serve();
    const { owner, member } = await setup(world);
    const { id } = await created(world, owner);

    const stale = await patch(world, owner, id, { slug: "mail" }, { "if-match": '"9"' });
    const foreign = await patch(world, member, id, { slug: "mail" });

    expect(stale.status).toBe(412);
    expect(foreign.status).toBe(404);
    expect(await read(world, owner, id)).toMatchObject({ slug: null, version: 1 });
  });

  it("frees the slug the moment its bookmark is deleted", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const first = await created(world, owner, { slug: "mail" });
    expect((await create(world, owner, { slug: "mail" })).status).toBe(409);

    expect((await send(world, "DELETE", `${BOOKMARKS}/${first.id}`, { cookie: owner.cookie })).status).toBe(204);

    expect((await create(world, owner, { slug: "mail" })).status).toBe(201);
  });
});

describe("the failure scenario: two requests set one slug on two bookmarks of one owner at once", () => {
  it("makes one success and one 409, and one row with the slug, for each of several rounds", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const rounds = 8;
    const pairs: [Bookmark, Bookmark][] = [];
    for (let round = 0; round < rounds; round += 1) {
      pairs.push([await created(world, owner), await created(world, owner)]);
    }

    const answers = await Promise.all(
      pairs.map(async ([a, b], round) => {
        const slug = `race-${String(round)}`;
        return Promise.all([patch(world, owner, a.id, { slug, forwarding: true }), patch(world, owner, b.id, { slug, forwarding: true })]);
      }),
    );

    for (const [round, pair] of answers.entries()) {
      expect(pair.map((response) => response.status).sort(), `round ${String(round)}`).toEqual([200, 409]);
      const [first, second] = pair;
      expect((await problemOf(first.status === 409 ? first : second)).code).toBe("slug_taken");
    }
    const rows = await stored();
    for (let round = 0; round < rounds; round += 1) {
      expect(rows.filter((row) => row.slug === `race-${String(round)}`), `round ${String(round)}`).toHaveLength(1);
    }
  });

  it("makes one success and one 409 of two creations that set one slug at once", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    const [one, two] = await Promise.all([create(world, owner, { slug: "race" }), create(world, owner, { slug: "race" })]);

    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect((await stored()).filter((row) => row.slug === "race")).toHaveLength(1);
  });
});

describe("GET /slugs/availability", () => {
  it("answers available for a slug the caller does not use, taken_by_me for one they do, and invalid outside the grammar", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    await created(world, owner, { slug: "mail" });

    expect(await availability(world, owner, "slug=docs")).toEqual({ status: "available", othersUseCount: 0 });
    expect(await availability(world, owner, "slug=mail")).toEqual({ status: "taken_by_me", othersUseCount: 0 });
    expect(await availability(world, owner, "slug=%20MAIL%20")).toEqual({ status: "taken_by_me", othersUseCount: 0 });
    for (const slug of ["", "%20", "-x", "has%20space", "x".repeat(65)]) {
      expect(await availability(world, owner, `slug=${slug}`), slug).toEqual({ status: "invalid", othersUseCount: 0 });
    }
  });

  it("makes the current slug of the caller's own bookmark available, and still refuses it for another bookmark", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const mail = await created(world, owner, { slug: "mail" });
    const other = await created(world, owner);

    expect(await availability(world, owner, `slug=mail&bookmarkId=${mail.id}`)).toEqual({ status: "available", othersUseCount: 0 });
    expect(await availability(world, owner, `slug=mail&bookmarkId=${other.id}`)).toEqual({ status: "taken_by_me", othersUseCount: 0 });
    expect(await availability(world, owner, `slug=free&bookmarkId=${mail.id}`)).toEqual({ status: "available", othersUseCount: 0 });
  });

  it("counts the other members' bookmarks that use the slug, and never lets them make it unavailable", async () => {
    const world = harness.serve();
    const { owner, member, stranger } = await setup(world);
    await created(world, member, { slug: "mail" });
    await created(world, stranger, { slug: "mail" });

    expect(await availability(world, owner, "slug=mail")).toEqual({ status: "available", othersUseCount: 1 });
    expect(await availability(world, member, "slug=mail")).toEqual({ status: "taken_by_me", othersUseCount: 0 });
    expect(await availability(world, stranger, "slug=mail")).toEqual({ status: "taken_by_me", othersUseCount: 0 });
  });

  it("answers 404 for a bookmarkId that is another member's, another workspace's or unknown, alike", async () => {
    const world = harness.serve();
    const { owner, member, stranger } = await setup(world);
    const theirs = await created(world, member, { slug: "mail" });
    const strangers = await created(world, stranger);

    for (const bookmarkId of [theirs.id, strangers.id, UNKNOWN]) {
      const response = await send(world, "GET", `${AVAILABILITY}?slug=mail&bookmarkId=${bookmarkId}`, { cookie: owner.cookie });
      expect(response.status, bookmarkId).toBe(404);
      expect((await problemOf(response)).code).toBe("not_found");
    }
  });

  it("answers 422 for a missing slug and a malformed bookmarkId, and 401 without a session", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect((await send(world, "GET", AVAILABILITY, { cookie: owner.cookie })).status).toBe(422);
    expect((await send(world, "GET", `${AVAILABILITY}?slug=mail&bookmarkId=nope`, { cookie: owner.cookie })).status).toBe(422);
    expect((await send(world, "GET", `${AVAILABILITY}?slug=mail`, {})).status).toBe(401);
  });
});

describe("a member who leaves while owning a slug an ownerless bookmark holds", () => {
  it("lets two members who each own mail be removed, and clears the slug of the second bookmark only", async () => {
    const world = harness.serve();
    const owner = await harness.person(world);
    const member = await harness.person(world);
    const third = await harness.person(world);
    await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }, { person: third, role: "member" }]);
    const first = await created(world, member, { slug: "mail" });
    const second = await created(world, third, { slug: "mail" });

    const removedFirst = await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "transfer" });
    const removedSecond = await send(world, "DELETE", `${MEMBERS}/${third.account.id}`, { cookie: owner.cookie }, { content: "transfer" });

    expect(removedFirst.status).toBe(200);
    expect(removedSecond.status).toBe(200);
    const rows = await stored();
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ owner_id: null, slug: "mail", forwarding: true, url: "https://example.com/docs" });
    expect(rows.find((row) => row.id === second.id)).toMatchObject({ owner_id: null, slug: null, forwarding: false, url: "https://example.com/docs" });
  });
});
