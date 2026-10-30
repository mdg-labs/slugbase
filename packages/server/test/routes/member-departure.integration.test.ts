import { setTimeout as sleep } from "node:timers/promises";
import type { DomainEvent, EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { applyDeparture } from "../../src/worker/member-departure.ts";
import { productionEnv } from "../config/support.ts";
import { seedMembership, setActiveWorkspace } from "../auth/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, LEAVE, MEMBERS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The content choice of a departure, applied by the worker once `member.left` is delivered (doc 02 section 3.6, doc 05 sections 2.4 and 7.1, doc 10 T2), through the
// operations that end a membership and the worker that handles the event. The failure scenario: A shares a bookmark and a folder with B; the owner removes A with
// `content: "delete"` (or A leaves); once the event is delivered B can no longer read what A shared and it no longer exists, and with `transfer` the recipient owns it and B still
// reads it. Until then the content stays in the workspace without an owner, as the contract says.

const TEST_TIMEOUT_MS = 90_000;
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const QUEUE = "event.member.left";
const SLUG = "mail";
const URL_OF_A = "https://example.com/a-mail";
const POLL_SECONDS = 0.5;
const WAIT_MS = 30_000;
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = {
  RATE_LIMIT_BULK_IP: "10000/hour",
  RATE_LIMIT_BULK_ACCOUNT: "10000/hour",
  RATE_LIMIT_WRITE_IP: "10000/min",
  RATE_LIMIT_WRITE_ACCOUNT: "10000/min",
  RATE_LIMIT_READ_IP: "10000/min",
  RATE_LIMIT_READ_ACCOUNT: "10000/min",
};

const database = useTestDatabase();
const harness = workspaceHarness(database);
let worker: RunningWorker | undefined;

beforeAll(async () => {
  await harness.start();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
});

const as = (person: Person): Record<string, string> => ({ cookie: person.cookie });

async function idOf(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(201);
  return ((await settled.json()) as { id: string }).id;
}

interface Cast {
  readonly world: World;
  readonly workspaceId: string;
  /** The owner of the workspace, who removes A and receives the content. */
  readonly owner: Person;
  /** The member who leaves or is removed. */
  readonly a: Person;
  /** The member A shares with. */
  readonly b: Person;
  readonly bookmark: string;
  readonly folder: string;
}

/** A owns a bookmark with a slug, filed in a folder, and shares both with B. */
async function cast(): Promise<Cast> {
  const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
  const owner = await harness.person(world);
  const a = await harness.person(world);
  const b = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: a, role: "member" },
    { person: b, role: "member" },
  ]);
  const bookmark = await idOf(send(world, "POST", BOOKMARKS, as(a), { url: URL_OF_A, title: "A mail", slug: SLUG }));
  const folder = await idOf(send(world, "POST", FOLDERS, as(a), { name: "A folder" }));
  expect((await send(world, "POST", `${FOLDERS}/${folder}/bookmarks`, as(a), { bookmarkIds: [bookmark] })).status).toBeLessThan(300);
  expect((await send(world, "POST", `${BOOKMARKS}/${bookmark}/shares`, as(a), { accountId: b.account.id })).status).toBeLessThan(300);
  expect((await send(world, "POST", `${FOLDERS}/${folder}/shares`, as(a), { accountId: b.account.id })).status).toBeLessThan(300);
  expect((await send(world, "GET", `${BOOKMARKS}/${bookmark}`, as(b))).status).toBe(200);
  return { world, workspaceId, owner, a, b, bookmark, folder };
}

interface Stored {
  readonly bookmarks: { id: string; owner_id: string | null; slug: string | null }[];
  readonly folders: { id: string; owner_id: string | null }[];
  readonly shares: number;
  readonly bookmarkCount: number;
}

async function stored(workspaceId: string): Promise<Stored> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    const bookmarks = await tx<Stored["bookmarks"]>`SELECT id, owner_id, slug FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`;
    const folders = await tx<Stored["folders"]>`SELECT id, owner_id FROM folders WHERE workspace_id = ${workspaceId} ORDER BY id`;
    const [shares] = await tx<{ n: number }[]>`
      SELECT (SELECT count(*) FROM bookmark_shares WHERE workspace_id = ${workspaceId})::int + (SELECT count(*) FROM folder_shares WHERE workspace_id = ${workspaceId})::int AS n`;
    const [counter] = await tx<{ n: number }[]>`SELECT bookmark_count AS n FROM workspaces WHERE id = ${workspaceId}`;
    return { bookmarks, folders, shares: shares?.n ?? 0, bookmarkCount: counter?.n ?? 0 };
  });
}

async function startWorker(): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: adapters(),
    modules: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}

/** Waits until the event jobs of `departures` departures have all completed; a failed or retried job never reaches it. */
async function delivered(departures = 1): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const rows = await database().app<{ state: string }[]>`SELECT state FROM pgboss.job WHERE name = ${QUEUE}`;
    if (rows.length === departures && rows.every((row) => row.state === "completed")) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`the ${QUEUE} job did not complete: ${JSON.stringify(rows)}`);
    }
    await sleep(50);
  }
}

const ENDINGS = [
  {
    name: "DELETE /members/{accountId}",
    end: (c: Cast, content: "transfer" | "delete") => send(c.world, "DELETE", `${MEMBERS}/${c.a.account.id}`, as(c.owner), { content }),
  },
  {
    name: "POST /workspace/leave",
    end: (c: Cast, content: "transfer" | "delete") => send(c.world, "POST", LEAVE, as(c.a), { content }),
  },
] as const;

describe.each(ENDINGS)("$name", ({ end }) => {
  it(
    "leaves the content ownerless until the event is delivered, then deletes it with the shares on it when the choice is delete",
    async () => {
      const c = await cast();
      expect((await end(c, "delete")).status).toBe(200);

      const before = await stored(c.workspaceId);
      expect(before.bookmarks.map((row) => row.owner_id)).toEqual([null]);
      expect(before.folders.map((row) => row.owner_id)).toEqual([null]);

      await startWorker();
      await delivered();

      expect(await stored(c.workspaceId)).toEqual({ bookmarks: [], folders: [], shares: 0, bookmarkCount: 0 });
      expect((await send(c.world, "GET", `${BOOKMARKS}/${c.bookmark}`, as(c.b))).status).toBe(404);
      expect((await send(c.world, "GET", `${FOLDERS}/${c.folder}`, as(c.b))).status).toBe(404);
      expect((await send(c.world, "GET", `${BOOKMARKS}/${c.bookmark}`, as(c.owner))).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives the content to the recipient when the choice is transfer, and the shares of A on it stay in force for B",
    async () => {
      const c = await cast();
      expect((await end(c, "transfer")).status).toBe(200);

      await startWorker();
      await delivered();

      const after = await stored(c.workspaceId);
      expect(after.bookmarks).toEqual([{ id: c.bookmark, owner_id: c.owner.account.id, slug: SLUG }]);
      expect(after.folders).toEqual([{ id: c.folder, owner_id: c.owner.account.id }]);
      expect(after.shares).toBe(2);
      expect(after.bookmarkCount).toBe(1);
      expect((await send(c.world, "GET", `${BOOKMARKS}/${c.bookmark}`, as(c.b))).status).toBe(200);
      expect((await send(c.world, "GET", `${FOLDERS}/${c.folder}`, as(c.b))).status).toBe(200);
      expect((await send(c.world, "GET", `${BOOKMARKS}/${c.bookmark}`, as(c.owner))).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a delivery that comes late", () => {
  it(
    "leaves the new content of a member who joined again alone, and deletes what the first membership left",
    async () => {
      const c = await cast();
      expect((await send(c.world, "DELETE", `${MEMBERS}/${c.a.account.id}`, as(c.owner), { content: "delete" })).status).toBe(200);
      await seedMembership(database(), { workspaceId: c.workspaceId, accountId: c.a.account.id, role: "member" });
      await setActiveWorkspace(database(), c.a.sessionId, c.workspaceId);
      const fresh = await idOf(send(c.world, "POST", BOOKMARKS, as(c.a), { url: "https://example.com/again", title: "Again", slug: "again" }));

      await startWorker();
      await delivered();

      const after = await stored(c.workspaceId);
      expect(after.bookmarks).toEqual([{ id: fresh, owner_id: c.a.account.id, slug: "again" }]);
      expect(after.folders).toEqual([]);
      expect(after.bookmarkCount).toBe(1);
      expect((await send(c.world, "GET", `${BOOKMARKS}/${c.bookmark}`, as(c.b))).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the content with no owner, and gives it to no one, when the recipient has left the workspace since",
    async () => {
      const c = await cast();
      expect((await send(c.world, "DELETE", `${MEMBERS}/${c.a.account.id}`, as(c.owner), { content: "transfer", transferTo: c.b.account.id })).status).toBe(200);
      expect((await send(c.world, "POST", LEAVE, as(c.b), { content: "transfer" })).status).toBe(200);

      await startWorker();
      await delivered(2);

      const after = await stored(c.workspaceId);
      expect(after.bookmarks).toEqual([{ id: c.bookmark, owner_id: null, slug: SLUG }]);
      expect(after.folders).toEqual([{ id: c.folder, owner_id: null }]);
      // B's membership took the two shares with it.
      expect(after.shares).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "changes nothing when the same event is delivered a second time, and fails the delivery when the database does",
    async () => {
      const c = await cast();
      expect((await send(c.world, "DELETE", `${MEMBERS}/${c.a.account.id}`, as(c.owner), { content: "transfer" })).status).toBe(200);
      await startWorker();
      await delivered();
      const [job] = await database().app<{ data: { eventId: string; workspaceId: string; accountId: string; content: "transfer"; transferTo: string } }[]>`
        SELECT data FROM pgboss.job WHERE name = ${QUEUE}`;
      if (job === undefined) {
        throw new Error("the departure queued no event");
      }
      const { eventId, ...payload } = job.data;
      const event: DomainEvent<"member.left"> = { eventId, name: "member.left", payload };
      const before = await stored(c.workspaceId);
      const handle = applyDeparture({ withTenant: (context, fn) => database().tenant.withTenant(context, fn), logger: recordingLogger() });

      await handle(event);
      await handle(event);

      expect(await stored(c.workspaceId)).toEqual(before);
      const broken = applyDeparture({ withTenant: () => Promise.reject(new Error("the database is down")), logger: recordingLogger() });
      await expect(broken(event)).rejects.toThrow("the database is down");
    },
    TEST_TIMEOUT_MS,
  );
});
