import { randomUUID } from "node:crypto";
import { useTestDatabase, type TestSql } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FAVICON_PLACEHOLDER } from "../../src/routes/favicons.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/favicons/{host} (doc 04 sections 7, 8 and 10.6, doc 02 section 5.4, doc 01 section 8.1, doc 10 T1, T6 and T14), through the whole chain over the migrated database. The
// failure scenario: the operation used as a fetch proxy, so the server fetches a host the caller has no bookmark on (a host nobody saved, another member's, an archived bookmark's, another
// workspace's), or a fetch started over and over for one host; the shared cache used as an oracle, a cached icon answered to a caller who can read no bookmark on the host, or to a workspace that never requested the host, so a 200 against a 202 tells whether another workspace saved or requested it; and an answer that is not the PNG the server encoded (never SVG, always `image/png` with `nosniff`). Only a request that would
// queue a fetch takes from the fetch bucket, and a request over its limit queues nothing.

const TEST_TIMEOUT_MS = 60_000;
const BASE = "/api/v1/favicons";
const JOB = "favicon.fetch";
const HOST = "icons.example.test";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_64 = Buffer.concat([PNG_SIGNATURE, Buffer.from("sixty-four")]);
const ICON_32 = Buffer.concat([PNG_SIGNATURE, Buffer.from("thirty-two")]);

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
  await asSystem((tx) => tx`DELETE FROM favicons`);
  await asSystem((tx) => tx`DELETE FROM workspace_favicons`);
});

async function asSystem(work: (tx: TestSql) => unknown): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await work(tx as unknown as TestSql);
  });
}

const get = (world: World, as: Person, host: string, query = "") => send(world, "GET", `${BASE}/${host}${query}`, { cookie: as.cookie });

async function setup(world: World) {
  const owner = await harness.person(world);
  const colleague = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: colleague, role: "member" },
  ]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, colleague, stranger, shared, other };
}

async function bookmarkOn(workspaceId: string, ownerId: string, host: string, archived = false): Promise<void> {
  const url = `https://${host}/page`;
  await asSystem(
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, ${url}, ${url}, ${host}, 'As entered', ${archived ? new Date() : null})`,
  );
}

/** The icon of a host as a fetch for `accountId` in `workspaceId` leaves it: the shared bytes and that member's record of the request. */
async function storeIcon(host: string, workspaceId: string, accountId: string): Promise<void> {
  await asSystem((tx) => tx`SELECT sys_favicon_put(${host}::text, 'ok'::text, ${ICON_64}::bytea, ${ICON_32}::bytea)`);
  await recordFetch(host, workspaceId, accountId);
}

async function storeNone(host: string, workspaceId: string, accountId: string): Promise<void> {
  await asSystem((tx) => tx`SELECT sys_favicon_put(${host}::text, 'none'::text, NULL::bytea, NULL::bytea)`);
  await recordFetch(host, workspaceId, accountId);
}

async function recordFetch(host: string, workspaceId: string, accountId: string): Promise<void> {
  await asSystem(
    (tx) => tx`
      INSERT INTO workspace_favicons (workspace_id, account_id, host, fetched_at, expires_at) VALUES (${workspaceId}, ${accountId}, ${host}, now(), now() + interval '7 days')
      ON CONFLICT (workspace_id, account_id, host) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
  );
}

interface QueuedRow {
  readonly state: string;
  readonly singleton_key: string | null;
  readonly policy: string;
  readonly data: Record<string, unknown>;
}

async function queued(): Promise<QueuedRow[]> {
  return [...(await database().app<QueuedRow[]>`SELECT state, singleton_key, policy, data FROM pgboss.job WHERE name = ${JOB} ORDER BY created_on, id`)];
}

async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("an icon that is in the cache", () => {
  it("is answered as image/png with nosniff and a private cache of seven days, with the bytes the server stored", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    const response = await get(world, owner, HOST);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=604800");
    expect((await bytes(response)).equals(ICON_64)).toBe(true);
    expect(await queued()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("is answered at the size asked for: 64 px by default, 32 px with size=32", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    expect((await bytes(await get(world, owner, HOST, "?size=64"))).equals(ICON_64)).toBe(true);
    expect((await bytes(await get(world, owner, HOST, "?size=32"))).equals(ICON_32)).toBe(true);
  });

  it("carries the security headers of every response and is never SVG", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    const response = await get(world, owner, HOST);

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-type")).not.toMatch(/svg|html|xml/);
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it("is not served to a member who can read no bookmark on the host: the answer is the one for an uncached host, whether the cache holds an icon or a record of none", async () => {
    const world = harness.serve();
    const { owner, stranger, colleague, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, colleague.account.id, "colleague.example.test");
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    await storeNone("none.example.test", shared.workspaceId, owner.account.id);

    for (const host of [HOST, "none.example.test", "uncached.example.test"]) {
      for (const query of ["", "?size=32"]) {
        const response = await get(world, stranger, host, query);

        expect(response.status, host).toBe(202);
        expect(response.headers.get("content-type"), host).toBe("image/png");
        expect(response.headers.get("cache-control"), host).toBe("private, max-age=60");
        expect((await bytes(response)).equals(Buffer.from(FAVICON_PLACEHOLDER)), host).toBe(true);
      }
    }
    expect(await queued()).toEqual([]);
  });

  it("is not served to a member who can read only another member's bookmark on the host, or a plan-archived one", async () => {
    const world = harness.serve();
    const { owner, colleague, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, colleague.account.id, HOST);
    await bookmarkOn(shared.workspaceId, owner.account.id, "archived.example.test", true);
    await storeIcon(HOST, shared.workspaceId, colleague.account.id);
    await storeIcon("archived.example.test", shared.workspaceId, owner.account.id);

    expect((await get(world, owner, HOST)).status).toBe(202);
    expect((await get(world, owner, "archived.example.test")).status).toBe(202);
    expect((await get(world, colleague, HOST)).status).toBe(200);
  });

  it("is not served to a member who reads the host when only another member of the workspace had it fetched: the answer is the one for an uncached host, and the fetch is queued for the caller", async () => {
    const world = harness.serve();
    const { owner, colleague, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await bookmarkOn(shared.workspaceId, colleague.account.id, HOST);
    await bookmarkOn(shared.workspaceId, owner.account.id, "none.example.test");
    await bookmarkOn(shared.workspaceId, colleague.account.id, "none.example.test");
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    await storeNone("none.example.test", shared.workspaceId, owner.account.id);
    expect((await get(world, owner, HOST)).status).toBe(200);

    const answers = [];
    for (const host of [HOST, "none.example.test"]) {
      const response = await get(world, colleague, host);
      answers.push({ status: response.status, cache: response.headers.get("cache-control"), body: (await bytes(response)).toString("base64") });
    }

    expect(answers).toEqual([HOST, "none.example.test"].map(() => ({ status: 202, cache: "private, max-age=60", body: Buffer.from(FAVICON_PLACEHOLDER).toString("base64") })));
    const jobs = await queued();
    expect(jobs.map((job) => job.data.accountId)).toEqual([colleague.account.id, colleague.account.id]);
  });

  it("is not served to a workspace that never requested the host, whatever another workspace has cached: the answer is the one for a host nobody on the instance requested", async () => {
    const world = harness.serve();
    const { owner, stranger, shared, other } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    await storeNone("none.example.test", shared.workspaceId, owner.account.id);
    expect((await get(world, owner, HOST)).status).toBe(200);
    await bookmarkOn(other.workspaceId, stranger.account.id, HOST);
    await bookmarkOn(other.workspaceId, stranger.account.id, "none.example.test");
    await bookmarkOn(other.workspaceId, stranger.account.id, "uncached.example.test");

    const answers = [];
    for (const host of [HOST, "none.example.test", "uncached.example.test"]) {
      const response = await get(world, stranger, host);
      answers.push({ host, status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), body: (await bytes(response)).toString("base64") });
    }

    expect(answers.map((answer) => ({ ...answer, host: undefined }))).toEqual(answers.map(() => ({ host: undefined, status: 202, type: "image/png", cache: "private, max-age=60", body: Buffer.from(FAVICON_PLACEHOLDER).toString("base64") })));
    const jobs = await queued();
    expect(jobs.map((job) => job.singleton_key).sort()).toEqual([HOST, "none.example.test", "uncached.example.test"].map((host) => `${host}:${other.workspaceId}:${stranger.account.id}`).sort());
    expect(jobs.every((job) => job.data.workspaceId === other.workspaceId)).toBe(true);
  });

  it("is served again to the workspace that requested it once its own fetch is stored, and a record of none follows the same rule", async () => {
    const world = harness.serve();
    const { owner, stranger, shared, other } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await bookmarkOn(other.workspaceId, stranger.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    expect((await get(world, stranger, HOST)).status).toBe(202);

    await storeIcon(HOST, other.workspaceId, stranger.account.id);

    expect((await get(world, stranger, HOST)).status).toBe(200);
    expect((await get(world, owner, HOST)).status).toBe(200);
  });

  it("is a miss once the workspace's own fetch of it has expired, though the shared row has not", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    await asSystem((tx) => tx`UPDATE workspace_favicons SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 second'`);

    const response = await get(world, owner, HOST);

    expect(response.status).toBe(202);
    expect(await queued()).toHaveLength(1);
  });

  it("is a miss once it has expired by the database clock", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    await asSystem((tx) => tx`UPDATE favicons SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 second'`);

    const response = await get(world, owner, HOST);

    expect(response.status).toBe(202);
    expect(await queued()).toHaveLength(1);
  });
});

describe("an icon that is not in the cache", () => {
  it("is answered with the placeholder PNG, kept for a minute, and queues one fetch with the host, the workspace and the account for a host of a bookmark the caller can read", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);

    const response = await get(world, owner, HOST);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect((await bytes(response)).equals(Buffer.from(FAVICON_PLACEHOLDER))).toBe(true);
    const [job, ...rest] = await queued();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({ state: "created", policy: "short", singleton_key: `${HOST}:${shared.workspaceId}:${owner.account.id}` });
    expect(job?.data).toEqual({ host: HOST, workspaceId: shared.workspaceId, accountId: owner.account.id });
  });

  it("queues one waiting job for each member for a host however many requests they make", async () => {
    const world = harness.serve();
    const { owner, colleague, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await bookmarkOn(shared.workspaceId, colleague.account.id, HOST);

    for (const person of [owner, owner, colleague, colleague]) {
      expect((await get(world, person, HOST)).status).toBe(202);
    }

    expect((await queued()).map((row) => row.singleton_key).sort()).toEqual([`${HOST}:${shared.workspaceId}:${owner.account.id}`, `${HOST}:${shared.workspaceId}:${colleague.account.id}`].sort());
  });

  it("queues nothing, and answers the placeholder, for a host the caller has no bookmark on, so the operation cannot be used as a fetch proxy", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, "other.example.test");

    for (const host of [HOST, "169.254.169.254", "localhost", "10.0.0.1", "internal.corp"]) {
      const response = await get(world, owner, host);
      expect(response.status, host).toBe(202);
      expect((await bytes(response)).equals(Buffer.from(FAVICON_PLACEHOLDER)), host).toBe(true);
    }

    expect(await queued()).toEqual([]);
  });

  it("queues nothing for a host that only another member's bookmark, an archived bookmark or another workspace's bookmark is on", async () => {
    const world = harness.serve();
    const { owner, colleague, stranger, shared, other } = await setup(world);
    await bookmarkOn(shared.workspaceId, colleague.account.id, "colleague.example.test");
    await bookmarkOn(shared.workspaceId, owner.account.id, "archived.example.test", true);
    await bookmarkOn(other.workspaceId, stranger.account.id, "elsewhere.example.test");

    for (const host of ["colleague.example.test", "archived.example.test", "elsewhere.example.test"]) {
      expect((await get(world, owner, host)).status, host).toBe(202);
    }

    expect(await queued()).toEqual([]);
  });

  it("queues nothing for a host the cache knows has no icon, until that record expires", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeNone(HOST, shared.workspaceId, owner.account.id);

    const response = await get(world, owner, HOST);

    expect(response.status).toBe(202);
    expect((await bytes(response)).equals(Buffer.from(FAVICON_PLACEHOLDER))).toBe(true);
    expect(await queued()).toEqual([]);
  });

  it("queues nothing for a size request of a host with a stored icon, and a size the contract does not name is refused", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    expect((await get(world, owner, HOST, "?size=32")).status).toBe(200);
    expect((await get(world, owner, HOST, "?size=16")).status).toBe(422);
    expect(await queued()).toEqual([]);
  });
});

describe("the request", () => {
  it("needs a session", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    const response = await send(world, "GET", `${BASE}/${HOST}`, {});

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is refused to an API token, which no scope admits to this operation", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    const response = await send(world, "GET", `${BASE}/${HOST}`, bearer(readWrite));

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  });

  it("is refused to an account that acts in no workspace", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const loner = await harness.person(world);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    expect((await get(world, loner, HOST)).status).toBe(404);
  });

  it.each([
    ["a host in upper case", "Icons.Example.Test"],
    ["a host with a port", "icons.example.test:8080"],
    ["a host with a path", "icons.example.test%2Fx"],
    ["a host with a trailing dot", "icons.example.test."],
    ["a host with an empty label", "icons..example.test"],
    ["an IPv6 literal", "%5B::1%5D"],
    ["a host with an underscore", "icons_example.test"],
    ["a host over 253 characters", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`],
    ["a script", "%3Cscript%3E"],
  ])("answers 422 for %s, queues nothing and does not read the cache", async (_name, host) => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);

    const response = await get(world, owner, host);

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(await queued()).toEqual([]);
  });

  it("answers 422 for a parameter the operation does not declare", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect((await get(world, owner, HOST, "?url=https://evil.example/")).status).toBe(422);
  });
});

describe("the fetch bucket", () => {
  it("is taken only by a request that would queue a fetch: any number of cached icons, placeholders and unreadable hosts take nothing from it", async () => {
    const world = harness.serve({ env: { RATE_LIMIT_FETCH_ACCOUNT: "1/min", RATE_LIMIT_FETCH_IP: "1/min" } });
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, "none.example.test");
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);
    await storeNone("none.example.test", shared.workspaceId, owner.account.id);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await get(world, owner, HOST)).status).toBe(200);
      expect((await get(world, owner, "none.example.test")).status).toBe(202);
      expect((await get(world, owner, "nobody.example.test")).status).toBe(202);
    }

    await bookmarkOn(shared.workspaceId, owner.account.id, "miss.example.test");
    expect((await get(world, owner, "miss.example.test")).status).toBe(202);
    expect((await queued()).map((row) => row.singleton_key)).toEqual([`miss.example.test:${shared.workspaceId}:${owner.account.id}`]);
  });

  it("limits a member to the RATE_LIMIT_FETCH_ACCOUNT key across misses, answers 429 with Retry-After and queues nothing for the refused one", async () => {
    const world = harness.serve({ env: { RATE_LIMIT_FETCH_ACCOUNT: "2/min", RATE_LIMIT_FETCH_IP: "1000/min" } });
    const { owner, shared } = await setup(world);
    for (const host of ["one.example.test", "two.example.test", "three.example.test"]) {
      await bookmarkOn(shared.workspaceId, owner.account.id, host);
    }

    expect((await get(world, owner, "one.example.test")).status).toBe(202);
    expect((await get(world, owner, "two.example.test")).status).toBe(202);
    const limited = await get(world, owner, "three.example.test");

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect((await queued()).map((row) => row.singleton_key).sort()).toEqual([`one.example.test:${shared.workspaceId}:${owner.account.id}`, `two.example.test:${shared.workspaceId}:${owner.account.id}`]);
  });

  it("limits a client address to the RATE_LIMIT_FETCH_IP key across accounts", async () => {
    const world = harness.serve({ env: { RATE_LIMIT_FETCH_IP: "2/min", RATE_LIMIT_FETCH_ACCOUNT: "1000/min" } });
    const { owner, colleague, shared } = await setup(world);
    for (const [person, host] of [
      [owner, "one.example.test"],
      [colleague, "two.example.test"],
      [owner, "three.example.test"],
    ] as const) {
      await bookmarkOn(shared.workspaceId, person.account.id, host);
    }

    expect((await get(world, owner, "one.example.test")).status).toBe(202);
    expect((await get(world, colleague, "two.example.test")).status).toBe(202);
    expect((await get(world, owner, "three.example.test")).status).toBe(429);
    expect(await queued()).toHaveLength(2);
  });

  it("limits every request by the read bucket, cached icons included, and never takes from the write bucket", async () => {
    const world = harness.serve({ env: { RATE_LIMIT_READ_ACCOUNT: "3/min", RATE_LIMIT_READ_IP: "1000/min", RATE_LIMIT_WRITE_ACCOUNT: "1/min", RATE_LIMIT_WRITE_IP: "1/min" } });
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST, shared.workspaceId, owner.account.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await get(world, owner, HOST)).status).toBe(200);
    }
    const limited = await get(world, owner, HOST);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-policy")).toContain('"read:account"');
    expect(limited.headers.get("ratelimit-policy")).not.toContain('"write');
  });
});
