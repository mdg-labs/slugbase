import { PortUnavailable, type AccountEntitlementValues, type EntitlementSource } from "@slugbase/core";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queuedJobCount } from "../invitations/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// T11 at the creation of a bookmark (doc 01 section 7.5, doc 02 section 5, doc 04 sections 3.2 and 10.6, doc 05 section 2.2, doc
// 10 T11), through the whole chain over the migrated database: `createBookmark` answers 422 bookmark_limit_reached at the workspace's
// `bookmarks.max` with the limit and the usage and writes nothing, the counter of the workspace is the number of its bookmarks, two
// creations at the limit minus one make one, and a source that cannot say what the ceiling is refuses the creation. The community
// edition's source never refuses. The handler decides this entitlement, not stage 9: a ceiling of zero is a limit reached, not a missing
// feature.

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

const ceiling = (value: number | "unlimited", upgrade = false): LimitedEntitlementSource => {
  const source = new LimitedEntitlementSource().grant("bookmarks.max", value);
  return upgrade ? source.offerUpgrade(true) : source;
};

const create = (world: World, as: Person, title: string) => send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title });

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly limit?: unknown;
  readonly used?: unknown;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

interface Written {
  readonly rows: number;
  readonly counter: number;
  readonly jobs: number;
}

async function written(workspaceId: string): Promise<Written> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ rows: number; counter: number }[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows, (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter`;
  });
  return { rows: rows[0]?.rows ?? -1, counter: rows[0]?.counter ?? -1, jobs: await queuedJobCount(database(), CREATED_JOB) };
}

/** A change of plan: the source answers another value and the version of the workspace moves, as `withEntitlementChange` moves it (doc 01 section 7.5). */
async function changePlan(source: LimitedEntitlementSource, workspaceId: string, value: number): Promise<void> {
  source.grant("bookmarks.max", value);
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = ${workspaceId}`;
  });
}

async function ownerAndWorkspace(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const workspace = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  return { owner, member, workspaceId: workspace.workspaceId };
}

describe("createBookmark at bookmarks.max", () => {
  it(
    "creates up to the limit and then answers 422 bookmark_limit_reached with the limit and the usage, writing, counting and announcing nothing",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling(2) });
      const { owner, workspaceId } = await ownerAndWorkspace(world);

      expect((await create(world, owner, "first")).status).toBe(201);
      expect((await create(world, owner, "second")).status).toBe(201);
      const before = await written(workspaceId);
      const refused = await create(world, owner, "third");

      expect(before).toEqual({ rows: 2, counter: 2, jobs: 2 });
      expect(refused.status).toBe(422);
      expect(await problemOf(refused)).toMatchObject({ code: "bookmark_limit_reached", status: 422, limit: 2, used: 2 });
      expect(await written(workspaceId)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "counts the bookmarks of every member against the workspace's limit",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling(2) });
      const { owner, member, workspaceId } = await ownerAndWorkspace(world);

      expect((await create(world, owner, "owner's")).status).toBe(201);
      expect((await create(world, member, "member's")).status).toBe(201);

      expect((await create(world, member, "one too many")).status).toBe(422);
      expect((await create(world, owner, "one too many")).status).toBe(422);
      expect((await written(workspaceId)).rows).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads the ceiling as the workspace's version has it: raising it lets the next creation through, and lowering it below the usage refuses with the usage",
    async () => {
      const source = ceiling(1);
      const world = harness.serve({ entitlementSource: source });
      const { owner, workspaceId } = await ownerAndWorkspace(world);
      expect((await create(world, owner, "first")).status).toBe(201);
      expect((await create(world, owner, "second")).status).toBe(422);

      await changePlan(source, workspaceId, 3);
      expect((await create(world, owner, "second")).status).toBe(201);
      expect((await create(world, owner, "third")).status).toBe(201);

      await changePlan(source, workspaceId, 1);
      const refused = await create(world, owner, "fourth");
      expect(refused.status).toBe(422);
      expect(await problemOf(refused)).toMatchObject({ code: "bookmark_limit_reached", limit: 1, used: 3 });
      expect((await written(workspaceId)).rows).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses every creation under a ceiling of zero with bookmark_limit_reached, and not with entitlement_required",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling(0) });
      const { owner, workspaceId } = await ownerAndWorkspace(world);

      const refused = await create(world, owner, "none");

      expect(refused.status).toBe(422);
      expect(await problemOf(refused)).toMatchObject({ code: "bookmark_limit_reached", limit: 0, used: 0 });
      expect(await written(workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets one of two creations at the limit minus one through, and the other is refused 422 bookmark_limit_reached (T11)",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling(3) });
      const { owner, member, workspaceId } = await ownerAndWorkspace(world);
      expect((await create(world, owner, "first")).status).toBe(201);
      expect((await create(world, owner, "second")).status).toBe(201);

      const [a, b] = await Promise.all([create(world, owner, "race a"), create(world, member, "race b")]);

      expect([a.status, b.status].sort()).toEqual([201, 422]);
      const refused = a.status === 422 ? a : b;
      expect(await problemOf(refused)).toMatchObject({ code: "bookmark_limit_reached", limit: 3, used: 3 });
      expect(await written(workspaceId)).toEqual({ rows: 3, counter: 3, jobs: 3 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the counter equal to the number of bookmarks over a burst of creations at the limit",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling(5) });
      const { owner, member, workspaceId } = await ownerAndWorkspace(world);

      const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => create(world, index % 2 === 0 ? owner : member, `burst ${String(index)}`)));

      expect(answers.filter((answer) => answer.status === 201)).toHaveLength(5);
      expect(answers.filter((answer) => answer.status === 422)).toHaveLength(7);
      expect(await written(workspaceId)).toEqual({ rows: 5, counter: 5, jobs: 5 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never refuses under the unlimited ceiling the community edition's source grants",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling("unlimited") });
      const { owner, workspaceId } = await ownerAndWorkspace(world);

      for (const title of ["a", "b", "c", "d"]) {
        expect((await create(world, owner, title)).status).toBe(201);
      }

      expect(await written(workspaceId)).toEqual({ rows: 4, counter: 4, jobs: 4 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 503 and writes nothing when the entitlement source cannot say how many bookmarks the workspace may hold",
    async () => {
      const source: EntitlementSource = {
        available: true,
        forWorkspace: () => Promise.reject(new PortUnavailable("entitlements", "unavailable")),
        forAccount: (): Promise<AccountEntitlementValues> => Promise.reject(new PortUnavailable("entitlements", "unavailable")),
      };
      const world = harness.serve({ entitlementSource: source });
      const { owner, workspaceId } = await ownerAndWorkspace(world);

      const refused = await create(world, owner, "unknown ceiling");

      expect(refused.status).toBe(503);
      expect(await written(workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the limit of one workspace from another's: a full workspace does not stop its owner creating in a second one",
    async () => {
      const world = harness.serve({ entitlementSource: ceiling(1) });
      const owner = await harness.person(world);
      const first = await harness.workspaceOf([{ person: owner, role: "owner" }]);
      expect((await create(world, owner, "in the first")).status).toBe(201);
      expect((await create(world, owner, "in the first again")).status).toBe(422);
      const second = await harness.workspaceOf([{ person: owner, role: "owner" }]);

      expect((await create(world, owner, "in the second")).status).toBe(201);

      expect((await written(first.workspaceId)).rows).toBe(1);
      expect((await written(second.workspaceId)).rows).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
