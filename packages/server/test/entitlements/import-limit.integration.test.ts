import { ImportResultSchema } from "@slugbase/contracts";
import { PortUnavailable, type AccountEntitlementValues, type EntitlementSource } from "@slugbase/core";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queuedJobCount } from "../invitations/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// T11 at the import of bookmarks (doc 01 section 7.5, doc 02 section 13.1, doc 04 sections 3.2 and 10.9, doc 05 section 2.2, doc 10 T11), through the whole chain over the migrated database: `importJson` takes the
// workspace's `bookmarks.max` from the entitlement source before its transaction opens and judges it against the counter under the workspace's row lock, so it creates up to the limit and reports the rest as skipped
// with `bookmark_limit_reached` (never a 422: an import has no all-or-nothing failure), the counter is raised by what was created, a ceiling of zero or a counter at the ceiling creates nothing, and a source that
// cannot say what the ceiling is refuses the request and writes nothing. The handler decides this entitlement, not stage 9.

const TEST_TIMEOUT_MS = 60_000;
const IMPORT = "/api/v1/import/json";
const CREATED_JOB = "event.bookmark.created";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const ceiling = (value: number | "unlimited"): LimitedEntitlementSource => new LimitedEntitlementSource().grant("bookmarks.max", value);

const urls = (count: number, prefix = "page") => Array.from({ length: count }, (_, index) => ({ url: `https://example.com/${prefix}/${String(index)}` }));

async function importAs(world: World, as: Person, file: unknown, path = IMPORT) {
  return send(world, "POST", path, { cookie: as.cookie }, file);
}

async function imported(world: World, as: Person, file: unknown, path = IMPORT) {
  const response = await importAs(world, as, file, path);
  expect(response.status).toBe(200);
  return ImportResultSchema.parse(await response.json());
}

interface Written {
  readonly rows: number;
  readonly counter: number;
  readonly audit: number;
  readonly jobs: number;
}

async function written(workspaceId: string): Promise<Written> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ rows: number; counter: number; audit: number }[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows, (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter,
        (SELECT count(*) FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'import.completed')::int AS audit`;
  });
  return { rows: rows[0]?.rows ?? -1, counter: rows[0]?.counter ?? -1, audit: rows[0]?.audit ?? -1, jobs: await queuedJobCount(database(), CREATED_JOB) };
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

describe("importJson at bookmarks.max", { timeout: TEST_TIMEOUT_MS }, () => {
  it("creates up to the limit and reports the rest as skipped with bookmark_limit_reached, in the order of the file", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: ceiling(3) });
    const { owner, workspaceId } = await ownerAndWorkspace(world);

    const result = await imported(world, owner, urls(5));

    expect(result.created).toBe(3);
    expect(result.skipped.map((entry) => [entry.position, entry.reason])).toEqual([
      [4, "bookmark_limit_reached"],
      [5, "bookmark_limit_reached"],
    ]);
    expect(await written(workspaceId)).toEqual({ rows: 3, counter: 3, audit: 1, jobs: 3 });
  });

  it("counts the bookmarks of every member and the bookmarks created one by one against the limit", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: ceiling(4) });
    const { owner, member, workspaceId } = await ownerAndWorkspace(world);
    expect((await send(world, "POST", "/api/v1/bookmarks", { cookie: member.cookie }, { url: "https://example.com/by-hand", title: "By hand" })).status).toBe(201);
    await imported(world, member, urls(1, "member"));

    const result = await imported(world, owner, urls(4, "owner"));
    const full = await imported(world, member, urls(2, "again"));

    expect(result.created).toBe(2);
    expect(result.skipped).toHaveLength(2);
    expect(full).toMatchObject({ created: 0 });
    expect(full.skipped.map((entry) => entry.reason)).toEqual(["bookmark_limit_reached", "bookmark_limit_reached"]);
    expect(await written(workspaceId)).toMatchObject({ rows: 4, counter: 4 });
  });

  it("creates nothing under a ceiling of zero, and nothing when the counter is already above a lowered ceiling, but still records the import", async () => {
    const source = ceiling(0);
    const world = harness.serve({ env: RELAXED, entitlementSource: source });
    const { owner, workspaceId } = await ownerAndWorkspace(world);

    const none = await imported(world, owner, urls(2));
    await changePlan(source, workspaceId, 3);
    await imported(world, owner, urls(3, "later"));
    await changePlan(source, workspaceId, 1);
    const lowered = await imported(world, owner, urls(2, "lowest"));

    expect(none).toMatchObject({ created: 0 });
    expect(none.skipped).toHaveLength(2);
    expect(lowered).toMatchObject({ created: 0 });
    expect(lowered.skipped.map((entry) => entry.reason)).toEqual(["bookmark_limit_reached", "bookmark_limit_reached"]);
    expect(await written(workspaceId)).toEqual({ rows: 3, counter: 3, audit: 3, jobs: 3 });
  });

  it("reads the ceiling as the workspace's version has it: raising it lets the next import through", async () => {
    const source = ceiling(1);
    const world = harness.serve({ env: RELAXED, entitlementSource: source });
    const { owner, workspaceId } = await ownerAndWorkspace(world);
    expect((await imported(world, owner, urls(2))).created).toBe(1);

    await changePlan(source, workspaceId, 4);

    expect((await imported(world, owner, urls(5, "more"))).created).toBe(3);
    expect(await written(workspaceId)).toMatchObject({ rows: 4, counter: 4 });
  });

  it("judges a dry run against the same ceiling and the same counter, and writes nothing", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: ceiling(2) });
    const { owner, workspaceId } = await ownerAndWorkspace(world);

    const preview = await imported(world, owner, urls(3), `${IMPORT}?dryRun=true`);
    const result = await imported(world, owner, urls(3));

    expect(preview).toEqual(result);
    expect(await written(workspaceId)).toEqual({ rows: 2, counter: 2, audit: 1, jobs: 2 });
  });

  it("never refuses under the unlimited ceiling the community edition's source grants", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: ceiling("unlimited") });
    const { owner, workspaceId } = await ownerAndWorkspace(world);

    const result = await imported(world, owner, urls(50));

    expect(result).toMatchObject({ created: 50, skipped: [] });
    expect(await written(workspaceId)).toMatchObject({ rows: 50, counter: 50 });
  });

  it("answers 503 and writes nothing when the entitlement source cannot say how many bookmarks the workspace may hold", async () => {
    const source: EntitlementSource = {
      available: true,
      forWorkspace: () => Promise.reject(new PortUnavailable("entitlements", "unavailable")),
      forAccount: (): Promise<AccountEntitlementValues> => Promise.reject(new PortUnavailable("entitlements", "unavailable")),
    };
    const world = harness.serve({ env: RELAXED, entitlementSource: source });
    const { owner, workspaceId } = await ownerAndWorkspace(world);

    const refused = await importAs(world, owner, urls(2));

    expect(refused.status).toBe(503);
    expect(await written(workspaceId)).toEqual({ rows: 0, counter: 0, audit: 0, jobs: 0 });
  });
});
