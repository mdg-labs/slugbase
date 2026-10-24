import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/bookmarks/bulk and GET /api/v1/bookmarks/ids (doc 04 sections 6.2, 7 and 10.6, doc 02 sections 5.7, 5.8 and 10, doc 05
// sections 2.2 and 3.3, doc 10 T1, T2 and T11), through the whole chain over the migrated database. The failure scenario: a member who
// bulk-deletes ten identifiers, three of them another member's, deletes their seven, skips the three and leaves the other member's rows
// intact; and the ones around it: a counter that does not equal the rows afterwards (a skipped, a foreign or a plan-archived row counted),
// a request that half-applies when its audit event cannot be written, a filter that matches more than the select-all cap and deletes
// anyway, an audit event that names a title or an address, and a bucket that does not stop the twenty-first request of the hour.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const BULK = `${BOOKMARKS}/bulk`;
const IDS = `${BOOKMARKS}/ids`;
const SELECT_ALL_CAP = 5000;
const UNKNOWN_ID = "0192f3a0-9999-7000-8000-00000000dead";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly errors?: readonly { readonly path: string; readonly code: string }[];
}

interface Result {
  readonly requested: number;
  readonly affected: number;
  readonly skipped: number;
  readonly skippedReasons: { readonly not_owner: number; readonly not_found: number };
}

interface Listed {
  readonly ids: readonly string[];
  readonly truncated: boolean;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const relaxed = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour" };

const bulk = (world: World, as: Person, body: unknown) => send(world, "POST", BULK, { cookie: as.cookie }, body);
const ids = (world: World, as: Person, query = "") => send(world, "GET", `${IDS}${query === "" ? "" : `?${query}`}`, { cookie: as.cookie });

async function done(response: Response): Promise<Result> {
  expect(response.status).toBe(200);
  return (await response.json()) as Result;
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

interface Seed {
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly slug?: string;
}

/** Bookmarks of `owner`, counted unless archived, with their ids in the order given. */
async function seed(workspaceId: string, owner: Person, count: number, options: Seed = {}): Promise<string[]> {
  const made: string[] = [];
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    for (let index = 0; index < count; index += 1) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, pinned_at, plan_archived_at)
        VALUES (gen_random_uuid(), ${workspaceId}, ${owner.account.id}, 'https://example.com/private-path', 'https://example.com/private-path', 'example.com', 'A private title',
                ${options.slug === undefined ? null : `${options.slug}-${String(index)}`}, ${options.pinned === true ? "2026-01-01T00:00:00Z" : null}::text::timestamptz,
                ${options.archived === true ? "2026-01-01T00:00:00Z" : null}::text::timestamptz)
        RETURNING id`;
      made.push(row?.id ?? "");
    }
    if (options.archived !== true) {
      await tx`UPDATE workspaces SET bookmark_count = bookmark_count + ${count} WHERE id = ${workspaceId}`;
    }
  });
  return made;
}

interface Stored {
  readonly id: string;
  readonly owner_id: string | null;
  readonly pinned_at: Date | null;
  readonly version: number;
  readonly archived: boolean;
}

async function rowsOf(workspaceId: string): Promise<Stored[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Stored[]>`SELECT id, owner_id, pinned_at, version, plan_archived_at IS NOT NULL AS archived FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`;
  });
}

async function counterOf(workspaceId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`;
  });
  return rows[0]?.bookmark_count ?? Number.NaN;
}

interface AuditRow {
  readonly action: string;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly actor_token_id: string | null;
  readonly metadata: Record<string, string>;
  readonly row: string;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_type, actor_account_id, actor_token_id, metadata, audit_events::text AS row FROM audit_events
      WHERE workspace_id = ${workspaceId} AND action LIKE 'bookmark.%' ORDER BY created_at, id`;
  });
}

describe("bulk delete", () => {
  it(
    "deletes the seven of ten identifiers the caller owns, skips the three that are another member's as not found, and leaves the other member's rows intact",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, member, shared } = await setup(world);
      const own = await seed(shared.workspaceId, owner, 7);
      const theirs = await seed(shared.workspaceId, member, 3);
      const theirsBefore = (await rowsOf(shared.workspaceId)).filter((row) => theirs.includes(row.id));

      const result = await done(await bulk(world, owner, { action: "delete", ids: [...own, ...theirs] }));

      expect(result).toEqual({ requested: 10, affected: 7, skipped: 3, skippedReasons: { not_owner: 0, not_found: 3 } });
      const rows = await rowsOf(shared.workspaceId);
      expect(rows).toEqual(theirsBefore);
      expect(await counterOf(shared.workspaceId)).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "adjusts the counter once by the non-archived rows deleted for a mix of own, foreign, missing, repeated and plan-archived identifiers, and the counter equals the rows afterwards",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, member, stranger, shared, other } = await setup(world);
      const own = await seed(shared.workspaceId, owner, 5);
      const ownArchived = await seed(shared.workspaceId, owner, 2, { archived: true });
      const theirs = await seed(shared.workspaceId, member, 2);
      const strangers = await seed(other.workspaceId, stranger, 2);
      const strangerBefore = { rows: await rowsOf(other.workspaceId), counter: await counterOf(other.workspaceId) };
      expect(await counterOf(shared.workspaceId)).toBe(7);

      const result = await done(
        await bulk(world, owner, { action: "delete", ids: [...own.slice(0, 3), ...ownArchived, ...theirs, ...strangers, UNKNOWN_ID, own[0] ?? "", (own[1] ?? "").toUpperCase()] }),
      );

      expect(result).toEqual({ requested: 10, affected: 5, skipped: 5, skippedReasons: { not_owner: 0, not_found: 5 } });
      const rows = await rowsOf(shared.workspaceId);
      expect(rows.map((row) => row.id).toSorted()).toEqual([...own.slice(3), ...theirs].toSorted());
      expect(await counterOf(shared.workspaceId)).toBe(rows.filter((row) => !row.archived).length);
      expect(await counterOf(shared.workspaceId)).toBe(4);
      expect({ rows: await rowsOf(other.workspaceId), counter: await counterOf(other.workspaceId) }).toEqual(strangerBefore);
    },
    TEST_TIMEOUT_MS,
  );

  it("answers a foreign identifier and a missing one alike, without saying whether either exists", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member, shared } = await setup(world);
    const [theirs] = await seed(shared.workspaceId, member, 1);

    const foreign = await done(await bulk(world, owner, { action: "delete", ids: [theirs ?? ""] }));
    const missing = await done(await bulk(world, owner, { action: "delete", ids: [UNKNOWN_ID] }));

    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({ requested: 1, affected: 0, skipped: 1, skippedReasons: { not_owner: 0, not_found: 1 } });
    expect((await rowsOf(shared.workspaceId)).map((row) => row.id)).toEqual([theirs]);
  });

  it(
    "acts on the bookmarks a filter matches, among the caller's own, and on nothing else",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, member, shared } = await setup(world);
      const pinned = await seed(shared.workspaceId, owner, 3, { pinned: true });
      const plain = await seed(shared.workspaceId, owner, 2);
      const archived = await seed(shared.workspaceId, owner, 1, { archived: true, pinned: true });
      const theirs = await seed(shared.workspaceId, member, 2, { pinned: true });

      const result = await done(await bulk(world, owner, { action: "delete", filter: { pinned: true } }));

      expect(result).toEqual({ requested: 3, affected: 3, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } });
      const rows = await rowsOf(shared.workspaceId);
      expect(rows.map((row) => row.id).toSorted()).toEqual([...plain, ...archived, ...theirs].toSorted());
      expect(pinned.every((id) => !rows.some((row) => row.id === id))).toBe(true);
      expect(await counterOf(shared.workspaceId)).toBe(rows.filter((row) => !row.archived).length);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a filter that matches more than the select-all cap with 422 validation_failed and deletes nothing",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, shared } = await setup(world);
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`
          INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
          SELECT gen_random_uuid(), ${shared.workspaceId}, ${owner.account.id}, 'https://example.com/f' || n, 'https://example.com/f' || n, 'example.com', 'Filler ' || n
          FROM generate_series(1, ${SELECT_ALL_CAP + 1}) AS n`;
        await tx`UPDATE workspaces SET bookmark_count = ${SELECT_ALL_CAP + 1} WHERE id = ${shared.workspaceId}`;
      });

      const refused = await bulk(world, owner, { action: "delete", filter: {} });

      expect(refused.status).toBe(422);
      expect((await problemOf(refused)).code).toBe("validation_failed");
      expect((await rowsOf(shared.workspaceId)).length).toBe(SELECT_ALL_CAP + 1);
      expect(await counterOf(shared.workspaceId)).toBe(SELECT_ALL_CAP + 1);
      expect(await auditOf(shared.workspaceId)).toEqual([]);

      // At the cap exactly, the same filter is accepted.
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`DELETE FROM bookmarks WHERE id = (SELECT id FROM bookmarks WHERE workspace_id = ${shared.workspaceId} LIMIT 1)`;
        await tx`UPDATE workspaces SET bookmark_count = ${SELECT_ALL_CAP} WHERE id = ${shared.workspaceId}`;
      });
      expect(await done(await bulk(world, owner, { action: "delete", filter: {} }))).toMatchObject({ requested: SELECT_ALL_CAP, affected: SELECT_ALL_CAP });
      expect(await counterOf(shared.workspaceId)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it("refuses a filter whose url cannot be a bookmark's with 422 on filter.url, and deletes nothing", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    await seed(shared.workspaceId, owner, 2);

    const refused = await bulk(world, owner, { action: "delete", filter: { url: "ftp://example.com/file" } });

    expect(refused.status).toBe(422);
    const problem = await problemOf(refused);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors).toEqual([{ path: "filter.url", code: "url_not_allowed" }]);
    expect(await counterOf(shared.workspaceId)).toBe(2);
  });

  it("records one bookmark.bulk_deleted event with the number deleted and nothing about the bookmarks, and none for a request that deleted nothing", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member, shared } = await setup(world);
    const own = await seed(shared.workspaceId, owner, 4, { slug: "private-slug" });
    const theirs = await seed(shared.workspaceId, member, 2);

    await done(await bulk(world, owner, { action: "delete", ids: [...own, ...theirs] }));
    await done(await bulk(world, owner, { action: "delete", ids: [...theirs, UNKNOWN_ID] }));
    await done(await bulk(world, owner, { action: "pin", ids: theirs }));

    const events = await auditOf(shared.workspaceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "bookmark.bulk_deleted", actor_type: "account", actor_account_id: owner.account.id, actor_token_id: null, metadata: { count: "4" } });
    const text = events[0]?.row ?? "";
    expect(text).not.toContain("A private title");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("private-slug");
    for (const id of [...own, ...theirs]) {
      expect(text).not.toContain(id);
    }
  });

  it(
    "applies nothing when the audit event cannot be written: the rows and the counter are as they were",
    async () => {
      const world = harness.serve({ env: relaxed });
      const { owner, shared } = await setup(world);
      const own = await seed(shared.workspaceId, owner, 3);
      const before = { rows: await rowsOf(shared.workspaceId), counter: await counterOf(shared.workspaceId) };
      await database().owner`
        CREATE FUNCTION public.refuse_bulk_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END $$`;
      await database().owner`CREATE TRIGGER refuse_bulk_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.refuse_bulk_audit()`;
      try {
        const response = await bulk(world, owner, { action: "delete", ids: own });

        expect(response.status).toBe(500);
      } finally {
        await database().owner`DROP TRIGGER refuse_bulk_audit ON audit_events`;
        await database().owner`DROP FUNCTION public.refuse_bulk_audit()`;
      }

      expect({ rows: await rowsOf(shared.workspaceId), counter: await counterOf(shared.workspaceId) }).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("bulk pin and unpin", () => {
  it("pins the caller's own bookmarks, leaves a pinned one with its pin time and version, and skips another member's and a plan-archived one as not found", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member, shared } = await setup(world);
    const plain = await seed(shared.workspaceId, owner, 2);
    const already = await seed(shared.workspaceId, owner, 1, { pinned: true });
    const archived = await seed(shared.workspaceId, owner, 1, { archived: true });
    const theirs = await seed(shared.workspaceId, member, 1);
    const before = await rowsOf(shared.workspaceId);

    const result = await done(await bulk(world, owner, { action: "pin", ids: [...plain, ...already, ...archived, ...theirs] }));

    expect(result).toEqual({ requested: 5, affected: 3, skipped: 2, skippedReasons: { not_owner: 0, not_found: 2 } });
    const rows = await rowsOf(shared.workspaceId);
    for (const row of rows) {
      const earlier = before.find((candidate) => candidate.id === row.id);
      if (plain.includes(row.id)) {
        expect(row.pinned_at).not.toBeNull();
        expect(row.version).toBe((earlier?.version ?? 0) + 1);
      } else {
        expect(row).toEqual(earlier);
      }
    }
    expect(await counterOf(shared.workspaceId)).toBe(4);
    expect(await auditOf(shared.workspaceId)).toEqual([]);
  });

  it("unpins them, by identifier and by filter", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member, shared } = await setup(world);
    const first = await seed(shared.workspaceId, owner, 2, { pinned: true });
    const second = await seed(shared.workspaceId, owner, 3, { pinned: true });
    const theirs = await seed(shared.workspaceId, member, 1, { pinned: true });

    expect(await done(await bulk(world, owner, { action: "unpin", ids: first }))).toEqual({ requested: 2, affected: 2, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } });
    expect(await done(await bulk(world, owner, { action: "unpin", filter: { pinned: true } }))).toMatchObject({ requested: 3, affected: 3 });

    const rows = await rowsOf(shared.workspaceId);
    expect(rows.filter((row) => row.pinned_at !== null).map((row) => row.id)).toEqual(theirs);
    expect(rows).toHaveLength(first.length + second.length + theirs.length);
  });
});

describe("the request", () => {
  it.each([
    ["neither ids nor filter", { action: "delete" }],
    ["both ids and filter", { action: "delete", ids: [UNKNOWN_ID], filter: {} }],
    ["an empty list of ids", { action: "delete", ids: [] }],
    ["more than 1 000 ids", { action: "delete", ids: Array.from({ length: 1001 }, () => UNKNOWN_ID) }],
    ["an unknown action", { action: "archive", ids: [UNKNOWN_ID] }],
    ["a missing action", { ids: [UNKNOWN_ID] }],
    ["an identifier that is not one", { action: "delete", ids: ["not-an-identifier"] }],
    ["a field it does not declare", { action: "delete", ids: [UNKNOWN_ID], extra: true }],
    ["a filter field it does not declare", { action: "delete", filter: { title: "x" } }],
    ["a filter boolean that is a string", { action: "delete", filter: { pinned: "true" } }],
  ])("answers 422 validation_failed for %s and deletes nothing", async (_name, body) => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    await seed(shared.workspaceId, owner, 2);

    const refused = await bulk(world, owner, body);

    expect(refused.status).toBe(422);
    expect((await problemOf(refused)).code).toBe("validation_failed");
    expect(await counterOf(shared.workspaceId)).toBe(2);
    expect(await rowsOf(shared.workspaceId)).toHaveLength(2);
  });

  it("accepts exactly 1 000 identifiers, one named twice counting once", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await seed(shared.workspaceId, owner, 2);

    const result = await done(await bulk(world, owner, { action: "delete", ids: [...own, own[0] ?? "", ...Array.from({ length: 997 }, () => UNKNOWN_ID)] }));

    expect(result).toEqual({ requested: 3, affected: 2, skipped: 1, skippedReasons: { not_owner: 0, not_found: 1 } });
  });

  it("answers 401 without a session", async () => {
    const world = harness.serve({ env: relaxed });
    const refused = await send(world, "POST", BULK, {}, { action: "delete", ids: [UNKNOWN_ID] });
    expect(refused.status).toBe(401);
  });

  it("answers 403 token_scope to a token that may only read, and deletes nothing; a read-write token deletes", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await seed(shared.workspaceId, owner, 2);
    const readOnly = await harness.token(shared.workspaceId, owner, "read");
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");

    const refused = await send(world, "POST", BULK, bearer(readOnly), { action: "delete", ids: own });
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("token_scope");
    expect(await rowsOf(shared.workspaceId)).toHaveLength(2);

    expect(await done(await send(world, "POST", BULK, bearer(readWrite), { action: "delete", ids: own }))).toMatchObject({ affected: 2 });
    expect(await rowsOf(shared.workspaceId)).toHaveLength(0);
  });

  it("records a read-write token's bulk delete as the token: actor type api_token with that token's identifier and its account", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await seed(shared.workspaceId, owner, 3);
    const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
    const tokenRows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ id: string }[]>`SELECT id FROM api_tokens WHERE workspace_id = ${shared.workspaceId} AND account_id = ${owner.account.id}`;
    });
    expect(tokenRows).toHaveLength(1);

    await done(await send(world, "POST", BULK, bearer(readWrite), { action: "delete", ids: own }));

    const events = await auditOf(shared.workspaceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "bookmark.bulk_deleted",
      actor_type: "api_token",
      actor_account_id: owner.account.id,
      actor_token_id: tokenRows[0]?.id,
      metadata: { count: "3" },
    });
  });

  it("answers a request from another workspace's session 404-alike: the identifiers of workspace B are skipped as not found, and B is untouched", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, stranger, shared, other } = await setup(world);
    const ofB = await seed(other.workspaceId, stranger, 3);
    await seed(shared.workspaceId, owner, 1);
    const before = { rows: await rowsOf(other.workspaceId), counter: await counterOf(other.workspaceId) };

    for (const action of ["delete", "pin", "unpin"] as const) {
      expect(await done(await bulk(world, owner, { action, ids: ofB }))).toEqual({ requested: 3, affected: 0, skipped: 3, skippedReasons: { not_owner: 0, not_found: 3 } });
    }

    expect({ rows: await rowsOf(other.workspaceId), counter: await counterOf(other.workspaceId) }).toEqual(before);
  });
});

describe("the bulk bucket", () => {
  it("stops the twenty-first request of the hour per account with 429 and Retry-After, and the refused request changes nothing", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const [target] = await seed(shared.workspaceId, owner, 1);

    for (let index = 0; index < 20; index += 1) {
      expect((await bulk(world, owner, { action: "pin", ids: [UNKNOWN_ID] })).status).toBe(200);
    }
    const refused = await bulk(world, owner, { action: "delete", ids: [target ?? ""] });

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await rowsOf(shared.workspaceId)).map((row) => row.id)).toEqual([target]);
    expect(await counterOf(shared.workspaceId)).toBe(1);
    // The select-all is a read and is not in the bucket.
    expect((await ids(world, owner)).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("takes the limit from the RATE_LIMIT_BULK keys", async () => {
    const world = harness.serve({ env: { RATE_LIMIT_BULK_IP: "2/hour", RATE_LIMIT_BULK_ACCOUNT: "2/hour" } });
    const { owner } = await setup(world);

    expect((await bulk(world, owner, { action: "pin", ids: [UNKNOWN_ID] })).status).toBe(200);
    expect((await bulk(world, owner, { action: "pin", ids: [UNKNOWN_ID] })).status).toBe(200);
    expect((await bulk(world, owner, { action: "pin", ids: [UNKNOWN_ID] })).status).toBe(429);
  });
});

describe("select all", () => {
  it("lists the identifiers of the caller's own bookmarks that match the filters, newest first, and no other member's, workspace's or plan-archived one", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, member, stranger, shared, other } = await setup(world);
    const plain = await seed(shared.workspaceId, owner, 2);
    const pinned = await seed(shared.workspaceId, owner, 2, { pinned: true });
    await seed(shared.workspaceId, owner, 1, { archived: true });
    await seed(shared.workspaceId, member, 2);
    await seed(other.workspaceId, stranger, 2);

    const all = await ids(world, owner);
    expect(all.status).toBe(200);
    const listed = (await all.json()) as Listed;
    expect(listed.truncated).toBe(false);
    expect([...listed.ids].toSorted()).toEqual([...plain, ...pinned].toSorted());

    const onlyPinned = (await (await ids(world, owner, "pinned=true")).json()) as Listed;
    expect([...onlyPinned.ids].toSorted()).toEqual(pinned.toSorted());
    const notPinned = (await (await ids(world, owner, "pinned=false&scope=mine")).json()) as Listed;
    expect([...notPinned.ids].toSorted()).toEqual(plain.toSorted());
    const none = (await (await ids(world, owner, "hasSlug=true")).json()) as Listed;
    expect(none).toEqual({ ids: [], truncated: false });
  });

  it("returns the first 5 000 and says it was cut when more match; a bulk request by the same filter is refused", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        SELECT gen_random_uuid(), ${shared.workspaceId}, ${owner.account.id}, 'https://example.com/f' || n, 'https://example.com/f' || n, 'example.com', 'Filler ' || n
        FROM generate_series(1, ${SELECT_ALL_CAP + 1}) AS n`;
    });

    const response = await ids(world, owner);

    expect(response.status).toBe(200);
    const listed = (await response.json()) as Listed;
    expect(listed.ids).toHaveLength(SELECT_ALL_CAP);
    expect(new Set(listed.ids).size).toBe(SELECT_ALL_CAP);
    expect(listed.truncated).toBe(true);
    expect((await bulk(world, owner, { action: "pin", filter: {} })).status).toBe(422);
  }, TEST_TIMEOUT_MS);

  it("is not read as the identifier of a bookmark, and refuses a url that cannot be a bookmark's and a parameter it does not declare", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner } = await setup(world);

    expect((await ids(world, owner)).status).toBe(200);
    const badUrl = await ids(world, owner, `url=${encodeURIComponent("ftp://example.com/x")}`);
    expect(badUrl.status).toBe(422);
    expect((await problemOf(badUrl)).code).toBe("validation_failed");
    expect((await ids(world, owner, "limit=5")).status).toBe(422);
    expect((await ids(world, owner, "sort=recent")).status).toBe(422);
  });

  it("lets a read-only token list the identifiers", async () => {
    const world = harness.serve({ env: relaxed });
    const { owner, shared } = await setup(world);
    const own = await seed(shared.workspaceId, owner, 2);
    const readOnly = await harness.token(shared.workspaceId, owner, "read");

    const response = await send(world, "GET", IDS, bearer(readOnly));

    expect(response.status).toBe(200);
    expect([...((await response.json()) as Listed).ids].toSorted()).toEqual(own.toSorted());
  });
});
