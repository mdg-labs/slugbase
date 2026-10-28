import { randomUUID } from "node:crypto";
import { useTestDatabase, type TestSql } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FAVICON_PLACEHOLDER } from "../../src/routes/favicons.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/favicons/{host} (doc 04 sections 7, 8 and 10.6, doc 02 section 5.4, doc 01 section 8.1, doc 10 T1, T6 and T14), through the whole chain over the migrated database. The
// failure scenario: the operation used as a fetch proxy, so the server fetches a host the caller has no bookmark on (a host nobody saved, another member's, an archived bookmark's, another
// workspace's), or a fetch started over and over for one host; and an answer that is not the PNG the server encoded (never SVG, always `image/png` with `nosniff`). Only a request that would
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

async function storeIcon(host: string): Promise<void> {
  await asSystem((tx) => tx`SELECT sys_favicon_put(${host}::text, 'ok'::text, ${ICON_64}::bytea, ${ICON_32}::bytea)`);
}

async function storeNone(host: string): Promise<void> {
  await asSystem((tx) => tx`SELECT sys_favicon_put(${host}::text, 'none'::text, NULL::bytea, NULL::bytea)`);
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
    const { owner } = await setup(world);
    await storeIcon(HOST);

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
    const { owner } = await setup(world);
    await storeIcon(HOST);

    expect((await bytes(await get(world, owner, HOST, "?size=64"))).equals(ICON_64)).toBe(true);
    expect((await bytes(await get(world, owner, HOST, "?size=32"))).equals(ICON_32)).toBe(true);
  });

  it("carries the security headers of every response and is never SVG", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    await storeIcon(HOST);

    const response = await get(world, owner, HOST);

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-type")).not.toMatch(/svg|html|xml/);
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it("is shared by the deployment: a member of another workspace with no bookmark on the host is served it, and nothing is queued", async () => {
    const world = harness.serve();
    const { stranger } = await setup(world);
    await storeIcon(HOST);

    const response = await get(world, stranger, HOST);

    expect(response.status).toBe(200);
    expect((await bytes(response)).equals(ICON_64)).toBe(true);
    expect(await queued()).toEqual([]);
  });

  it("is a miss once it has expired by the database clock", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST);
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
    expect(job).toMatchObject({ state: "created", policy: "short", singleton_key: HOST });
    expect(job?.data).toEqual({ host: HOST, workspaceId: shared.workspaceId, accountId: owner.account.id });
  });

  it("queues one waiting job for a host however many members and requests ask for it", async () => {
    const world = harness.serve();
    const { owner, colleague, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await bookmarkOn(shared.workspaceId, colleague.account.id, HOST);

    for (const person of [owner, owner, colleague, colleague]) {
      expect((await get(world, person, HOST)).status).toBe(202);
    }

    expect(await queued()).toHaveLength(1);
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
    await storeNone(HOST);

    const response = await get(world, owner, HOST);

    expect(response.status).toBe(202);
    expect((await bytes(response)).equals(Buffer.from(FAVICON_PLACEHOLDER))).toBe(true);
    expect(await queued()).toEqual([]);
  });

  it("queues nothing for a size request of a host with a stored icon, and a size the contract does not name is refused", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await bookmarkOn(shared.workspaceId, owner.account.id, HOST);
    await storeIcon(HOST);

    expect((await get(world, owner, HOST, "?size=32")).status).toBe(200);
    expect((await get(world, owner, HOST, "?size=16")).status).toBe(422);
    expect(await queued()).toEqual([]);
  });
});

describe("the request", () => {
  it("needs a session", async () => {
    const world = harness.serve();
    await setup(world);
    await storeIcon(HOST);

    const response = await send(world, "GET", `${BASE}/${HOST}`, {});

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is refused to an API token, which no scope admits to this operation", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    await storeIcon(HOST);
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    const response = await send(world, "GET", `${BASE}/${HOST}`, bearer(readWrite));

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  });

  it("is refused to an account that acts in no workspace", async () => {
    const world = harness.serve();
    const loner = await harness.person(world);
    await storeIcon(HOST);

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
    await storeIcon(HOST);
    await storeNone("none.example.test");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await get(world, owner, HOST)).status).toBe(200);
      expect((await get(world, owner, "none.example.test")).status).toBe(202);
      expect((await get(world, owner, "nobody.example.test")).status).toBe(202);
    }

    await bookmarkOn(shared.workspaceId, owner.account.id, "miss.example.test");
    expect((await get(world, owner, "miss.example.test")).status).toBe(202);
    expect((await queued()).map((row) => row.singleton_key)).toEqual(["miss.example.test"]);
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
    expect((await queued()).map((row) => row.singleton_key).sort()).toEqual(["one.example.test", "two.example.test"]);
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
    const { owner } = await setup(world);
    await storeIcon(HOST);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await get(world, owner, HOST)).status).toBe(200);
    }
    const limited = await get(world, owner, HOST);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-policy")).toContain('"read:account"');
    expect(limited.headers.get("ratelimit-policy")).not.toContain('"write');
  });
});
