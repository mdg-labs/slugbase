import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/search (doc 04 section 10.8, doc 02 section 9.1, Q49, doc 10 T1 and T2), through the whole chain over the migrated database. The failure scenario: a query made of
// tsquery operators and LIKE wildcards answers 200 with sane results, and a member never gets back another member's private bookmark, folder or tag, a plan-archived bookmark or a row
// of another workspace, however the query is written.

const TEST_TIMEOUT_MS = 60_000;
const SEARCH = "/api/v1/search";
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Results {
  readonly bookmarks: readonly { id: string; title: string; url: string; host: string; slug: string | null; forwarding: boolean; pinned: boolean }[];
  readonly folders: readonly { id: string; name: string; icon: string; color: number }[];
  readonly tags: readonly { id: string; name: string }[];
}

const find = (world: World, headers: Record<string, string>, query: string) => send(world, "GET", `${SEARCH}?${query}`, headers);
const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });
const text = (q: string, more = ""): string => `q=${encodeURIComponent(q)}${more === "" ? "" : `&${more}`}`;

async function results(world: World, headers: Record<string, string>, query: string): Promise<Results> {
  const response = await find(world, headers, query);
  expect(response.status, query).toBe(200);
  return (await response.json()) as Results;
}

async function bookmark(world: World, as: Person, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, asPerson(as), { url: `https://example.com/${encodeURIComponent(title)}`, title, ...extra });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function folder(world: World, as: Person, name: string): Promise<string> {
  const response = await send(world, "POST", FOLDERS, asPerson(as), { name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function tag(world: World, as: Person, name: string): Promise<string> {
  const response = await send(world, "POST", TAGS, asPerson(as), { name });
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

describe("GET /search", () => {
  it(
    "answers the caller's bookmarks, folders and tags that match, grouped, with what the palette shows of each",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await bookmark(world, owner, "Fastmail inbox", { slug: "mail", forwarding: true });
      await bookmark(world, owner, "Garden notes");
      const mailFolder = await folder(world, owner, "Mail");
      await folder(world, owner, "Garden");
      const mailTag = await tag(world, owner, "mail-later");

      const found = await results(world, asPerson(owner), text("mail"));

      expect(found.bookmarks).toEqual([{ id: mail, title: "Fastmail inbox", url: "https://example.com/Fastmail%20inbox", host: "example.com", slug: "mail", forwarding: true, pinned: false }]);
      expect(found.folders).toEqual([{ id: mailFolder, name: "Mail", icon: "folder", color: 1 }]);
      expect(found.tags).toEqual([{ id: mailTag, name: "mail-later" }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ranks an exact slug before a slug prefix, and a prefix before the words of a title",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const words = await bookmark(world, owner, "Learning git the hard way");
      const prefix = await bookmark(world, owner, "Yak farm", { slug: "github" });
      const exact = await bookmark(world, owner, "Zebra notes", { slug: "git" });

      const found = await results(world, asPerson(owner), text("git"));

      expect(found.bookmarks.map((hit) => hit.id)).toEqual([exact, prefix, words]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers at most 8 bookmarks, 4 folders and 4 tags, or `limit` of each (at most 20), and only the types asked for",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      for (let n = 0; n < 22; n += 1) {
        await bookmark(world, owner, `Report ${String(n)}`);
      }
      for (let n = 0; n < 6; n += 1) {
        await folder(world, owner, `Report folder ${String(n)}`);
        await tag(world, owner, `report-tag-${String(n)}`);
      }

      const byDefault = await results(world, asPerson(owner), text("report"));
      expect([byDefault.bookmarks.length, byDefault.folders.length, byDefault.tags.length]).toEqual([8, 4, 4]);
      const limited = await results(world, asPerson(owner), text("report", "limit=5"));
      expect([limited.bookmarks.length, limited.folders.length, limited.tags.length]).toEqual([5, 5, 5]);
      const widest = await results(world, asPerson(owner), text("report", "limit=20"));
      expect([widest.bookmarks.length, widest.folders.length, widest.tags.length]).toEqual([20, 6, 6]);
      const tagsOnly = await results(world, asPerson(owner), text("report", "types=tag"));
      expect([tagsOnly.bookmarks.length, tagsOnly.folders.length, tagsOnly.tags.length]).toEqual([0, 0, 4]);
      const two = await results(world, asPerson(owner), text("report", "types=folder,bookmark&limit=2"));
      expect([two.bookmarks.length, two.folders.length, two.tags.length]).toEqual([2, 2, 0]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a missing, blank or over-long q, a types list with another word in it, a limit outside 1 to 20 and a parameter it does not declare, all with 422",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      for (const query of ["", "q=", "q=%20%20", `q=${"a".repeat(101)}`, text("x", "types=team"), text("x", "types="), text("x", "types=bookmark,"), text("x", "limit=0"), text("x", "limit=21"), text("x", "limit=abc"), text("x", "sort=name")]) {
        const response = await find(world, asPerson(owner), query);
        expect(response.status, query).toBe(422);
        expect(response.headers.get("content-type"), query).toContain("application/problem+json");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 200 with sane results for a query made of tsquery operators, LIKE wildcards, quotes and backslashes, and for one with a NUL in it",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const alpha = await bookmark(world, owner, "Alpha");
      await bookmark(world, owner, "Beta");
      const percent = await bookmark(world, owner, "100% pure");
      await folder(world, owner, "50% off");
      await folder(world, owner, "Fifty off");
      await tag(world, owner, "a_b");
      await tag(world, owner, "axb");

      for (const q of ["alpha & beta", "alpha | beta", "!alpha", "alpha:*", "(alpha)", "alpha <-> beta", "'", '"', "'alpha", 'alpha"', "'; DROP TABLE bookmarks; --", "\\", "a\\", "%", "_", "%%%", "&", "|", "!", ":*", "((", "))", "\u0000", "alpha\u0000beta"]) {
        const response = await find(world, asPerson(owner), text(q));
        expect(response.status, JSON.stringify(q)).toBe(200);
        const body = (await response.json()) as Results;
        expect(Object.keys(body), JSON.stringify(q)).toEqual(["bookmarks", "folders", "tags"]);
      }
      // The wildcards and the operators mean nothing: the bookmark that holds the text is found, and `%` or `_` alone match only the names that hold the character, not everything.
      expect((await results(world, asPerson(owner), text("!alpha"))).bookmarks.map((hit) => hit.id)).toEqual([alpha]);
      expect((await results(world, asPerson(owner), text("alpha:*"))).bookmarks.map((hit) => hit.id)).toEqual([alpha]);
      expect((await results(world, asPerson(owner), text("100%"))).bookmarks.map((hit) => hit.id)).toEqual([percent]);
      expect(await results(world, asPerson(owner), text("%"))).toMatchObject({ bookmarks: [], folders: [{ name: "50% off" }], tags: [] });
      expect(await results(world, asPerson(owner), text("_"))).toMatchObject({ bookmarks: [], folders: [], tags: [{ name: "a_b" }] });
      expect(await results(world, asPerson(owner), text("%%%"))).toEqual({ bookmarks: [], folders: [], tags: [] });
      expect((await results(world, asPerson(owner), text("50%"))).folders.map((entry) => entry.name)).toEqual(["50% off"]);
      expect((await results(world, asPerson(owner), text("a_b"))).tags.map((entry) => entry.name)).toEqual(["a_b"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never names another member's private bookmark, folder or tag, a plan-archived bookmark, or anything of another workspace (T1, T2)",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      const mine = await bookmark(world, owner, "Secret plans of mine", { slug: "secret-mine" });
      const archived = await bookmark(world, owner, "Secret plans archived", { slug: "secret-archived" });
      await archive(archived);
      await bookmark(world, member, "Secret plans of the member", { slug: "secret-theirs" });
      await folder(world, member, "Secret folder of the member");
      await tag(world, member, "secret-tag-of-the-member");
      await bookmark(world, stranger, "Secret plans of a stranger", { slug: "secret-stranger" });
      await folder(world, stranger, "Secret folder of a stranger");
      await tag(world, stranger, "secret-tag-of-a-stranger");

      for (const q of ["secret", "secret-theirs", "secret plans", "secret-stranger", "secre", "sec", "se", "plans", "scret", "member", "stranger", "secret & member", "secret | stranger"]) {
        const found = await results(world, asPerson(owner), text(q));
        expect(found.bookmarks.filter((hit) => hit.id !== mine), q).toEqual([]);
        expect(found.folders, q).toEqual([]);
        expect(found.tags, q).toEqual([]);
      }
      // Each member sees their own, and the stranger's workspace its own.
      const theirs = await results(world, asPerson(member), text("secret"));
      expect(theirs.bookmarks.map((hit) => hit.title)).toEqual(["Secret plans of the member"]);
      expect(theirs.folders.map((entry) => entry.name)).toEqual(["Secret folder of the member"]);
      expect(theirs.tags.map((entry) => entry.name)).toEqual(["secret-tag-of-the-member"]);
      const strangers = await results(world, asPerson(stranger), text("secret"));
      expect(strangers.bookmarks.map((hit) => hit.title)).toEqual(["Secret plans of a stranger"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes a session or a token of the read scope, and none without credentials; a token searches its own workspace only",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const here = await bookmark(world, owner, "Payroll here");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
      const elsewhere = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      await bookmark(world, owner, "Payroll elsewhere");

      expect((await find(world, {}, text("payroll"))).status).toBe(401);
      for (const token of [readOnly, readWrite]) {
        const found = await results(world, bearer(token), text("payroll"));
        expect(found.bookmarks.map((hit) => hit.id)).toEqual([here]);
      }
      expect(elsewhere.workspaceId).not.toBe(shared.workspaceId);
    },
    TEST_TIMEOUT_MS,
  );
});
