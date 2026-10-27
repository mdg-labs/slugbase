import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The text query of the select-all and of the bulk request by filter (doc 04 section 6.2, doc 02 sections 5.7 and 5.8, doc 10 T1 and T2), through the whole chain over the migrated
// database. The failure scenario: the list a member filters by a text shows some of their bookmarks, and "select all matching" or a bulk delete by the same filter that ignored the text
// would name all of them, deleting what the member never saw.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const relaxed = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour" };

interface Problem {
  readonly code: string;
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

/** Bookmarks of `owner` named `title`; the workspace's counter is raised for those that are not plan-archived. */
async function seed(workspaceId: string, owner: Person, title: string, count: number, archived = false): Promise<string[]> {
  const made: string[] = [];
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    for (let index = 0; index < count; index += 1) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
        VALUES (gen_random_uuid(), ${workspaceId}, ${owner.account.id}, 'https://example.com/p', 'https://example.com/p', 'example.com', ${title}, ${archived ? "2026-01-01T00:00:00Z" : null}::text::timestamptz)
        RETURNING id`;
      made.push(row?.id ?? "");
    }
    if (!archived) {
      await tx`UPDATE workspaces SET bookmark_count = bookmark_count + ${count} WHERE id = ${workspaceId}`;
    }
  });
  return made;
}

async function idsOfWorkspace(workspaceId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`;
  });
  return rows.map((row) => row.id);
}

describe("the select-all with a text query", () => {
  it("names the caller's own bookmarks the text matches and no others, and a text the select-all refuses is a 422", async () => {
    const world = harness.serve();
    const { owner, member, shared } = await setup(world);
    const widgets = await seed(shared.workspaceId, owner, "Widget notes", 3);
    await seed(shared.workspaceId, owner, "Gadget notes", 4);
    await seed(shared.workspaceId, owner, "Widget archived", 1, true);
    await seed(shared.workspaceId, member, "Widget of the member", 2);

    const response = await send(world, "GET", `${BOOKMARKS}/ids?q=widget`, { cookie: owner.cookie });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ids: string[]; truncated: boolean };
    expect(body.ids.toSorted()).toEqual(widgets.toSorted());
    expect(body.truncated).toBe(false);
    const refused = await send(world, "GET", `${BOOKMARKS}/ids?q=`, { cookie: owner.cookie });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Problem).code).toBe("validation_failed");
  }, TEST_TIMEOUT_MS);
});

describe("the bulk request by filter with a text query", () => {
  it("deletes the bookmarks the text matches among the caller's own and nothing else", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member, shared } = await setup(world);
    await seed(shared.workspaceId, owner, "Widget notes", 3);
    const gadgets = await seed(shared.workspaceId, owner, "Gadget notes", 4);
    const theirs = await seed(shared.workspaceId, member, "Widget of the member", 2);

    const response = await send(world, "POST", `${BOOKMARKS}/bulk`, { cookie: owner.cookie }, { action: "delete", filter: { q: "widget" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requested: 3, affected: 3, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } });
    expect(await idsOfWorkspace(shared.workspaceId)).toEqual([...gadgets, ...theirs].toSorted());
  }, TEST_TIMEOUT_MS);

  it("pins the bookmarks the text matches and no others", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    await seed(shared.workspaceId, owner, "Widget notes", 2);
    await seed(shared.workspaceId, owner, "Gadget notes", 3);

    const pinned = await send(world, "POST", `${BOOKMARKS}/bulk`, { cookie: owner.cookie }, { action: "pin", filter: { q: "widget" } });

    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ requested: 2, affected: 2 });
    const list = await send(world, "GET", `${BOOKMARKS}?pinned=true&limit=10`, { cookie: owner.cookie });
    const body = (await list.json()) as { items: { title: string }[] };
    expect(body.items.map((item) => item.title)).toEqual(["Widget notes", "Widget notes"]);
  }, TEST_TIMEOUT_MS);

  it("refuses a filter whose text is blank with 422 on filter.q and deletes nothing, so a lost text never widens the delete to every bookmark", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await seed(shared.workspaceId, owner, "Widget notes", 3);

    for (const q of ["", "   "]) {
      const response = await send(world, "POST", `${BOOKMARKS}/bulk`, { cookie: owner.cookie }, { action: "delete", filter: { q } });
      expect(response.status, JSON.stringify(q)).toBe(422);
      expect(((await response.json()) as Problem).code).toBe("validation_failed");
    }
    expect(await idsOfWorkspace(shared.workspaceId)).toEqual(own.toSorted());
  }, TEST_TIMEOUT_MS);
});
