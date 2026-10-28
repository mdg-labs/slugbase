import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/dashboard (doc 04 section 10.8, doc 02 section 9.3, doc 10 T1 and T2), through the whole chain over the migrated database. The failure scenario: another member's pinned bookmark,
// quick-access slug or tag is never in a member's dashboard, its counts never include another member's rows, a plan-archived bookmark or another workspace, and an API token cannot read it.

const TEST_TIMEOUT_MS = 60_000;
const DASHBOARD = "/api/v1/dashboard";
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const ME = "/api/v1/me";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface DashboardBody {
  readonly counts: { bookmarks: number; folders: number; tags: number; sharedWithYou: number | null };
  readonly quickAccess: readonly { id: string; title: string; url: string; host: string; slug: string | null; forwarding: boolean; openCount: number }[];
  readonly pinned: readonly { id: string; title: string; url: string; host: string; slug: string | null; forwarding: boolean; openCount: number }[];
  readonly topTags: readonly { id: string; name: string; bookmarkCount: number }[];
  readonly sharing: unknown;
  readonly onboarding: Record<string, boolean>;
}

const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });

async function dashboardOf(world: World, as: Person): Promise<DashboardBody> {
  const response = await send(world, "GET", DASHBOARD, asPerson(as));
  expect(response.status).toBe(200);
  return (await response.json()) as DashboardBody;
}

async function create(world: World, as: Person, path: string, body: Record<string, unknown>): Promise<string> {
  const response = await send(world, "POST", path, asPerson(as), body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const bookmark = (world: World, as: Person, title: string, extra: Record<string, unknown> = {}) =>
  create(world, as, BOOKMARKS, { url: `https://example.com/${encodeURIComponent(title)}`, title, ...extra });

async function archive(bookmarkId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${bookmarkId}`;
  });
}

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

describe("GET /dashboard", () => {
  it(
    "answers the caller's counts, quick access, pinned bookmarks, top tags, sharing block and checklist in one read",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const mail = await bookmark(world, owner, "Fastmail inbox", { slug: "mail", forwarding: true, pinned: true });
      await bookmark(world, owner, "Garden notes");
      const work = await create(world, owner, FOLDERS, { name: "Work" });
      const later = await create(world, owner, TAGS, { name: "later" });
      await create(world, owner, TAGS, { name: "unused" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${mail}`, asPerson(owner), { tagIds: [later], folderIds: [work] })).status).toBe(200);

      const answer = await dashboardOf(world, owner);

      expect(answer).toEqual({
        counts: { bookmarks: 2, folders: 1, tags: 2, sharedWithYou: null },
        quickAccess: [{ id: mail, title: "Fastmail inbox", url: "https://example.com/Fastmail%20inbox", host: "example.com", slug: "mail", forwarding: true, openCount: 0 }],
        pinned: [{ id: mail, title: "Fastmail inbox", url: "https://example.com/Fastmail%20inbox", host: "example.com", slug: "mail", forwarding: true, openCount: 0 }],
        topTags: [
          { id: later, name: "later", bookmarkCount: 1 },
          { id: expect.any(String) as string, name: "unused", bookmarkCount: 0 },
        ],
        sharing: null,
        onboarding: { bookmarkAdded: true, slugGiven: true, browserSetupDone: false, folderCreated: true, importDone: false, dismissed: false },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is empty for a member with nothing, and the checklist is unticked",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      expect(await dashboardOf(world, owner)).toEqual({
        counts: { bookmarks: 0, folders: 0, tags: 0, sharedWithYou: null },
        quickAccess: [],
        pinned: [],
        topTags: [],
        sharing: null,
        onboarding: { bookmarkAdded: false, slugGiven: false, browserSetupDone: false, folderCreated: false, importDone: false, dismissed: false },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads the checklist keys that PATCH /me stores, and keeps the three derived items out of that state",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);

      const changed = await send(world, "PATCH", ME, asPerson(owner), { onboarding: { browserSetupDone: true, importDone: true, checklistDismissed: true } });
      expect(changed.status).toBe(200);
      expect((await dashboardOf(world, owner)).onboarding).toEqual({ bookmarkAdded: false, slugGiven: false, browserSetupDone: true, folderCreated: false, importDone: true, dismissed: true });
      // The derived items are not keys of the stored state: a request that names one is refused and nothing changes.
      const refused = await send(world, "PATCH", ME, asPerson(owner), { onboarding: { bookmarkAdded: true } });
      expect(refused.status).toBe(422);
      expect((await dashboardOf(world, owner)).onboarding.bookmarkAdded).toBe(false);
      const restored = await send(world, "PATCH", ME, asPerson(owner), { onboarding: { checklistDismissed: false } });
      expect(restored.status).toBe(200);
      expect((await dashboardOf(world, owner)).onboarding).toMatchObject({ browserSetupDone: true, importDone: true, dismissed: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "holds at most 8 slugs in the quick access, the most opened first, 12 pinned bookmarks, the newest pin first, and 12 tags",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const ids: string[] = [];
      for (let n = 0; n < 14; n += 1) {
        ids.push(await bookmark(world, owner, `Link ${String(n)}`, { slug: `link-${String(n)}`, forwarding: true, pinned: true }));
        await create(world, owner, TAGS, { name: `tag-${String(n).padStart(2, "0")}` });
      }
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        for (const [index, id] of ids.entries()) {
          await tx`UPDATE bookmarks SET open_count = ${index}, pinned_at = now() - ${14 - index} * interval '1 minute' WHERE id = ${id}`;
        }
      });

      const answer = await dashboardOf(world, owner);

      expect(answer.quickAccess.map((entry) => entry.id)).toEqual(ids.slice(6).reverse());
      expect(answer.pinned.map((entry) => entry.id)).toEqual(ids.slice(2).reverse());
      expect(answer.topTags).toHaveLength(12);
      expect(answer.counts).toMatchObject({ bookmarks: 14, tags: 14 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves a plan-archived bookmark out of the counts, the quick access and the pinned bookmarks, and out of the count of a tag",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      const live = await bookmark(world, owner, "Live", { slug: "live", forwarding: true, pinned: true });
      const archived = await bookmark(world, owner, "Archived", { slug: "archived", forwarding: true, pinned: true });
      const tag = await create(world, owner, TAGS, { name: "both" });
      for (const id of [live, archived]) {
        expect((await send(world, "PATCH", `${BOOKMARKS}/${id}`, asPerson(owner), { tagIds: [tag] })).status).toBe(200);
      }
      await archive(archived);

      const answer = await dashboardOf(world, owner);

      expect(answer.counts.bookmarks).toBe(1);
      expect(answer.quickAccess.map((entry) => entry.id)).toEqual([live]);
      expect(answer.pinned.map((entry) => entry.id)).toEqual([live]);
      expect(answer.topTags).toEqual([{ id: tag, name: "both", bookmarkCount: 1 }]);
      expect(answer.onboarding).toMatchObject({ bookmarkAdded: true, slugGiven: true });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never names another member's pinned bookmark, quick-access slug, folder or tag, nor counts another member's rows or another workspace's (T1, T2)",
    async () => {
      const world = harness.serve();
      const { owner, member, stranger } = await setup(world);
      await bookmark(world, owner, "Mine", { slug: "mine", forwarding: true, pinned: true });
      const theirs = await bookmark(world, member, "Secret of the member", { slug: "secret-member", forwarding: true, pinned: true });
      const theirTag = await create(world, member, TAGS, { name: "secret-tag-of-the-member" });
      await create(world, member, FOLDERS, { name: "Secret folder of the member" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${theirs}`, asPerson(member), { tagIds: [theirTag] })).status).toBe(200);
      const strangers = await bookmark(world, stranger, "Secret of a stranger", { slug: "secret-stranger", forwarding: true, pinned: true });
      const strangerTag = await create(world, stranger, TAGS, { name: "secret-tag-of-a-stranger" });
      await create(world, stranger, FOLDERS, { name: "Secret folder of a stranger" });
      expect((await send(world, "PATCH", `${BOOKMARKS}/${strangers}`, asPerson(stranger), { tagIds: [strangerTag] })).status).toBe(200);

      const mine = await dashboardOf(world, owner);

      expect(mine.counts).toEqual({ bookmarks: 1, folders: 0, tags: 0, sharedWithYou: null });
      expect(mine.quickAccess.map((entry) => entry.title)).toEqual(["Mine"]);
      expect(mine.pinned.map((entry) => entry.title)).toEqual(["Mine"]);
      expect(mine.topTags).toEqual([]);
      expect(JSON.stringify(mine)).not.toMatch(/secret/i);
      const theirsAnswer = await dashboardOf(world, member);
      expect(theirsAnswer.counts).toEqual({ bookmarks: 1, folders: 1, tags: 1, sharedWithYou: null });
      expect(theirsAnswer.pinned.map((entry) => entry.title)).toEqual(["Secret of the member"]);
      expect(JSON.stringify(theirsAnswer)).not.toMatch(/stranger/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "counts the rows of the workspace the session acts in and none of the same account's other workspace",
    async () => {
      const world = harness.serve();
      const { owner } = await setup(world);
      await bookmark(world, owner, "Here", { slug: "here", forwarding: true, pinned: true });
      await create(world, owner, FOLDERS, { name: "Here" });
      await create(world, owner, TAGS, { name: "here" });
      expect((await dashboardOf(world, owner)).counts).toEqual({ bookmarks: 1, folders: 1, tags: 1, sharedWithYou: null });

      // The owner's sessions now act in a second workspace, where the owner has nothing.
      await harness.workspaceOf([{ person: owner, role: "owner" }]);

      expect(await dashboardOf(world, owner)).toMatchObject({
        counts: { bookmarks: 0, folders: 0, tags: 0 },
        quickAccess: [],
        pinned: [],
        topTags: [],
        onboarding: { bookmarkAdded: false, slugGiven: false, folderCreated: false },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an API token, whatever its scope, and a request without credentials",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

      expect((await send(world, "GET", DASHBOARD, {})).status).toBe(401);
      for (const token of [readOnly, readWrite]) {
        const response = await send(world, "GET", DASHBOARD, bearer(token));
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 to an account that is in no workspace",
    async () => {
      const world = harness.serve();
      const loner = await harness.person(world);

      const response = await send(world, "GET", DASHBOARD, asPerson(loner));

      expect(response.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});
