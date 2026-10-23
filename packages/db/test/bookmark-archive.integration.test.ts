import { archiveBookmarks, BookmarkArchiveError, EntitlementVersionError, restoreBookmarks } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkArchiveTransaction, bookmarkRepository, memberRepository, type TenantTx } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle } from "../src/tenant.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Archiving and restoring bookmarks (doc 01 sections 7.5 and 13.3, doc 02 section 5.6, doc 05 sections 2.2 and 3.3, doc 10 T1 and
// T11). The failure scenarios: an archive state that moves without the counter of the bookmarks that are not archived, or without the
// entitlement version that keys the cache, or without its audit event; a repeated call that counts a bookmark twice; a list of
// identifiers that reaches another workspace's bookmarks; a transaction that archives in a workspace it does not act in, for an
// account that is no member of it, or in one that is being deleted; an event that carries a title or a URL; and a call that
// deadlocks against a delete or a member's removal.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
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
  await seedAccount(db, { id, email: `archive${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 1): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Archive test" });
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
  return db.tenant.withTenant({ ...tenant, requestId: "archive-test" }, work);
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

/** A bookmark the way a creation stores it, counted; the seeded ones are archived when `archived` is set and are then not counted. */
async function seedBookmarks(workspace: Workspace, count: number, options: { archived?: boolean; ownerIndex?: number } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = freshId();
    ids.push(id);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, pinned_at, plan_archived_at)
        VALUES (${id}, ${workspace.id}, ${memberOf(workspace, options.ownerIndex ?? 0)}, 'https://example.com/private-path', 'https://example.com/private-path', 'example.com',
                'A private title', 'A description', ${`slug-${id}`}, now(), ${options.archived === true ? new Date() : null})`,
    );
  }
  if (options.archived !== true) {
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = bookmark_count + ${count} WHERE id = ${workspace.id}`);
  }
  return ids;
}

interface Counters {
  readonly count: number;
  readonly version: number;
}

async function counters(workspaceId: string): Promise<Counters> {
  const rows = await asSystem(db, (tx) => tx<{ bookmark_count: number; entitlement_version: number }[]>`SELECT bookmark_count, entitlement_version FROM workspaces WHERE id = ${workspaceId}`);
  return { count: rows[0]?.bookmark_count ?? Number.NaN, version: rows[0]?.entitlement_version ?? Number.NaN };
}

interface Event {
  readonly action: string;
  readonly actor_type: string;
  readonly entity_type: string | null;
  readonly metadata: Record<string, string>;
}

async function events(workspaceId: string): Promise<Event[]> {
  return asSystem(
    db,
    (tx) => tx<Event[]>`SELECT action, actor_type, entity_type, metadata FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`,
  );
}

interface Stored {
  readonly id: string;
  readonly archived: boolean;
  readonly rest: string;
}

/** Every bookmark of the workspace: whether it is archived, and a digest of every column an archive must not touch. */
async function stored(workspaceId: string): Promise<Stored[]> {
  return asSystem(
    db,
    (tx) => tx<Stored[]>`
      SELECT id, plan_archived_at IS NOT NULL AS archived,
             md5(concat_ws('|', owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, open_count, last_opened_at, created_at)) AS rest
      FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`,
  );
}

let nextId = 0;
const newId = () => {
  nextId += 1;
  return `0192f3a0-bbbb-7000-8000-${nextId.toString(16).padStart(12, "0")}`;
};

const archive = (workspace: Workspace, bookmarkIds: readonly string[], accountIndex = 0) =>
  inTenant({ accountId: memberOf(workspace, accountIndex), workspaceId: workspace.id }, (tx) => archiveBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: workspace.id, bookmarkIds }));

const restore = (workspace: Workspace, bookmarkIds: readonly string[], accountIndex = 0) =>
  inTenant({ accountId: memberOf(workspace, accountIndex), workspaceId: workspace.id }, (tx) => restoreBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: workspace.id, bookmarkIds }));

describe("archiving and restoring", () => {
  it("archives the given bookmarks, lowers the counter by the rows that changed, raises the entitlement version once and writes one event with the count", async () => {
    const workspace = await workspaceOf(2);
    const ids = await seedBookmarks(workspace, 4, { ownerIndex: 1 });
    const before = await counters(workspace.id);
    const rowsBefore = await stored(workspace.id);

    const result = await archive(workspace, [ids[0] ?? "", ids[1] ?? ""]);

    expect(result).toEqual({ archived: 2 });
    expect(await counters(workspace.id)).toEqual({ count: before.count - 2, version: before.version + 1 });
    const rows = await stored(workspace.id);
    expect(rows.map((row) => [row.id, row.archived])).toEqual(rowsBefore.map((row) => [row.id, ids.indexOf(row.id) < 2]));
    // Nothing but the archive state moved: not the pin, the slug, the owner, the destination or the usage of a bookmark, whoever owns it.
    expect(rows.map((row) => row.rest)).toEqual(rowsBefore.map((row) => row.rest));
    expect(await events(workspace.id)).toEqual([{ action: "bookmark.archived", actor_type: "system", entity_type: null, metadata: { count: "2" } }]);
  });

  it("restores them, raises the counter by the rows that changed and writes one event with the count", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 3);
    await archive(workspace, ids);
    const archived = await counters(workspace.id);
    expect(archived.count).toBe(0);

    const result = await restore(workspace, [ids[0] ?? "", ids[2] ?? ""]);

    expect(result).toEqual({ restored: 2 });
    expect(await counters(workspace.id)).toEqual({ count: 2, version: archived.version + 1 });
    expect((await stored(workspace.id)).map((row) => [row.id, row.archived])).toEqual(ids.map((id) => [id, id === ids[1]]));
    expect((await events(workspace.id)).map((event) => [event.action, event.metadata])).toEqual([
      ["bookmark.archived", { count: "3" }],
      ["bookmark.restored", { count: "2" }],
    ]);
  });

  it("raises the entitlement version exactly once per service call, never in the repository or the system operation, so a caller that wrapped it would see two", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 3);
    const settings = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    const start = await counters(workspace.id);

    // The repository and the system operation move the counter and leave the version where it was.
    expect(await inTenant(settings, (tx) => bookmarkRepository(tx).setArchived({ bookmarkIds: [ids[0] ?? ""], archived: true }))).toBe(1);
    expect(await counters(workspace.id)).toEqual({ count: start.count - 1, version: start.version });
    await inTenant(settings, (tx) => tenantHandle(tx).execute(sql`SELECT public.sys_bookmark_archive_set(${workspace.id}::uuid, ${`{${ids[1] ?? ""}}`}::uuid[], true)`));
    expect(await counters(workspace.id)).toEqual({ count: start.count - 2, version: start.version });

    // Each service call raises it by one: the version after n calls is the version before plus n.
    await restore(workspace, ids);
    expect(await counters(workspace.id)).toEqual({ count: start.count, version: start.version + 1 });
    await archive(workspace, ids);
    expect(await counters(workspace.id)).toEqual({ count: start.count - 3, version: start.version + 2 });
    await restore(workspace, [ids[0] ?? ""]);
    expect(await counters(workspace.id)).toEqual({ count: start.count - 2, version: start.version + 3 });
  });

  it("is idempotent: a repeated archive and a repeated restore change no bookmark and no counter, and each still writes its own event with a count of zero", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 3);

    expect(await archive(workspace, ids)).toEqual({ archived: 3 });
    const once = await counters(workspace.id);
    const rowsOnce = await stored(workspace.id);
    expect(await archive(workspace, ids)).toEqual({ archived: 0 });
    expect(await counters(workspace.id)).toEqual({ count: once.count, version: once.version + 1 });
    expect(await stored(workspace.id)).toEqual(rowsOnce);

    expect(await restore(workspace, ids)).toEqual({ restored: 3 });
    const restored = await counters(workspace.id);
    expect(restored.count).toBe(3);
    expect(await restore(workspace, ids)).toEqual({ restored: 0 });
    expect(await counters(workspace.id)).toEqual({ count: 3, version: restored.version + 1 });

    expect((await events(workspace.id)).map((event) => [event.action, event.metadata.count])).toEqual([
      ["bookmark.archived", "3"],
      ["bookmark.archived", "0"],
      ["bookmark.restored", "3"],
      ["bookmark.restored", "0"],
    ]);
  });

  it("counts only the bookmarks whose state changed when the list mixes archived and live ones", async () => {
    const workspace = await workspaceOf();
    const live = await seedBookmarks(workspace, 2);
    const archived = await seedBookmarks(workspace, 2, { archived: true });
    const before = await counters(workspace.id);

    expect(await archive(workspace, [...live, ...archived])).toEqual({ archived: 2 });
    expect(await counters(workspace.id)).toEqual({ count: before.count - 2, version: before.version + 1 });

    expect(await restore(workspace, [...live, ...archived])).toEqual({ restored: 4 });
    expect((await counters(workspace.id)).count).toBe(before.count + 2);
    expect((await events(workspace.id)).map((event) => event.metadata.count)).toEqual(["2", "4"]);
  });

  it("ignores identifiers of another workspace, identifiers that are not bookmarks and repeated ones, and leaves the other workspace as it was", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const ofA = await seedBookmarks(a, 2);
    const ofB = await seedBookmarks(b, 2);
    const beforeB = { counters: await counters(b.id), rows: await stored(b.id), events: await events(b.id) };

    const result = await archive(a, [...ofB, freshId(), "not-an-identifier", "", ofA[0] ?? "", ofA[0] ?? "", (ofA[0] ?? "").toUpperCase()]);

    expect(result).toEqual({ archived: 1 });
    expect({ counters: await counters(b.id), rows: await stored(b.id), events: await events(b.id) }).toEqual(beforeB);
    expect((await counters(a.id)).count).toBe(1);
    expect((await events(a.id)).map((event) => event.metadata)).toEqual([{ count: "1" }]);

    expect(await restore(a, ofB)).toEqual({ restored: 0 });
    expect({ counters: await counters(b.id), rows: await stored(b.id), events: await events(b.id) }).toEqual(beforeB);
  });

  it("accepts an empty list: nothing changes but the version and the event", async () => {
    const workspace = await workspaceOf();
    await seedBookmarks(workspace, 1);
    const before = await counters(workspace.id);

    expect(await archive(workspace, [])).toEqual({ archived: 0 });

    expect(await counters(workspace.id)).toEqual({ count: before.count, version: before.version + 1 });
    expect((await events(workspace.id)).map((event) => event.metadata)).toEqual([{ count: "0" }]);
  });

  it("writes an event that carries the count and no title, address or identifier of a bookmark", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 2);
    await archive(workspace, ids);

    const rows = await asSystem(db, (tx) => tx<{ row: string }[]>`SELECT audit_events::text AS row FROM audit_events WHERE workspace_id = ${workspace.id}`);

    expect(rows).toHaveLength(1);
    const text = rows[0]?.row ?? "";
    expect(text).not.toContain("A private title");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("slug-");
    for (const id of ids) {
      expect(text).not.toContain(id);
    }
  });

  it("archives thousands of identifiers in one call", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 3);
    const strangers = Array.from({ length: 70_000 }, () => freshId());

    expect(await archive(workspace, [...strangers, ...ids])).toEqual({ archived: 3 });
  }, 60_000);
});

describe("a workspace the transaction cannot change", () => {
  async function untouched(workspace: Workspace, work: () => Promise<unknown>): Promise<void> {
    const before = { counters: await counters(workspace.id), rows: await stored(workspace.id), events: await events(workspace.id) };
    await expect(work()).rejects.toThrow(BookmarkArchiveError);
    expect({ counters: await counters(workspace.id), rows: await stored(workspace.id), events: await events(workspace.id) }).toEqual(before);
  }

  it("refuses a request for a workspace other than the one the transaction acts in, and writes nothing in either", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const ofB = await seedBookmarks(b, 2);
    const ofA = await seedBookmarks(a, 1);

    await untouched(b, () => inTenant({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => archiveBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: b.id, bookmarkIds: ofB })));
    await untouched(a, () => inTenant({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => archiveBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: b.id, bookmarkIds: ofA })));
  });

  it("refuses an account-level transaction, one for an account that is no member of the workspace, and a workspace being deleted", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 2);
    const stranger = await account();
    const owner = memberOf(workspace, 0);

    await untouched(workspace, () => inTenant({ accountId: owner }, (tx) => archiveBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: workspace.id, bookmarkIds: ids })));
    await untouched(workspace, () => inTenant({ accountId: stranger, workspaceId: workspace.id }, (tx) => archiveBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: workspace.id, bookmarkIds: ids })));
    await untouched(workspace, () => inTenant({ accountId: stranger, workspaceId: workspace.id }, (tx) => restoreBookmarks(bookmarkArchiveTransaction(tx, newId), { workspaceId: workspace.id, bookmarkIds: ids })));

    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspace.id}`);
    await untouched(workspace, () => archive(workspace, ids));
  });

  it("rolls the rows, the counter and the version back when the audit event cannot be written", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 2);
    const before = { counters: await counters(workspace.id), rows: await stored(workspace.id) };

    const failure = new Error("the audit store is down");
    await expect(
      inTenant({ accountId: memberOf(workspace, 0), workspaceId: workspace.id }, (tx) =>
        archiveBookmarks({ ...bookmarkArchiveTransaction(tx, newId), audit: { write: () => Promise.reject(failure) } }, { workspaceId: workspace.id, bookmarkIds: ids }),
      ),
    ).rejects.toBe(failure);

    expect({ counters: await counters(workspace.id), rows: await stored(workspace.id) }).toEqual(before);
    expect(await events(workspace.id)).toEqual([]);
  });

  it("rolls the rows and the counter back when the entitlement version cannot be raised", async () => {
    const workspace = await workspaceOf();
    const ids = await seedBookmarks(workspace, 2);
    const before = { counters: await counters(workspace.id), rows: await stored(workspace.id) };

    await expect(
      inTenant({ accountId: memberOf(workspace, 0), workspaceId: workspace.id }, (tx) =>
        archiveBookmarks({ ...bookmarkArchiveTransaction(tx, newId), entitlementVersion: { bump: () => Promise.resolve(undefined) } }, { workspaceId: workspace.id, bookmarkIds: ids }),
      ),
    ).rejects.toThrow(EntitlementVersionError);

    expect({ counters: await counters(workspace.id), rows: await stored(workspace.id) }).toEqual(before);
    expect(await events(workspace.id)).toEqual([]);
  });

  it("refuses a repository call without a workspace", async () => {
    const workspace = await workspaceOf();
    await expect(inTenant({ accountId: memberOf(workspace, 0) }, (tx) => bookmarkRepository(tx).setArchived({ bookmarkIds: [], archived: true }))).rejects.toThrow("tenant transaction opened with a workspace");
  });
});

describe("the system operation", () => {
  /** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no service, no application layer. */
  async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
      return { value: await work(tx) };
    });
    return result.value;
  }

  const call = (tx: postgres.TransactionSql, workspaceId: string, ids: readonly string[], archive: boolean) =>
    tx<{ changed: number | null }[]>`SELECT public.sys_bookmark_archive_set(${workspaceId}::uuid, ${`{${ids.join(",")}}`}::uuid[], ${archive}::boolean) AS changed`.then((rows) => rows[0]?.changed);

  it("leaves another workspace's bookmarks, counter and version alone when the transaction acts in a different one (the RLS-only path)", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const ofB = await seedBookmarks(b, 2);
    const beforeB = { counters: await counters(b.id), rows: await stored(b.id) };

    // Acting in A and naming B: the function answers NULL, writing nothing.
    expect(await appAs({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => call(tx, b.id, ofB, true))).toBeNull();
    // Acting in A and naming A with B's bookmarks: the rows are not A's, so none changes.
    expect(await appAs({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => call(tx, a.id, ofB, true))).toBe(0);
    // A member of B acting in no workspace, or in B for a workspace that is A's.
    expect(await appAs({ accountId: memberOf(b, 0) }, (tx) => call(tx, b.id, ofB, true))).toBeNull();
    expect(await appAs({ accountId: memberOf(b, 0), workspaceId: b.id }, (tx) => call(tx, a.id, ofB, true))).toBeNull();
    // An account that is no member of B, acting in B.
    expect(await appAs({ accountId: memberOf(a, 0), workspaceId: b.id }, (tx) => call(tx, b.id, ofB, true))).toBeNull();

    expect({ counters: await counters(b.id), rows: await stored(b.id) }).toEqual(beforeB);
  });

  it("raises on a NULL argument", async () => {
    const workspace = await workspaceOf();
    const settings = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_archive_set(NULL, '{}'::uuid[], true)`))).resolves.toBe("22023");
    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_archive_set(${workspace.id}::uuid, NULL, true)`))).resolves.toBe("22023");
    await expect(refusedWith(appAs(settings, (tx) => tx`SELECT public.sys_bookmark_archive_set(${workspace.id}::uuid, '{}'::uuid[], NULL)`))).resolves.toBe("22023");
  });

  it("is the only way the application role moves the archive state, the counter or the entitlement version", async () => {
    const workspace = await workspaceOf();
    const [id] = await seedBookmarks(workspace, 1);
    const settings = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };

    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${id ?? ""}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE workspaces SET bookmark_count = 0 WHERE id = ${workspace.id}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(settings, (tx) => tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = ${workspace.id}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await stored(workspace.id)).map((row) => row.archived)).toEqual([false]);
  });
});

describe("against a delete and a member's removal", () => {
  /** The value of `work`, or `error:<SQLSTATE>` when it fails, so a test can name the code a loser of a deadlock gets. */
  async function settle<T>(work: Promise<T>): Promise<T | string> {
    const code = await refusedWith(work.then(() => undefined));
    return code === undefined ? work : `error:${code}`;
  }

  it("runs with a delete of a live bookmark and of an archived one without a deadlock, and the counter ends equal to the rows that are not archived", async () => {
    const workspace = await workspaceOf(2);
    const member = memberOf(workspace, 1);
    const toArchive = await seedBookmarks(workspace, 10, { ownerIndex: 0 });
    const toDelete = await seedBookmarks(workspace, 5, { ownerIndex: 1 });
    const archivedToDelete = await seedBookmarks(workspace, 5, { ownerIndex: 1, archived: true });

    const results = await Promise.all([
      settle(archive(workspace, [...toArchive, ...toDelete])),
      ...[...toDelete, ...archivedToDelete].map((bookmarkId) =>
        settle(inTenant({ accountId: member, workspaceId: workspace.id }, async (tx) => (await sleep(Math.random() * 20), bookmarkRepository(tx).remove({ bookmarkId, ownerId: member })))),
      ),
    ]);

    expect(results.filter((result) => typeof result === "string")).toEqual([]);
    const rows = await stored(workspace.id);
    expect((await counters(workspace.id)).count).toBe(rows.filter((row) => !row.archived).length);
  }, 30_000);

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
        await sleep(500);
        return members.remove(member, []);
      }),
    );
    await holdsWorkspace;
    const archived = await settle(archive(workspace, ids));

    expect(await removed).toBe(true);
    expect(archived).toEqual({ archived: 5 });
    expect(archived).not.toBe(`error:${DEADLOCK_DETECTED}`);
    expect(await counters(workspace.id)).toMatchObject({ count: 0 });
    expect((await stored(workspace.id)).every((row) => row.archived)).toBe(true);
  }, 30_000);

  it("runs with an update of a bookmark that it archives, which waits for the update and does not deadlock", async () => {
    const workspace = await workspaceOf(2);
    const owner = memberOf(workspace, 0);
    const [id] = await seedBookmarks(workspace, 1);

    const changed = settle(
      inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
        const result = await bookmarkRepository(tx).update({ bookmarkId: id ?? "", ownerId: owner, expectedVersions: undefined, changes: { title: "Edited" } });
        await sleep(300);
        return result.kind;
      }),
    );
    await sleep(100);
    const archived = await settle(archive(workspace, [id ?? ""]));

    expect(await changed).toBe("updated");
    expect(archived).toEqual({ archived: 1 });
    expect(await counters(workspace.id)).toMatchObject({ count: 0 });
  }, 30_000);
});
