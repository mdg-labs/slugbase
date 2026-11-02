import { randomUUID } from "node:crypto";
import { archiveBookmarks, restoreBookmarks } from "@slugbase/core";
import { bookmarkArchiveTransaction } from "@slugbase/db";
import { createRandom, LimitedEntitlementSource, type Random } from "@slugbase/testing";
import { assertBookmarkCountMatches, bookmarkCountDrift, useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { tenantDatabase } from "../contract/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import { bookmarkFile, upload } from "./netscape-upload.ts";

// workspaces.bookmark_count is the number of the workspace's bookmarks that are not plan-archived after every create, update, delete, bulk
// delete, import (JSON and browser file), archive and restore (doc 05 section 2.2, doc 02 section 5, doc 10 T11). A random sequence of those
// operations runs over several workspaces under a ceiling that the creations and the imports reach, and the counter is compared with the
// rows after each step, so the step that parts them is the one that fails. The sequences come from fixed seeds: a failure names its seed
// and the steps before it, and the same seed runs the same sequence again.

const TEST_TIMEOUT_MS = 120_000;
const BOOKMARKS = "/api/v1/bookmarks";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };
const CEILING = 10;
const WORKSPACES = 3;
const STEPS = 120;
const SEEDS = [348, 20_261_102, 7_001_000];

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Place {
  readonly workspaceId: string;
  readonly owner: Person;
  readonly member: Person;
}

interface Row {
  readonly id: string;
  readonly owner_id: string;
  readonly archived: boolean;
}

async function rowsOf(workspaceId: string): Promise<Row[]> {
  return database().owner.begin("read only", async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Row[]>`SELECT id, owner_id, plan_archived_at IS NOT NULL AS archived FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`;
  });
}

async function places(world: World): Promise<Place[]> {
  const made: Place[] = [];
  for (let index = 0; index < WORKSPACES; index += 1) {
    const owner = await harness.person(world);
    const member = await harness.person(world);
    const workspace = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
    made.push({ workspaceId: workspace.workspaceId, owner, member });
  }
  return made;
}

const limited = (max: number) => new LimitedEntitlementSource().grant("bookmarks.max", max);

function expectStatus(response: Response, expected: readonly number[]): void {
  expect(expected, `status ${String(response.status)}`).toContain(response.status);
}

interface Operation {
  readonly name: string;
  readonly weight: number;
  run(context: Context): Promise<string>;
}

interface Context {
  readonly world: World;
  readonly random: Random;
  readonly place: Place;
  readonly actor: Person;
  readonly rows: readonly Row[];
  readonly fresh: () => number;
}

const urlOf = (number: number): string => `https://example.com/property/${String(number)}`;

const OPERATIONS: readonly Operation[] = [
  {
    name: "create",
    weight: 30,
    async run({ world, actor, fresh }) {
      const number = fresh();
      const response = await send(world, "POST", BOOKMARKS, { cookie: actor.cookie }, { url: urlOf(number), title: `Created ${String(number)}` });
      expectStatus(response, [201, 422]);
      return String(response.status);
    },
  },
  {
    name: "update",
    weight: 6,
    async run({ world, actor, rows, random }) {
      const own = rows.filter((row) => row.owner_id === actor.account.id && !row.archived);
      if (own.length === 0) {
        return "no bookmark of the actor";
      }
      const target = random.pick(own);
      const response = await send(world, "PATCH", `${BOOKMARKS}/${target.id}`, { cookie: actor.cookie }, { title: `Edited ${String(random.int(1000))}` });
      expectStatus(response, [200]);
      return target.id;
    },
  },
  {
    name: "delete",
    weight: 12,
    async run({ world, actor, rows, random }) {
      const own = rows.filter((row) => row.owner_id === actor.account.id);
      if (own.length === 0) {
        return "no bookmark of the actor";
      }
      const target = random.pick(own);
      const response = await send(world, "DELETE", `${BOOKMARKS}/${target.id}`, { cookie: actor.cookie });
      expectStatus(response, [204]);
      return `${target.id}${target.archived ? " (archived)" : ""}`;
    },
  },
  {
    name: "bulk delete",
    weight: 10,
    async run({ world, actor, rows, random }) {
      const ids = rows.filter(() => random.chance(0.4)).map((row) => row.id);
      ids.push(randomUUID());
      const response = await send(world, "POST", `${BOOKMARKS}/bulk`, { cookie: actor.cookie }, { action: "delete", ids });
      expectStatus(response, [200]);
      return `${String(ids.length)} identifiers`;
    },
  },
  {
    name: "import json",
    weight: 10,
    async run({ world, actor, random, fresh }) {
      const file = Array.from({ length: 1 + random.int(5) }, () => ({ url: urlOf(random.chance(0.3) ? random.int(40) : fresh()), planArchived: random.chance(0.2) }));
      const response = await send(world, "POST", "/api/v1/import/json", { cookie: actor.cookie }, file);
      expectStatus(response, [200, 422]);
      return `${String(file.length)} bookmarks, ${String(response.status)}`;
    },
  },
  {
    name: "import browser file",
    weight: 8,
    async run({ world, actor, random, fresh }) {
      const links = Array.from({ length: 1 + random.int(5) }, () => ({ url: urlOf(random.chance(0.3) ? random.int(40) : fresh()), title: "Linked" }));
      const response = await upload(world, actor, bookmarkFile(links));
      expectStatus(response, [200, 422]);
      return `${String(links.length)} links, ${String(response.status)}`;
    },
  },
  {
    name: "archive",
    weight: 12,
    async run({ place, rows, random }) {
      const live = rows.filter((row) => !row.archived);
      const ids = [...live.filter(() => random.chance(0.5)), ...rows.filter((row) => row.archived && random.chance(0.2))].map((row) => row.id);
      await tenantDatabase(database()).withTenant({ accountId: place.owner.account.id, workspaceId: place.workspaceId, requestId: "property-archive" }, async (tx) => {
        await archiveBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId: place.workspaceId, bookmarkIds: ids });
      });
      return `${String(ids.length)} bookmarks`;
    },
  },
  {
    name: "restore",
    weight: 8,
    async run({ place, rows, random }) {
      const ids = [...rows.filter((row) => row.archived && random.chance(0.6)), ...rows.filter((row) => !row.archived && random.chance(0.1))].map((row) => row.id);
      await tenantDatabase(database()).withTenant({ accountId: place.owner.account.id, workspaceId: place.workspaceId, requestId: "property-restore" }, async (tx) => {
        await restoreBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId: place.workspaceId, bookmarkIds: ids });
      });
      return `${String(ids.length)} bookmarks`;
    },
  },
];

function choose(random: Random): Operation {
  const total = OPERATIONS.reduce((sum, operation) => sum + operation.weight, 0);
  let point = random.int(total);
  for (const operation of OPERATIONS) {
    if (point < operation.weight) {
      return operation;
    }
    point -= operation.weight;
  }
  throw new Error("no operation chosen");
}

describe("workspaces.bookmark_count over a random sequence of operations", { timeout: TEST_TIMEOUT_MS }, () => {
  for (const seed of SEEDS) {
    it(`equals the bookmarks that are not archived in every workspace after each of ${String(STEPS)} steps (seed ${String(seed)})`, async () => {
      const world = harness.serve({ env: RELAXED, entitlementSource: limited(CEILING) });
      const all = await places(world);
      const random = createRandom(seed);
      let next = 0;
      const fresh = (): number => {
        next += 1;
        return 1000 + next;
      };
      const done: string[] = [];

      for (let step = 1; step <= STEPS; step += 1) {
        const operation = choose(random);
        const place = random.pick(all);
        const actor = random.chance(0.5) ? place.owner : place.member;
        const label = `step ${String(step)}: ${operation.name} in workspace ${String(all.indexOf(place) + 1)} by the ${actor === place.owner ? "owner" : "member"}`;
        try {
          const detail = await operation.run({ world, random, place, actor, rows: await rowsOf(place.workspaceId), fresh });
          done.push(`${label} (${detail})`);
          await assertBookmarkCountMatches(database());
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`seed ${String(seed)}, ${label} failed: ${reason}\nsteps before it:\n${done.join("\n")}`, { cause: error });
        }
      }

      expect(await bookmarkCountDrift(database())).toEqual([]);
      const names = new Set(done.map((entry) => entry.slice(entry.indexOf(": ") + 2, entry.indexOf(" in workspace"))));
      expect([...names].sort()).toEqual(OPERATIONS.map((operation) => operation.name).sort());
    });
  }

  it("lets one of two creations at the limit minus one through in each of several workspaces, and keeps the counter equal to the rows", async () => {
    const world = harness.serve({ env: RELAXED, entitlementSource: limited(CEILING) });
    const all = await places(world);
    for (const place of all) {
      for (let index = 0; index < CEILING - 1; index += 1) {
        expectStatus(await send(world, "POST", BOOKMARKS, { cookie: place.owner.cookie }, { url: urlOf(index), title: `Held ${String(index)}` }), [201]);
      }
    }
    await assertBookmarkCountMatches(database());

    const answers = await Promise.all(
      all.flatMap((place) => [
        send(world, "POST", BOOKMARKS, { cookie: place.owner.cookie }, { url: urlOf(900), title: "Race owner" }),
        send(world, "POST", BOOKMARKS, { cookie: place.member.cookie }, { url: urlOf(901), title: "Race member" }),
      ]),
    );

    for (let index = 0; index < all.length; index += 1) {
      const pair = answers.slice(index * 2, index * 2 + 2).map((answer) => answer.status);
      expect(pair.sort()).toEqual([201, 422]);
      expect(await rowsOf(all[index]?.workspaceId ?? "")).toHaveLength(CEILING);
    }
    await assertBookmarkCountMatches(database());
  });
});
