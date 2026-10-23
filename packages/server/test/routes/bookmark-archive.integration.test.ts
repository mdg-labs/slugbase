import { archiveBookmarks, restoreBookmarks } from "@slugbase/core";
import { bookmarkArchiveTransaction } from "@slugbase/db";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import type { ModuleContext, ServerModule } from "../../src/create-server.ts";
import { defineJob } from "../../src/worker/index.ts";
import { tenantDatabase } from "../contract/support.ts";
import { moduleContext } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The archive services of doc 01 section 13.3 called by the module job of a fixture composition, through the whole chain over the
// migrated database (doc 02 section 5.6, doc 05 section 2.2, doc 10 T1, T2 and T11). CE never calls them, so the composition here
// stands for one that limits the bookmarks of a plan: it lowers `bookmarks.max`, picks the bookmarks above it in its own rule and
// hands them to `archiveBookmarks` from a job. The failure scenarios: an archived bookmark that is still read, changed or counted;
// a counter that stays above the number of bookmarks that are not archived and refuses creations for bookmarks nobody sees; an
// entitlement set cached under the version from before the archive; a bookmark that its owner cannot delete once archived, or whose
// deletion lowers a counter that never counted it; and a job that runs again and counts a bookmark twice.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const ENTITLEMENTS = "/api/v1/entitlements";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const payload = z.object({ workspaceId: z.string(), accountId: z.string(), bookmarkIds: z.string() });

/** The fixture composition's jobs: the archive services of CE behind a payload of scalars, each in the tenant transaction the job opens. */
const archiveOverflow = defineJob({
  name: "fixture.archiveOverflow",
  payload,
  handle: (data, context) =>
    context.withTenant({ accountId: data.accountId, workspaceId: data.workspaceId, requestId: "fixture-archive" }, async (tx) => {
      await archiveBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId: data.workspaceId, bookmarkIds: data.bookmarkIds.split(",") });
    }),
});

const restoreOverflow = defineJob({
  name: "fixture.restoreOverflow",
  payload,
  handle: (data, context) =>
    context.withTenant({ accountId: data.accountId, workspaceId: data.workspaceId, requestId: "fixture-restore" }, async (tx) => {
      await restoreBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId: data.workspaceId, bookmarkIds: data.bookmarkIds.split(",") });
    }),
});

export const fixtureModule: ServerModule = { name: "fixture-plan", register: () => ({ jobs: [archiveOverflow, restoreOverflow] }) };

/** What the worker hands a job: the module context over the real tenant database. */
function jobContext(): ModuleContext {
  return { ...moduleContext(), withTenant: (context, fn) => tenantDatabase(database()).withTenant(context, fn) };
}

interface Bookmark {
  readonly id: string;
}

const create = (world: World, as: Person, title: string) => send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title });
const read = (world: World, as: Person, id: string) => send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie });
const patch = (world: World, as: Person, id: string, body: unknown) => send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: as.cookie }, body);
const remove = (world: World, as: Person, id: string) => send(world, "DELETE", `${BOOKMARKS}/${id}`, { cookie: as.cookie });

async function created(world: World, as: Person, title: string): Promise<string> {
  const response = await create(world, as, title);
  expect(response.status).toBe(201);
  return ((await response.json()) as Bookmark).id;
}

interface Entitlements {
  readonly entitlements: Record<string, unknown>;
  readonly usage: Record<string, number>;
}

async function entitlementsOf(world: World, as: Person): Promise<Entitlements> {
  const response = await send(world, "GET", ENTITLEMENTS, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as Entitlements;
}

interface Stored {
  readonly rows: number;
  readonly archived: number;
  readonly counter: number;
  readonly version: number;
}

async function stored(workspaceId: string): Promise<Stored> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Stored[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows,
             (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId} AND plan_archived_at IS NOT NULL)::int AS archived,
             bookmark_count AS counter, entitlement_version AS version
      FROM workspaces WHERE id = ${workspaceId}`;
  });
  const [row] = rows;
  if (row === undefined) {
    throw new Error("no such workspace");
  }
  return row;
}

/** The owner and a member of a shared workspace, and a stranger with a workspace of their own. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

describe("a fixture composition that archives bookmarks above a limit", () => {
  it(
    "takes them out of the product's reads, counts and entitlement while they stay stored, lets their owner delete them, and restores them",
    async () => {
      const source = new LimitedEntitlementSource();
      const world = harness.serve({ entitlementSource: source, modules: [fixtureModule] });
      const { owner, member, stranger, shared, other } = await setup(world);
      const kept = [await created(world, owner, "o1"), await created(world, owner, "o2"), await created(world, member, "m1")];
      const ownersOverflow = await created(world, owner, "o3");
      const membersOverflow = await created(world, member, "m2");
      const strangers = await created(world, stranger, "s1");
      const strangersWorkspace = await stored(other.workspaceId);
      expect(await stored(shared.workspaceId)).toMatchObject({ rows: 5, archived: 0, counter: 5 });
      expect((await entitlementsOf(world, owner)).usage["bookmarks.used"]).toBe(5);

      // The plan changes to three bookmarks. Until the version moves, the engine serves the set it cached for the old one.
      source.grant("bookmarks.max", 3);
      expect((await entitlementsOf(world, owner)).entitlements["bookmarks.max"]).toBe("unlimited");
      const before = await stored(shared.workspaceId);
      await archiveOverflow.handle(
        { workspaceId: shared.workspaceId, accountId: owner.account.id, bookmarkIds: [ownersOverflow, membersOverflow, strangers].join(",") },
        jobContext(),
      );

      // The rows are there, flagged; the counter, the version and the audit log moved once each.
      expect(await stored(shared.workspaceId)).toEqual({ rows: 5, archived: 2, counter: 3, version: before.version + 1 });
      expect(await stored(other.workspaceId)).toEqual(strangersWorkspace);
      expect(await harness.auditActions(shared.workspaceId)).toEqual(["bookmark.archived"]);
      expect(await harness.auditActions(other.workspaceId)).toEqual([]);
      const events = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ metadata: unknown; row: string }[]>`SELECT metadata, audit_events::text AS row FROM audit_events WHERE workspace_id = ${shared.workspaceId}`;
      });
      expect(events.map((event) => event.metadata)).toEqual([{ count: "2" }]);
      expect(events[0]?.row).not.toContain("example.com");

      // The entitlement engine counts only what is not archived, and the cache did not outlive the version it was cached under.
      const entitlements = await entitlementsOf(world, owner);
      expect(entitlements.usage["bookmarks.used"]).toBe(3);
      expect(entitlements.entitlements["bookmarks.max"]).toBe(3);

      // The reads and the change of an archived bookmark are the same 404 as for a bookmark that is not there; the others are as before.
      for (const id of [ownersOverflow, membersOverflow]) {
        expect((await read(world, owner, id)).status).toBe(404);
        expect((await patch(world, owner, id, { title: "Edited" })).status).toBe(404);
      }
      expect((await read(world, owner, kept[0] ?? "")).status).toBe(200);
      expect((await read(world, owner, kept[1] ?? "")).status).toBe(200);
      expect((await read(world, member, kept[2] ?? "")).status).toBe(200);

      // The places the archived bookmarks held are not free: the workspace is at its limit of three.
      const refused = await create(world, owner, "one too many");
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: "bookmark_limit_reached", limit: 3, used: 3 });

      // A job that runs again changes no bookmark and no count.
      await archiveOverflow.handle({ workspaceId: shared.workspaceId, accountId: owner.account.id, bookmarkIds: [ownersOverflow, membersOverflow].join(",") }, jobContext());
      expect(await stored(shared.workspaceId)).toMatchObject({ rows: 5, archived: 2, counter: 3 });
      expect((await entitlementsOf(world, owner)).usage["bookmarks.used"]).toBe(3);

      // Only the owner deletes an archived bookmark, and the counter, which never counted it, stays.
      expect((await remove(world, owner, membersOverflow)).status).toBe(404);
      expect((await remove(world, owner, ownersOverflow)).status).toBe(204);
      expect(await stored(shared.workspaceId)).toMatchObject({ rows: 4, archived: 1, counter: 3 });
      expect((await remove(world, member, membersOverflow)).status).toBe(204);
      expect(await stored(shared.workspaceId)).toMatchObject({ rows: 3, archived: 0, counter: 3 });
      expect((await entitlementsOf(world, owner)).usage["bookmarks.used"]).toBe(3);
      expect((await create(world, owner, "still full")).status).toBe(422);

      // Deleting a bookmark that is not archived gives its place back; restoring brings a bookmark back and counts it again.
      expect((await remove(world, owner, kept[0] ?? "")).status).toBe(204);
      const extra = await created(world, owner, "extra");
      await archiveOverflow.handle({ workspaceId: shared.workspaceId, accountId: owner.account.id, bookmarkIds: extra }, jobContext());
      expect((await read(world, owner, extra)).status).toBe(404);
      await restoreOverflow.handle({ workspaceId: shared.workspaceId, accountId: owner.account.id, bookmarkIds: extra }, jobContext());
      expect((await read(world, owner, extra)).status).toBe(200);
      expect(await stored(shared.workspaceId)).toMatchObject({ rows: 3, archived: 0, counter: 3 });
      expect((await entitlementsOf(world, owner)).usage["bookmarks.used"]).toBe(3);
      expect(await harness.auditActions(shared.workspaceId)).toEqual(["bookmark.archived", "bookmark.archived", "bookmark.archived", "bookmark.restored"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves the other workspaces alone when the job names bookmarks of a workspace it does not act in, and fails the job",
    async () => {
      const world = harness.serve({ entitlementSource: new LimitedEntitlementSource(), modules: [fixtureModule] });
      const { owner, stranger, shared, other } = await setup(world);
      const ours = await created(world, owner, "ours");
      const theirs = await created(world, stranger, "theirs");
      const before = [await stored(shared.workspaceId), await stored(other.workspaceId)];

      await expect(archiveOverflow.handle({ workspaceId: other.workspaceId, accountId: owner.account.id, bookmarkIds: [ours, theirs].join(",") }, jobContext())).rejects.toThrow();
      await archiveOverflow.handle({ workspaceId: shared.workspaceId, accountId: owner.account.id, bookmarkIds: theirs }, jobContext());

      expect(await stored(other.workspaceId)).toEqual(before[1]);
      expect(await stored(shared.workspaceId)).toMatchObject({ archived: 0, counter: before[0]?.counter });
      expect((await read(world, stranger, theirs)).status).toBe(200);
      expect(await harness.auditActions(other.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
