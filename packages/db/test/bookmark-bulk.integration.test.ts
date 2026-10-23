import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, memberRepository, type TenantTx } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle } from "../src/tenant.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Deleting, pinning and unpinning many bookmarks at once (doc 02 sections 5.7 and 5.8, doc 05 sections 2.2 and 3.3, doc 10 T1, T2 and
// T11). The failure scenarios: a bulk delete that reaches another member's or another workspace's bookmarks; a counter that does not
// fall by exactly the deleted rows that were not plan-archived (a plan-archived row counted, a skipped row counted, the counter moved
// without the rows); a pin that rewrites the time or the version of a bookmark that was pinned already, or pins one that is another
// member's or plan-archived; and a call that deadlocks against another bulk call, a single delete or a member's removal.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER_VALUE = "22023";
const DEADLOCK_DETECTED = "40P01";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `bulk${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 1): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Bulk test" });
  const members: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const accountId = await account();
    await seedMember(db, { workspaceId: id, accountId, role: index === 0 ? "owner" : "member" });
    members.push(accountId);
  }
  return { id, members };
}

function memberOf(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "bulk-test" }, work);
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

/** Bookmarks the way a creation stores them, counted unless archived; `pinned` stamps `pinned_at` with a time long ago. */
async function seedBookmarks(workspace: Workspace, count: number, options: { archived?: boolean; ownerIndex?: number; pinned?: boolean } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = freshId();
    ids.push(id);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, pinned_at, plan_archived_at)
        VALUES (${id}, ${workspace.id}, ${memberOf(workspace, options.ownerIndex ?? 0)}, 'https://example.com/bulk', 'https://example.com/bulk', 'example.com',
                'Bulk title', ${options.pinned === true ? new Date("2020-01-01T00:00:00Z") : null}, ${options.archived === true ? new Date() : null})`,
    );
  }
  if (options.archived !== true) {
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = bookmark_count + ${count} WHERE id = ${workspace.id}`);
  }
  return ids;
}

interface Stored {
  readonly id: string;
  readonly archived: boolean;
  readonly pinned_at: Date | null;
  readonly version: number;
  readonly owner_id: string | null;
}

async function stored(workspaceId: string): Promise<Stored[]> {
  return asSystem(
    db,
    (tx) => tx<Stored[]>`SELECT id, plan_archived_at IS NOT NULL AS archived, pinned_at, version, owner_id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`,
  );
}

async function counter(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`);
  return rows[0]?.bookmark_count ?? Number.NaN;
}

const removeMany = (workspace: Workspace, bookmarkIds: readonly string[], accountIndex = 0) =>
  inTenant({ accountId: memberOf(workspace, accountIndex), workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).removeMany({ bookmarkIds }));

const setPinned = (workspace: Workspace, bookmarkIds: readonly string[], pinned: boolean, accountIndex = 0) => {
  const ownerId = memberOf(workspace, accountIndex);
  return inTenant({ accountId: ownerId, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).setPinned({ bookmarkIds, ownerId, pinned }));
};

describe("removeMany", () => {
  it("deletes the caller's own bookmarks, a plan-archived one included, and lowers the counter by the ones the counter counted, so it equals the rows that are not archived", async () => {
    const workspace = await workspaceOf(2);
    const own = await seedBookmarks(workspace, 4);
    const ownArchived = await seedBookmarks(workspace, 2, { archived: true });
    const others = await seedBookmarks(workspace, 3, { ownerIndex: 1 });
    const stranger = await workspaceOf();
    const foreign = await seedBookmarks(stranger, 2);
    const strangerBefore = { rows: await stored(stranger.id), counter: await counter(stranger.id) };
    expect(await counter(workspace.id)).toBe(7);

    const deleted = await removeMany(workspace, [...own.slice(0, 3), ...ownArchived, ...others.slice(0, 2), ...foreign, freshId()]);

    expect(deleted).toBe(5);
    const rows = await stored(workspace.id);
    expect(rows.map((row) => row.id).toSorted()).toEqual([own[3] ?? "", ...others].toSorted());
    expect(await counter(workspace.id)).toBe(rows.filter((row) => !row.archived).length);
    expect(await counter(workspace.id)).toBe(4);
    expect({ rows: await stored(stranger.id), counter: await counter(stranger.id) }).toEqual(strangerBefore);
  });

  it("names a bookmark twice and deletes it once, lowering the counter once for it", async () => {
    const workspace = await workspaceOf();
    const [first, second] = await seedBookmarks(workspace, 2);

    expect(await removeMany(workspace, [first ?? "", first ?? "", (first ?? "").toUpperCase()])).toBe(1);

    expect(await counter(workspace.id)).toBe(1);
    expect((await stored(workspace.id)).map((row) => row.id)).toEqual([second]);
  });

  it("deletes nothing and leaves the counter for an empty list, and for a list of strangers' identifiers", async () => {
    const workspace = await workspaceOf(2);
    await seedBookmarks(workspace, 2);
    const others = await seedBookmarks(workspace, 2, { ownerIndex: 1 });
    const before = await stored(workspace.id);

    expect(await removeMany(workspace, [])).toBe(0);
    expect(await removeMany(workspace, others)).toBe(0);

    expect(await stored(workspace.id)).toEqual(before);
    expect(await counter(workspace.id)).toBe(4);
  });

  it("answers undefined and deletes nothing in a workspace being deleted, for an account that is no member, and when the transaction acts in another workspace", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const ids = await seedBookmarks(workspace, 2);
    const outsider = await account();
    const before = { rows: await stored(workspace.id), counter: await counter(workspace.id) };

    // A member of `other` acting in `other`, naming the bookmarks of `workspace`: the rows are not `other`'s, so none is deleted.
    expect(await removeMany(other, ids)).toBe(0);
    // An account that is no member of the workspace, acting in it: the bookmarks are not its own.
    expect(await inTenant({ accountId: outsider, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).removeMany({ bookmarkIds: ids }))).toBe(0);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspace.id}`);
    expect(await removeMany(workspace, ids)).toBeUndefined();

    expect({ rows: await stored(workspace.id), counter: await counter(workspace.id) }).toEqual(before);
  });

  it("refuses a repository call without a workspace and one that names something other than an identifier", async () => {
    const workspace = await workspaceOf();
    await expect(inTenant({ accountId: memberOf(workspace, 0) }, (tx) => bookmarkRepository(tx).removeMany({ bookmarkIds: [] }))).rejects.toThrow("tenant transaction opened with a workspace");
    await expect(removeMany(workspace, ["not-an-identifier"])).rejects.toThrow("identifiers only");
  });

  it("rolls the rows and the counter back when the transaction fails after the call", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 3);
    const before = { rows: await stored(workspace.id), counter: await counter(workspace.id) };

    const failure = new Error("a later step failed");
    await expect(
      inTenant({ accountId: memberOf(workspace, 0), workspaceId: workspace.id }, async (tx) => {
        expect(await bookmarkRepository(tx).removeMany({ bookmarkIds: ids })).toBe(3);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect({ rows: await stored(workspace.id), counter: await counter(workspace.id) }).toEqual(before);
  });

  it("deletes the maximum of 5 000 identifiers in one call", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 3);
    const strangers = Array.from({ length: 4997 }, () => freshId());

    expect(await removeMany(workspace, [...strangers, ...ids])).toBe(3);
    expect(await counter(workspace.id)).toBe(0);
  }, 60_000);
});

describe("the system operation sys_bookmark_delete_many", () => {
  /** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no service, no application layer. */
  async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
      return { value: await work(tx) };
    });
    return result.value;
  }

  const call = (tx: postgres.TransactionSql, workspaceId: string, ids: readonly string[]) =>
    tx<{ deleted: number | null }[]>`SELECT public.sys_bookmark_delete_many(${workspaceId}::uuid, ${`{${ids.join(",")}}`}::uuid[]) AS deleted`.then((rows) => rows[0]?.deleted);

  it("answers NULL and writes nothing when the transaction acts in another workspace or in none, the RLS-only path included", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const ofB = await seedBookmarks(b, 2);
    const before = { rows: await stored(b.id), counter: await counter(b.id) };

    expect(await appAs({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => call(tx, b.id, ofB))).toBeNull();
    expect(await appAs({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => call(tx, a.id, ofB))).toBe(0);
    expect(await appAs({ accountId: memberOf(b, 0) }, (tx) => call(tx, b.id, ofB))).toBeNull();
    expect(await appAs({ accountId: memberOf(b, 0), workspaceId: b.id }, (tx) => call(tx, a.id, ofB))).toBeNull();
    expect(await appAs({ accountId: memberOf(a, 0), workspaceId: b.id }, (tx) => call(tx, b.id, ofB))).toBe(0);

    expect({ rows: await stored(b.id), counter: await counter(b.id) }).toEqual(before);
  });

  it("raises on a NULL workspace, a NULL list, a NULL element and more than 5 000 positions, and deletes nothing", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 2);
    const settings = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    const before = { rows: await stored(workspace.id), counter: await counter(workspace.id) };

    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_delete_many(NULL, '{}'::uuid[])`))).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_delete_many(${workspace.id}::uuid, NULL)`))).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(
      refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_delete_many(${workspace.id}::uuid, ${`{${ids[0] ?? ""},NULL}`}::uuid[])`)),
    ).resolves.toBe(INVALID_PARAMETER_VALUE);
    await expect(
      refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_delete_many(${workspace.id}::uuid, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 5001)))`)),
    ).resolves.toBe(INVALID_PARAMETER_VALUE);

    expect({ rows: await stored(workspace.id), counter: await counter(workspace.id) }).toEqual(before);
  });

  it("is the only way the application role deletes a bookmark or lowers the counter", async () => {
    const workspace = await workspaceOf();
    const [id] = await seedBookmarks(workspace, 1);
    const settings = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };

    expect(await refusedWith(appAs(settings, (tx) => tx`DELETE FROM bookmarks WHERE id = ${id ?? ""}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE workspaces SET bookmark_count = 0 WHERE id = ${workspace.id}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await stored(workspace.id)).map((row) => row.id)).toEqual([id]);
    expect(await counter(workspace.id)).toBe(1);
  });
});

describe("setPinned", () => {
  it("pins the caller's own bookmarks that are not pinned, leaves the ones that are with their time and version, and counts both", async () => {
    const workspace = await workspaceOf();
    const unpinned = await seedBookmarks(workspace, 2);
    const pinned = await seedBookmarks(workspace, 2, { pinned: true });
    const before = await stored(workspace.id);

    const count = await setPinned(workspace, [...unpinned, ...pinned], true);

    expect(count).toBe(4);
    const rows = await stored(workspace.id);
    for (const row of rows) {
      const earlier = before.find((candidate) => candidate.id === row.id);
      expect(row.pinned_at).not.toBeNull();
      if (pinned.includes(row.id)) {
        expect([row.pinned_at, row.version]).toEqual([earlier?.pinned_at, earlier?.version]);
      } else {
        expect(row.version).toBe((earlier?.version ?? 0) + 1);
      }
    }
  });

  it("unpins them the same way", async () => {
    const workspace = await workspaceOf();
    const pinned = await seedBookmarks(workspace, 2, { pinned: true });
    const unpinned = await seedBookmarks(workspace, 1);
    const before = await stored(workspace.id);

    expect(await setPinned(workspace, [...pinned, ...unpinned], false)).toBe(3);

    const rows = await stored(workspace.id);
    expect(rows.every((row) => row.pinned_at === null)).toBe(true);
    for (const row of rows) {
      const earlier = before.find((candidate) => candidate.id === row.id);
      expect(row.version).toBe((earlier?.version ?? 0) + (pinned.includes(row.id) ? 1 : 0));
    }
  });

  it("leaves another member's, another workspace's, a plan-archived and an unknown bookmark alone and does not count them", async () => {
    const workspace = await workspaceOf(2);
    const own = await seedBookmarks(workspace, 1);
    const others = await seedBookmarks(workspace, 1, { ownerIndex: 1 });
    const archived = await seedBookmarks(workspace, 1, { archived: true });
    const stranger = await workspaceOf();
    const foreign = await seedBookmarks(stranger, 1);
    const before = { workspace: await stored(workspace.id), stranger: await stored(stranger.id) };

    const count = await setPinned(workspace, [...own, ...others, ...archived, ...foreign, freshId()], true);

    expect(count).toBe(1);
    const rows = await stored(workspace.id);
    expect(rows.filter((row) => row.pinned_at !== null).map((row) => row.id)).toEqual(own);
    expect(rows.filter((row) => !own.includes(row.id))).toEqual(before.workspace.filter((row) => !own.includes(row.id)));
    expect(await stored(stranger.id)).toEqual(before.stranger);
  });

  it("refuses an owner other than the account of the transaction and a name that is not an identifier", async () => {
    const workspace = await workspaceOf(2);
    const ids = await seedBookmarks(workspace, 1, { ownerIndex: 1 });
    const settings = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };

    await expect(inTenant(settings, (tx) => bookmarkRepository(tx).setPinned({ bookmarkIds: ids, ownerId: memberOf(workspace, 1), pinned: true }))).rejects.toThrow("only the account of the transaction");
    await expect(inTenant(settings, (tx) => bookmarkRepository(tx).setPinned({ bookmarkIds: ["x"], ownerId: memberOf(workspace, 0), pinned: true }))).rejects.toThrow("identifiers only");
    expect((await stored(workspace.id)).every((row) => row.pinned_at === null)).toBe(true);
  });
});

describe("ids", () => {
  it("lists the caller's own bookmarks that are not plan-archived, newest first, that match the filter, up to the limit", async () => {
    const workspace = await workspaceOf(2);
    const own = await seedBookmarks(workspace, 3);
    const pinned = await seedBookmarks(workspace, 2, { pinned: true });
    await seedBookmarks(workspace, 2, { ownerIndex: 1 });
    await seedBookmarks(workspace, 2, { archived: true });
    const owner = memberOf(workspace, 0);
    const ids = (filter: { pinned?: boolean }, limit: number) =>
      inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).ids({ ownerId: owner, ...filter }, limit));

    expect((await ids({}, 100)).toSorted()).toEqual([...own, ...pinned].toSorted());
    expect((await ids({ pinned: true }, 100)).toSorted()).toEqual(pinned.toSorted());
    expect(await ids({ pinned: false }, 2)).toHaveLength(2);
    const newestFirst = await ids({}, 100);
    const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE id = ANY (${newestFirst}::uuid[]) ORDER BY created_at DESC, id DESC`);
    expect(newestFirst).toEqual(rows.map((row) => row.id));
  });
});

describe("against another bulk call, a single delete and a member's removal", () => {
  async function settle<T>(work: Promise<T>): Promise<T | string> {
    const code = await refusedWith(work.then(() => undefined));
    return code === undefined ? work : `error:${code}`;
  }

  it("runs bulk deletes and bulk pins over the same bookmarks, named in opposite orders, without a deadlock", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 40);
    const forward = ids;
    const backward = ids.toReversed();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const named = index % 2 === 0 ? forward : backward;
        return settle(index % 3 === 0 ? removeMany(workspace, named.slice(0, 5 + index)) : setPinned(workspace, named, index % 2 === 0));
      }),
    );

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    expect(await counter(workspace.id)).toBe((await stored(workspace.id)).filter((row) => !row.archived).length);
  }, 60_000);

  it("runs with single deletes of the same bookmarks, and the counter ends equal to the rows that are not archived", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const ids = await seedBookmarks(workspace, 12);
    await seedBookmarks(workspace, 3, { archived: true });

    const results = await Promise.all([
      settle(removeMany(workspace, ids.slice(0, 8))),
      ...ids.slice(4).map((bookmarkId) => settle(inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).remove({ bookmarkId, ownerId: owner })))),
    ]);

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    expect(await counter(workspace.id)).toBe(0);
    expect((await stored(workspace.id)).every((row) => row.archived)).toBe(true);
  }, 60_000);

  it("runs with the removal of a member, which clears the owner of the member's bookmarks, without a deadlock", async () => {
    const workspace = await workspaceOf(2);
    const admin = memberOf(workspace, 0);
    const member = memberOf(workspace, 1);
    const ids = await seedBookmarks(workspace, 5, { ownerIndex: 1 });

    let holds: () => void = () => undefined;
    const holdsWorkspace = new Promise<void>((resolve) => {
      holds = resolve;
    });
    const removed = settle(
      inTenant({ accountId: admin, workspaceId: workspace.id }, async (tx) => {
        const members = memberRepository(tx);
        await members.roles(member);
        holds();
        await tenantHandle(tx).execute(sql`SELECT pg_sleep(0.5)`);
        return members.remove(member, []);
      }),
    );
    await holdsWorkspace;
    // The bulk delete queues on the workspace's row, then finds the bookmarks ownerless: it deletes none.
    const deleted = await settle(removeMany(workspace, ids, 1));

    expect(await removed).toBe(true);
    expect(deleted).not.toBe(`error:${DEADLOCK_DETECTED}`);
    expect(deleted).toBe(0);
    expect((await stored(workspace.id)).every((row) => row.owner_id === null)).toBe(true);
    expect(await counter(workspace.id)).toBe(5);
  }, 30_000);
});
