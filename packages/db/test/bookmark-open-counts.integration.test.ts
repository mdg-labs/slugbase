import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USAGE_FLUSH_BATCH_SIZE, createUsageStore, type UsageStore } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The usage counter of bookmarks (doc 01 section 8.1, doc 02 section 5.5, doc 05 sections 2.4 and 3.3, doc 10 section 5 residual 1,
// T1 and Q28): sys_flush_open_counts(bookmark_ids, counts, last_opened) adds the counts and keeps the greatest last-opened time, for
// bookmarks of any workspace, in one call. The failure scenarios: a count that is added to the wrong bookmark or twice (a bookmark
// named twice in one call), a last-opened time that moves back, a call with a malformed list that writes part of it, a flush that
// reaches anything of a bookmark but its usage (the version, which is an editor's ETag, or the destination), and a role that
// writes the usage by another way than the function.

const HOOK_TIMEOUT_MS = 300_000;
const INVALID_PARAMETER_VALUE = "22023";
const INSUFFICIENT_PRIVILEGE = "42501";

let db: TestDatabase;
let store: UsageStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createUsageStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function workspaceWithMember(): Promise<{ readonly workspaceId: string; readonly accountId: string }> {
  emailNumber += 1;
  const accountId = freshId();
  await seedAccount(db, { id: accountId, email: `usage${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  const workspaceId = await seedWorkspace(db, { name: "Usage test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
  return { workspaceId, accountId };
}

async function seedBookmark(workspace: { readonly workspaceId: string; readonly accountId: string }, usage: { openCount?: number; lastOpenedAt?: Date | null } = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, open_count, last_opened_at)
      VALUES (${id}, ${workspace.workspaceId}, ${workspace.accountId}, 'https://example.com/private', 'https://example.com/private', 'example.com',
              'A private title', ${usage.openCount ?? 0}, ${usage.lastOpenedAt ?? null})`,
  );
  return id;
}

interface Stored {
  readonly open_count: string;
  readonly last_opened_at: Date | null;
  readonly version: number;
  readonly rest: string;
}

/** The usage of a bookmark, its version, and a digest of the columns a flush must not touch. */
async function stored(id: string): Promise<Stored> {
  const rows = await asSystem(
    db,
    (tx) => tx<Stored[]>`
      SELECT open_count::text, last_opened_at, version,
             md5(concat_ws('|', workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, plan_archived_at, created_at)) AS rest
      FROM bookmarks WHERE id = ${id}`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("no such bookmark");
  }
  return row;
}

const at = (iso: string): Date => new Date(iso);

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string") {
      return code;
    }
    throw error;
  }
  return undefined;
}

/** A PostgreSQL array literal of the values, NULL elements included; null stays NULL. */
function literal(values: unknown): string | null {
  if (values === null) {
    return null;
  }
  return `{${(values as (string | null)[]).map((value) => (value === null ? "NULL" : `"${value}"`)).join(",")}}`;
}

/** The function itself, with arrays as given, so a malformed call can be made that the store would refuse before the round trip. */
const call = (ids: unknown, counts: unknown, times: unknown) =>
  db.app`SELECT sys_flush_open_counts(${literal(ids)}::uuid[], ${literal(counts)}::bigint[], ${literal(times)}::timestamptz[])::text AS updated`;

describe("sys_flush_open_counts", () => {
  it("adds the counts to bookmarks of different workspaces in one call and sets the time of one that never was opened", async () => {
    const a = await workspaceWithMember();
    const b = await workspaceWithMember();
    const first = await seedBookmark(a);
    const second = await seedBookmark(b, { openCount: 10, lastOpenedAt: at("2026-01-01T00:00:00Z") });
    const untouched = await seedBookmark(a, { openCount: 7 });
    const before = await stored(first);

    await store.flush([
      { bookmarkId: first, count: 3, lastOpenedAt: at("2026-03-01T10:00:00.250Z") },
      { bookmarkId: second, count: 5, lastOpenedAt: at("2026-03-01T10:00:05Z") },
    ]);

    expect(await stored(first)).toEqual({ ...before, open_count: "3", last_opened_at: at("2026-03-01T10:00:00.250Z") });
    expect(await stored(second)).toMatchObject({ open_count: "15", last_opened_at: at("2026-03-01T10:00:05Z") });
    expect(await stored(untouched)).toMatchObject({ open_count: "7", last_opened_at: null });
  });

  it("keeps the greatest last-opened time: an older one in a later flush adds its count and leaves the time", async () => {
    const workspace = await workspaceWithMember();
    const id = await seedBookmark(workspace);

    await store.flush([{ bookmarkId: id, count: 1, lastOpenedAt: at("2026-03-01T10:00:10Z") }]);
    await store.flush([{ bookmarkId: id, count: 2, lastOpenedAt: at("2026-03-01T10:00:05Z") }]);
    expect(await stored(id)).toMatchObject({ open_count: "3", last_opened_at: at("2026-03-01T10:00:10Z") });

    await store.flush([{ bookmarkId: id, count: 1, lastOpenedAt: at("2026-03-01T10:00:20Z") }]);
    expect(await stored(id)).toMatchObject({ open_count: "4", last_opened_at: at("2026-03-01T10:00:20Z") });
  });

  it("adds up a bookmark named more than once in a call and takes the latest of its times", async () => {
    const workspace = await workspaceWithMember();
    const id = await seedBookmark(workspace);

    const [row] = await call([id, id, id], ["2", "3", "4"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:09Z", "2026-03-01T10:00:03Z"]);

    expect(row?.updated).toBe("1");
    expect(await stored(id)).toMatchObject({ open_count: "9", last_opened_at: at("2026-03-01T10:00:09Z") });
  });

  it("skips a bookmark that does not exist any more and answers how many it updated", async () => {
    const workspace = await workspaceWithMember();
    const id = await seedBookmark(workspace);

    const [row] = await call([freshId(), id], ["5", "1"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]);

    expect(row?.updated).toBe("1");
    expect(await stored(id)).toMatchObject({ open_count: "1" });
  });

  it("writes nothing of a bookmark but its usage: the version, the destination, the owner and the pin stay", async () => {
    const workspace = await workspaceWithMember();
    const id = await seedBookmark(workspace);
    const before = await stored(id);

    await store.flush([{ bookmarkId: id, count: 1, lastOpenedAt: at("2026-03-01T10:00:00Z") }]);

    const after = await stored(id);
    expect(after.version).toBe(before.version);
    expect(after.rest).toBe(before.rest);
  });

  it("accepts an empty call and a call at the largest size", async () => {
    await store.flush([]);
    const [row] = await call([], [], []);
    expect(row?.updated).toBe("0");
    const ids = Array.from({ length: USAGE_FLUSH_BATCH_SIZE }, () => freshId());
    const [large] = await call(ids, ids.map(() => "1"), ids.map(() => "2026-03-01T10:00:00Z"));
    expect(large?.updated).toBe("0");
  });

  const REJECTS: [string, (id: string) => [unknown, unknown, unknown]][] = [
    ["a list of identifiers that is NULL", () => [null, ["1"], ["2026-03-01T10:00:00Z"]]],
    ["a list of counts that is NULL", (id) => [[id], null, ["2026-03-01T10:00:00Z"]]],
    ["a list of times that is NULL", (id) => [[id], ["1"], null]],
    ["fewer counts than identifiers", (id) => [[id, freshId()], ["1"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]]],
    ["fewer times than identifiers", (id) => [[id, freshId()], ["1", "1"], ["2026-03-01T10:00:00Z"]]],
    ["more times than identifiers", (id) => [[id], ["1"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]]],
    ["a NULL identifier", (id) => [[id, null], ["1", "1"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]]],
    ["a NULL count", (id) => [[id, freshId()], ["1", null], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]]],
    ["a NULL time", (id) => [[id, freshId()], ["1", "1"], ["2026-03-01T10:00:00Z", null]]],
    ["a count of zero", (id) => [[id, freshId()], ["1", "0"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]]],
    ["a negative count", (id) => [[id, freshId()], ["1", "-4"], ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"]]],
    [
      "more bookmarks than one call takes",
      (id) => {
        const ids = [id, ...Array.from({ length: USAGE_FLUSH_BATCH_SIZE }, () => freshId())];
        return [ids, ids.map(() => "1"), ids.map(() => "2026-03-01T10:00:00Z")];
      },
    ],
  ];
  it.each(REJECTS)("refuses %s and writes nothing, not even the valid position before it", async (_label, build) => {
    const workspace = await workspaceWithMember();
    const id = await seedBookmark(workspace);
    const before = await stored(id);

    expect(await refusedWith(call(...build(id)))).toBe(INVALID_PARAMETER_VALUE);

    expect(await stored(id)).toEqual(before);
  });

  it("is refused by the store before the round trip for a count that is not a whole number of at least one", async () => {
    const id = freshId();
    for (const count of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(store.flush([{ bookmarkId: id, count, lastOpenedAt: at("2026-03-01T10:00:00Z") }])).rejects.toThrow(RangeError);
    }
    await expect(store.flush([{ bookmarkId: id, count: 1, lastOpenedAt: new Date(Number.NaN) }])).rejects.toThrow(RangeError);
    await expect(
      store.flush(Array.from({ length: USAGE_FLUSH_BATCH_SIZE + 1 }, () => ({ bookmarkId: freshId(), count: 1, lastOpenedAt: at("2026-03-01T10:00:00Z") }))),
    ).rejects.toThrow(RangeError);
  });

  it("is the only way the application role writes the usage: it may not update the columns itself", async () => {
    const workspace = await workspaceWithMember();
    const id = await seedBookmark(workspace);

    expect(await refusedWith(db.app`UPDATE bookmarks SET open_count = open_count + 1 WHERE id = ${id}`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(db.app`UPDATE bookmarks SET last_opened_at = now() WHERE id = ${id}`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stored(id)).toMatchObject({ open_count: "0", last_opened_at: null });
  });

  it("queues concurrent flushes of the same bookmarks in opposite orders and loses no count", async () => {
    const workspace = await workspaceWithMember();
    const ids = [await seedBookmark(workspace), await seedBookmark(workspace), await seedBookmark(workspace), await seedBookmark(workspace)];
    const forward = ids.map((bookmarkId) => ({ bookmarkId, count: 1, lastOpenedAt: at("2026-03-01T10:00:00Z") }));
    const backward = [...forward].reverse();

    await Promise.all(Array.from({ length: 12 }, (_, index) => store.flush(index % 2 === 0 ? forward : backward)));

    for (const id of ids) {
      expect(await stored(id)).toMatchObject({ open_count: "12" });
    }
  });
});
