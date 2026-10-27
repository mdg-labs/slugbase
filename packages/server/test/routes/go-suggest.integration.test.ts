import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/go/suggest (doc 04 section 10.8, doc 02 section 9.2, doc 05 section 4, doc 10 T1, T2 and T12), through the whole chain over the migrated database. The failure scenario: a
// prefix of `%` or `_` answers every slug of the workspace, or the slug of a bookmark in another workspace, another member's private bookmark, a bookmark that does not forward or a
// plan-archived one is suggested; the slugs that `POST /go/resolve` names for the member are exactly the ones suggested.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const RESOLVE = "/api/v1/go/resolve";
const SUGGEST = "/api/v1/go/suggest";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Suggestion {
  readonly slug: string;
  readonly bookmarkId: string;
  readonly title: string;
  readonly host: string;
  readonly owner: { accountId: string; displayName: string } | null;
  readonly sharedVia: string | null;
}

const ask = (world: World, headers: Record<string, string>, prefix: string) => send(world, "GET", `${SUGGEST}?prefix=${encodeURIComponent(prefix)}`, headers);
const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });

async function suggestions(world: World, headers: Record<string, string>, prefix: string): Promise<Suggestion[]> {
  const response = await ask(world, headers, prefix);
  expect(response.status, prefix).toBe(200);
  return ((await response.json()) as { suggestions: Suggestion[] }).suggestions;
}

async function created(world: World, as: Person, title: string, slug: string, forwarding?: boolean): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, asPerson(as), { url: `https://example.com/${encodeURIComponent(title)}`, title, slug, ...(forwarding === undefined ? {} : { forwarding }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function archive(bookmarkId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${bookmarkId}`;
  });
}

/** A workspace of an owner and a member, and one of a stranger. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: member, role: "member" },
  ]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

describe("GET /go/suggest", () => {
  it(
    "answers the caller's own forwarding slugs that start with the prefix, in the order of their slugs, with what the palette shows of each and no address",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await created(world, owner, "Mail", "mail");
      const notes = await created(world, owner, "Notes", "m-notes");
      await created(world, owner, "Calendar", "calendar");

      const body = await (await ask(world, asPerson(owner), "M")).json();

      expect(body).toEqual({
        suggestions: [
          { slug: "m-notes", bookmarkId: notes, title: "Notes", host: "example.com", owner: null, sharedVia: null },
          { slug: "mail", bookmarkId: mail, title: "Mail", host: "example.com", owner: null, sharedVia: null },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("https://");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers at most ten, and an empty list for an empty prefix, a blank one, one longer than a slug and one with a NUL in it",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      for (let n = 0; n < 12; n += 1) {
        await created(world, owner, `Many ${String(n)}`, `many-${String(n).padStart(2, "0")}`);
      }

      expect((await suggestions(world, asPerson(owner), "many")).map((entry) => entry.slug)).toEqual(Array.from({ length: 10 }, (_, n) => `many-${String(n).padStart(2, "0")}`));
      for (const prefix of ["", "   ", "m".repeat(65), "ma\u0000ny", "-", "ä"]) {
        expect(await suggestions(world, asPerson(owner), prefix), JSON.stringify(prefix)).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not take `%`, `_` or a backslash for what it is in a pattern: such a prefix suggests nothing, though the workspace has slugs",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      await created(world, owner, "Mail", "mail");
      await created(world, owner, "Mbox", "mbox");

      for (const prefix of ["%", "_", "\\", "m%", "ma_l", "m_", "%ail", "ma\\", "\\m", "\\mail"]) {
        expect(await suggestions(world, asPerson(owner), prefix), prefix).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never suggests the slug of another workspace, of another member's private bookmark, of a bookmark that does not forward or of a plan-archived one (T1, T2, T12)",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      const mine = await created(world, owner, "Mine", "go-mine");
      await created(world, owner, "Paused", "go-paused", false);
      const archived = await created(world, owner, "Archived", "go-archived");
      await archive(archived);
      await created(world, member, "Theirs", "go-theirs");
      await created(world, stranger, "Strangers", "go-strangers");

      for (const prefix of ["g", "go", "go-", "go-t", "go-s", "go-p", "go-a"]) {
        const found = await suggestions(world, asPerson(owner), prefix);
        expect(found.filter((entry) => entry.bookmarkId !== mine), prefix).toEqual([]);
      }
      expect((await suggestions(world, asPerson(owner), "go")).map((entry) => entry.bookmarkId)).toEqual([mine]);
      expect((await suggestions(world, asPerson(member), "go")).map((entry) => entry.slug)).toEqual(["go-theirs"]);
      expect((await suggestions(world, asPerson(stranger), "go")).map((entry) => entry.slug)).toEqual(["go-strangers"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "suggests exactly the slugs that POST /go/resolve names for the caller: one that resolves to none is never suggested",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      const slugs = ["rs-mine", "rs-paused", "rs-archived", "rs-theirs", "rs-strangers"];
      await created(world, owner, "Mine", "rs-mine");
      await created(world, owner, "Paused", "rs-paused", false);
      await archive(await created(world, owner, "Archived", "rs-archived"));
      await created(world, member, "Theirs", "rs-theirs");
      await created(world, stranger, "Strangers", "rs-strangers");

      const resolved: string[] = [];
      for (const slug of slugs) {
        const response = await send(world, "POST", RESOLVE, asPerson(owner), { slug });
        expect(response.status).toBe(200);
        if (((await response.json()) as { result: string }).result !== "none") {
          resolved.push(slug);
        }
      }

      expect(resolved).toEqual(["rs-mine"]);
      expect((await suggestions(world, asPerson(owner), "rs")).map((entry) => entry.slug)).toEqual(resolved);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a missing prefix, an over-long one and a parameter it does not declare with 422",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      for (const query of ["", "prefix=" + "a".repeat(101), "prefix=a&limit=5", "q=a"]) {
        const response = await send(world, "GET", `${SUGGEST}?${query}`, asPerson(owner));
        expect(response.status, query).toBe(422);
        expect(response.headers.get("content-type"), query).toContain("application/problem+json");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes a session or a token of the read scope, and none without credentials; a token suggests from its own workspace only",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const here = await created(world, owner, "Payroll here", "payroll");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
      await harness.workspaceOf([{ person: owner, role: "owner" }]);
      await created(world, owner, "Payroll elsewhere", "payroll-elsewhere");

      expect((await ask(world, {}, "pay")).status).toBe(401);
      for (const token of [readOnly, readWrite]) {
        expect((await suggestions(world, bearer(token), "pay")).map((entry) => entry.bookmarkId)).toEqual([here]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
