import type { NewBookmark } from "@slugbase/core";
import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, bookmarkRepository, instanceRepository, isBookmarkSlugTaken, memberRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The slug and the forwarding flag of a bookmark (doc 05 section 2.4, doc 02 sections 3.5 and 6.1, doc 10 T1, T2 and T12). The failure
// scenarios: two requests that set one slug on two bookmarks of one owner at once, which must make one success and one refusal and never two
// rows; two members who each own `mail` and both leave, which the unique key of the ownerless namespace would refuse with 23505 for the second;
// a slug that is free the moment its bookmark is deleted; a lookup of a slug that is a filter over the workspace's rows and not an index
// condition under row-level security.

const HOOK_TIMEOUT_MS = 300_000;
const SECRET = Buffer.from("sealed-totp-secret");
const UNIQUE_VIOLATION = "23505";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(options: { admin?: boolean } = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `bookmark-slugs${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", isInstanceAdmin: options.admin === true, emailVerified: true });
  if (options.admin === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${SECRET}, mfa_secret_key_id = 'key-1', mfa_last_step = 42 WHERE id = ${id}`;
    });
  }
  return id;
}

interface Workspace {
  readonly id: string;
  readonly owner: string;
  /** Members who are not the owner, and who may leave. */
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 2): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Slugs test" });
  const owner = await account();
  await seedMember(db, { workspaceId: id, accountId: owner, role: "owner" });
  const members: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const accountId = await account();
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
    members.push(accountId);
  }
  return { id, owner, members };
}

function memberOf(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member;
}

function inTenant<T>(workspace: Workspace, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId: workspace.id, requestId: "bookmark-slugs-test" }, work);
}

function newBookmark(ownerId: string, overrides: Partial<NewBookmark> = {}): NewBookmark {
  return { id: freshId(), ownerId, url: "https://example.com/docs", urlCanonical: "https://example.com/docs", host: "example.com", title: "Docs", description: null, pinned: false, ...overrides };
}

async function create(workspace: Workspace, ownerId: string, overrides: Partial<NewBookmark> = {}) {
  const bookmark = newBookmark(ownerId, overrides);
  const result = await inTenant(workspace, ownerId, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [] }));
  return { id: bookmark.id, result };
}

async function seedBookmark(workspaceId: string, ownerId: string | null, slug: string | null, forwarding = false): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed', ${slug}, ${forwarding})`,
  );
  return id;
}

interface Stored {
  readonly id: string;
  readonly owner_id: string | null;
  readonly url: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly version: number;
}

async function stored(workspaceId: string): Promise<Stored[]> {
  return asSystem(db, (tx) => tx<Stored[]>`SELECT id, owner_id, url, slug, forwarding, version FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`);
}

async function withSlug(workspaceId: string, slug: string): Promise<Stored[]> {
  return (await stored(workspaceId)).filter((row) => row.slug === slug);
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

describe("the table", () => {
  it("stores the slug as text, with the unique key of the owner's namespace and the index the go lookup reads", async () => {
    const [column] = await db.owner<{ data_type: string }[]>`SELECT data_type FROM information_schema.columns WHERE table_name = 'bookmarks' AND column_name = 'slug'`;
    expect(column?.data_type).toBe("text");
    const indexes = await db.owner<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'bookmarks' AND indexname IN ('bookmarks_owner_slug_key', 'bookmarks_slug_idx') ORDER BY indexname`;
    expect(indexes.map((row) => row.indexname)).toEqual(["bookmarks_owner_slug_key", "bookmarks_slug_idx"]);
    expect(indexes[0]?.indexdef).toMatch(/^CREATE UNIQUE INDEX bookmarks_owner_slug_key ON public\.bookmarks USING btree \(workspace_id, owner_id, slug\) NULLS NOT DISTINCT WHERE \(slug IS NOT NULL\)$/);
    expect(indexes[1]?.indexdef).toMatch(/^CREATE INDEX bookmarks_slug_idx ON public\.bookmarks USING btree \(workspace_id, slug\) INCLUDE \(id, owner_id, url, forwarding, plan_archived_at\) WHERE \(slug IS NOT NULL\)$/);
    const invalid = await db.owner<{ n: string }[]>`SELECT count(*)::text AS n FROM pg_index WHERE indrelid = 'public.bookmarks'::regclass AND NOT indisvalid`;
    expect(invalid[0]?.n).toBe("0");
  });

  it("keeps the search document of a bookmark with its slug after the column changed type", async () => {
    const workspace = await workspaceOf(1);
    const slugged = await seedBookmark(workspace.id, memberOf(workspace, 0), "quarterly-plan");
    const matches = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspace.id} AND search @@ to_tsquery('simple', 'quarterly-plan')`);
    expect(matches.map((row) => row.id)).toEqual([slugged]);
  });

  it("refuses two bookmarks of one owner with one slug, lets two owners share it and counts the ownerless as one owner", async () => {
    const workspace = await workspaceOf(2);
    await seedBookmark(workspace.id, memberOf(workspace, 0), "mail");
    expect(await refusedWith(seedBookmark(workspace.id, memberOf(workspace, 0), "mail"))).toBe(UNIQUE_VIOLATION);
    expect(await refusedWith(seedBookmark(workspace.id, memberOf(workspace, 1), "mail"))).toBeUndefined();
    expect(await refusedWith(seedBookmark(workspace.id, null, "mail"))).toBeUndefined();
    expect(await refusedWith(seedBookmark(workspace.id, null, "mail"))).toBe(UNIQUE_VIOLATION);
    // Bookmarks without a slug never meet the key, whoever owns them.
    expect(await refusedWith(seedBookmark(workspace.id, memberOf(workspace, 0), null))).toBeUndefined();
    expect(await refusedWith(seedBookmark(workspace.id, memberOf(workspace, 0), null))).toBeUndefined();
    expect(await refusedWith(seedBookmark(workspace.id, null, null))).toBeUndefined();
    expect(await refusedWith(seedBookmark(workspace.id, null, null))).toBeUndefined();
    // Another workspace is another namespace.
    const other = await workspaceOf(1);
    expect(await refusedWith(seedBookmark(other.id, memberOf(other, 0), "mail"))).toBeUndefined();
  });
});

describe("create", () => {
  it("stores the slug and forwarding of a new bookmark and reads them back", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    const { id, result } = await create(workspace, owner, { slug: "mail", forwarding: true });

    expect(result.kind).toBe("created");
    if (result.kind !== "created") {
      return;
    }
    expect(result.bookmark).toMatchObject({ id, slug: "mail", forwarding: true, version: 1 });
    expect(await inTenant(workspace, owner, (tx) => bookmarkRepository(tx).find(id))).toEqual(result.bookmark);
    const plain = await create(workspace, owner, {});
    expect(plain.result.kind === "created" ? plain.result.bookmark : undefined).toMatchObject({ slug: null, forwarding: false });
    const noForwarding = await create(workspace, owner, { slug: "later", forwarding: false });
    expect(noForwarding.result.kind === "created" ? noForwarding.result.bookmark : undefined).toMatchObject({ slug: "later", forwarding: false });
  });

  it("answers slug_taken for a slug the owner already uses, takes no place and writes nothing, and lets another member have it", async () => {
    const workspace = await workspaceOf(2);
    const [first, second] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    await create(workspace, first, { slug: "mail", forwarding: true });
    const before = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspace.id}`);

    const again = await create(workspace, first, { slug: "mail", forwarding: true });
    const shared = await create(workspace, second, { slug: "mail", forwarding: true });

    expect(again.result).toEqual({ kind: "slug_taken" });
    expect(shared.result.kind).toBe("created");
    expect((await stored(workspace.id)).map((row) => row.id)).not.toContain(again.id);
    expect(await withSlug(workspace.id, "mail")).toHaveLength(2);
    const after = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspace.id}`);
    expect(after[0]?.bookmark_count).toBe((before[0]?.bookmark_count ?? 0) + 1);
  });

  it("frees the slug at once when its bookmark is deleted", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const first = await create(workspace, owner, { slug: "mail", forwarding: true });
    expect((await create(workspace, owner, { slug: "mail", forwarding: true })).result).toEqual({ kind: "slug_taken" });

    expect(await inTenant(workspace, owner, (tx) => bookmarkRepository(tx).remove({ bookmarkId: first.id, ownerId: owner }))).toBe(true);

    expect((await create(workspace, owner, { slug: "mail", forwarding: true })).result.kind).toBe("created");
  });

  it("makes one success and one refusal, and one row, of two creations that set one slug at once", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const slow = newBookmark(owner, { slug: "race", forwarding: true });
    const fast = newBookmark(owner, { slug: "race", forwarding: true });

    // The first holds its transaction open after its insert, so the second runs while the first's row is not committed: the look for another bookmark
    // with the slug finds none, and the second meets the unique key when the first commits.
    const first = inTenant(workspace, owner, async (tx) => {
      const created = await bookmarkRepository(tx).create({ bookmark: slow, ceiling: null, jobs: [] });
      await sleep(400);
      return created;
    });
    await sleep(100);
    const second = inTenant(workspace, owner, (tx) => bookmarkRepository(tx).create({ bookmark: fast, ceiling: null, jobs: [] }));
    const [one, two] = await Promise.allSettled([first, second]);

    expect(one.status === "fulfilled" ? one.value.kind : "rejected").toBe("created");
    expect(two.status).toBe("rejected");
    expect(two.status === "rejected" && isBookmarkSlugTaken(two.reason)).toBe(true);
    expect((await withSlug(workspace.id, "race")).map((row) => row.id)).toEqual([slow.id]);
    const count = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspace.id}`);
    expect(count[0]?.bookmark_count).toBe(1);
  });
});

describe("update", () => {
  async function created(workspace: Workspace, owner: string, overrides: Partial<NewBookmark> = {}): Promise<string> {
    const { id, result } = await create(workspace, owner, overrides);
    expect(result.kind).toBe("created");
    return id;
  }

  const change = (workspace: Workspace, owner: string, bookmarkId: string, changes: { slug?: string | null; forwarding?: boolean }, expectedVersions?: number[]) =>
    inTenant(workspace, owner, (tx) => bookmarkRepository(tx).update({ bookmarkId, ownerId: owner, changes, expectedVersions }));

  it("sets, changes and clears the slug, and turns forwarding off and on, moving the version each time", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const id = await created(workspace, owner);

    const set = await change(workspace, owner, id, { slug: "mail", forwarding: true });
    expect(set.kind === "updated" ? set.bookmark : undefined).toMatchObject({ slug: "mail", forwarding: true, version: 2 });
    const renamed = await change(workspace, owner, id, { slug: "inbox" });
    expect(renamed.kind === "updated" ? renamed.bookmark : undefined).toMatchObject({ slug: "inbox", forwarding: true, version: 3 });
    const off = await change(workspace, owner, id, { forwarding: false });
    expect(off.kind === "updated" ? off.bookmark : undefined).toMatchObject({ slug: "inbox", forwarding: false, version: 4 });
    const on = await change(workspace, owner, id, { forwarding: true });
    expect(on.kind === "updated" ? on.bookmark : undefined).toMatchObject({ slug: "inbox", forwarding: true, version: 5 });
    const cleared = await change(workspace, owner, id, { slug: null, forwarding: false });
    expect(cleared.kind === "updated" ? cleared.bookmark : undefined).toMatchObject({ slug: null, forwarding: false, version: 6 });
    const unchanged = await change(workspace, owner, id, { slug: null, forwarding: false });
    expect(unchanged.kind === "unchanged" ? unchanged.bookmark : undefined).toMatchObject({ slug: null, forwarding: false, version: 6 });
  });

  it("refuses forwarding without a slug, in either direction, and writes nothing", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const forwarding = await created(workspace, owner, { slug: "mail", forwarding: true });
    const plain = await created(workspace, owner);

    // Clearing the slug while forwarding stays on.
    expect(await change(workspace, owner, forwarding, { slug: null })).toEqual({ kind: "forwarding_requires_slug" });
    expect(await change(workspace, owner, forwarding, { slug: null, forwarding: true })).toEqual({ kind: "forwarding_requires_slug" });
    // Turning forwarding on for a bookmark that has no slug.
    expect(await change(workspace, owner, plain, { forwarding: true })).toEqual({ kind: "forwarding_requires_slug" });

    const rows = await stored(workspace.id);
    expect(rows.find((row) => row.id === forwarding)).toMatchObject({ slug: "mail", forwarding: true, version: 1 });
    expect(rows.find((row) => row.id === plain)).toMatchObject({ slug: null, forwarding: false, version: 1 });
  });

  it("answers slug_taken for a slug the owner has on another bookmark, also a plan-archived one, and writes nothing", async () => {
    const workspace = await workspaceOf(2);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    await created(workspace, owner, { slug: "mail", forwarding: true });
    const archived = await seedBookmark(workspace.id, owner, "old", true);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${archived}`);
    const mine = await created(workspace, owner);
    const theirs = await created(workspace, other);

    expect(await change(workspace, owner, mine, { slug: "mail" })).toEqual({ kind: "slug_taken" });
    expect(await change(workspace, owner, mine, { slug: "old" })).toEqual({ kind: "slug_taken" });
    const shared = await change(workspace, other, theirs, { slug: "mail", forwarding: true });

    expect(shared.kind).toBe("updated");
    expect((await stored(workspace.id)).find((row) => row.id === mine)).toMatchObject({ slug: null, version: 1 });
  });

  it("leaves a bookmark that keeps its own slug as it is", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const id = await created(workspace, owner, { slug: "mail", forwarding: true });

    const same = await change(workspace, owner, id, { slug: "mail", forwarding: true });

    expect(same.kind).toBe("unchanged");
  });

  it("makes one success and one refusal, and one row, of two changes that set one slug on two bookmarks of an owner at once", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const a = await created(workspace, owner);
    const b = await created(workspace, owner);

    // The first holds its transaction open after its update, so the second's look for another bookmark with the slug finds none and its update waits
    // on the unique key until the first commits.
    const first = inTenant(workspace, owner, async (tx) => {
      const result = await bookmarkRepository(tx).update({ bookmarkId: a, ownerId: owner, changes: { slug: "race", forwarding: true }, expectedVersions: undefined });
      await sleep(400);
      return result;
    });
    await sleep(100);
    const second = change(workspace, owner, b, { slug: "race", forwarding: true });
    const [one, two] = await Promise.allSettled([first, second]);

    expect(one.status === "fulfilled" ? one.value.kind : "rejected").toBe("updated");
    expect(two.status).toBe("rejected");
    expect(two.status === "rejected" && isBookmarkSlugTaken(two.reason)).toBe(true);
    expect((await withSlug(workspace.id, "race")).map((row) => row.id)).toEqual([a]);
    expect((await stored(workspace.id)).find((row) => row.id === b)).toMatchObject({ slug: null, forwarding: false, version: 1 });
  });
});

describe("slugUse", () => {
  it("tells whether the owner has the slug on another bookmark and counts the others' bookmarks that are not plan-archived, ownerless ones included", async () => {
    const workspace = await workspaceOf(3);
    const [me, one, two] = [memberOf(workspace, 0), memberOf(workspace, 1), memberOf(workspace, 2)];
    const mine = await seedBookmark(workspace.id, me, "mail", true);
    await seedBookmark(workspace.id, one, "mail", true);
    const gone = await seedBookmark(workspace.id, two, "mail", true);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${gone}`);
    await seedBookmark(workspace.id, null, "mail", true);
    await seedBookmark(workspace.id, one, "other", true);
    const use = (slug: string, exceptBookmarkId?: string) => inTenant(workspace, me, (tx) => bookmarkRepository(tx).slugUse({ slug, ownerId: me, exceptBookmarkId }));

    expect(await use("mail")).toEqual({ takenByOwner: true, othersUseCount: 2 });
    expect(await use("mail", mine)).toEqual({ takenByOwner: false, othersUseCount: 2 });
    expect(await use("other")).toEqual({ takenByOwner: false, othersUseCount: 1 });
    expect(await use("nobody")).toEqual({ takenByOwner: false, othersUseCount: 0 });
  });

  it("counts the caller's plan-archived bookmark as theirs, since the key of the table counts it, and never reaches another workspace", async () => {
    const workspace = await workspaceOf(1);
    const other = await workspaceOf(1);
    const me = memberOf(workspace, 0);
    const archived = await seedBookmark(workspace.id, me, "mail", true);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${archived}`);
    await seedBookmark(other.id, memberOf(other, 0), "elsewhere", true);

    expect(await inTenant(workspace, me, (tx) => bookmarkRepository(tx).slugUse({ slug: "mail", ownerId: me, exceptBookmarkId: undefined }))).toEqual({ takenByOwner: true, othersUseCount: 0 });
    expect(await inTenant(workspace, me, (tx) => bookmarkRepository(tx).slugUse({ slug: "elsewhere", ownerId: me, exceptBookmarkId: undefined }))).toEqual({ takenByOwner: false, othersUseCount: 0 });
  });

  it("refuses to read the use of a slug for an account other than the one of the transaction", async () => {
    const workspace = await workspaceOf(2);
    const [me, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];

    await expect(inTenant(workspace, me, (tx) => bookmarkRepository(tx).slugUse({ slug: "mail", ownerId: other, exceptBookmarkId: undefined }))).rejects.toThrow("only the account of the transaction");
  });
});

describe("the lookup of a slug under row-level security", () => {
  it("is an index condition of bookmarks_slug_idx, which a citext comparison could not be", async () => {
    const workspace = await workspaceOf(2);
    for (let index = 0; index < 30; index += 1) {
      await seedBookmark(workspace.id, memberOf(workspace, index % 2), `slug-${String(index)}`, true);
    }
    await asSystem(db, (tx) => tx`ANALYZE bookmarks`);

    const plan = await db.app.begin(async (tx: postgres.TransactionSql) => {
      await tx`SELECT set_config('app.account_id', ${memberOf(workspace, 0)}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      return tx<{ "QUERY PLAN": string }[]>`EXPLAIN (COSTS OFF) SELECT id, owner_id, url, forwarding FROM bookmarks WHERE workspace_id = ${workspace.id}::uuid AND slug = ${"slug-3"} AND plan_archived_at IS NULL`;
    });

    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index (Only )?Scan using bookmarks_slug_idx on bookmarks/);
    expect(text).toMatch(/Index Cond:.*\(slug = 'slug-3'::text\)/);
  });
});

type Path = "account deletion" | "member removal" | "instance account deletion" | "direct delete";

async function depart(path: Path, workspace: Workspace, member: string): Promise<void> {
  if (path === "account deletion") {
    expect(await db.tenant.withTenant({ accountId: member, requestId: "bookmark-slugs-test" }, (tx) => accountDeletionRepository(tx).delete([], []))).toBe(true);
  } else if (path === "member removal") {
    expect(await db.tenant.withTenant({ accountId: workspace.owner, workspaceId: workspace.id, requestId: "bookmark-slugs-test" }, (tx) => memberRepository(tx).remove(member, []))).toBe(true);
  } else if (path === "instance account deletion") {
    const admin = await account({ admin: true });
    const outcome = await db.tenant.withTenant({ accountId: admin, requestId: "bookmark-slugs-test" }, async (tx) => {
      const repository = instanceRepository(tx);
      const scope = await repository.accountDeletionScope(member);
      if (scope.kind !== "ok") {
        return scope.kind;
      }
      return repository.deleteAccount({ accountId: member, soleWorkspaceIds: [], eventId: freshId(), ipPrefix: "10.1.0.0/16" }, []);
    });
    expect(outcome).toBe("deleted");
  } else {
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${member}`);
  }
}

describe("a member who leaves with a slug an ownerless bookmark already holds", () => {
  it.each<Path>(["account deletion", "member removal", "instance account deletion", "direct delete"])(
    "lets both of two members who each own mail leave on %s, and clears the slug of the second only",
    async (path) => {
      const workspace = await workspaceOf(2);
      const first = await seedBookmark(workspace.id, memberOf(workspace, 0), "mail", true);
      const second = await seedBookmark(workspace.id, memberOf(workspace, 1), "mail", true);

      await depart(path, workspace, memberOf(workspace, 0));
      await depart(path, workspace, memberOf(workspace, 1));

      const rows = await stored(workspace.id);
      expect(rows.find((row) => row.id === first)).toMatchObject({ owner_id: null, url: "https://example.com/seed", slug: "mail", forwarding: true });
      expect(rows.find((row) => row.id === second)).toMatchObject({ owner_id: null, url: "https://example.com/seed", slug: null, forwarding: false });
    },
  );

  it("keeps the slugs that collide with nothing, and every other column, and moves the version of the bookmark that changed", async () => {
    const workspace = await workspaceOf(2);
    const member = memberOf(workspace, 0);
    await seedBookmark(workspace.id, null, "mail", true);
    const colliding = await seedBookmark(workspace.id, member, "mail", true);
    const free = await seedBookmark(workspace.id, member, "inbox", true);
    const quiet = await seedBookmark(workspace.id, member, "kept", false);
    const plain = await seedBookmark(workspace.id, member, null);
    const staying = await seedBookmark(workspace.id, memberOf(workspace, 1), "mail", true);
    const before = await stored(workspace.id);

    await depart("direct delete", workspace, member);

    const after = await stored(workspace.id);
    const row = (id: string, rows: Stored[]) => rows.find((candidate) => candidate.id === id);
    expect(row(colliding, after)).toMatchObject({ owner_id: null, slug: null, forwarding: false, version: (row(colliding, before)?.version ?? 0) + 1 });
    expect(row(free, after)).toMatchObject({ owner_id: null, slug: "inbox", forwarding: true });
    expect(row(quiet, after)).toMatchObject({ owner_id: null, slug: "kept", forwarding: false });
    expect(row(plain, after)).toMatchObject({ owner_id: null, slug: null });
    expect(row(staying, after)).toEqual(row(staying, before));
  });

  it("leaves the bookmarks of other workspaces and the workspace's own ownerless bookmarks as they were", async () => {
    const workspace = await workspaceOf(1);
    const other = await workspaceOf(1);
    const ownerless = await seedBookmark(workspace.id, null, "mail", true);
    await seedBookmark(workspace.id, memberOf(workspace, 0), "mail", true);
    await seedBookmark(other.id, memberOf(other, 0), "mail", true);
    const otherBefore = await stored(other.id);
    const ownerlessBefore = (await stored(workspace.id)).find((row) => row.id === ownerless);

    await depart("direct delete", workspace, memberOf(workspace, 0));

    expect(await stored(other.id)).toEqual(otherBefore);
    expect((await stored(workspace.id)).find((row) => row.id === ownerless)).toEqual(ownerlessBefore);
  });

  it("is part of the transaction that deletes the membership: a rollback leaves the slug, the forwarding and the owner as they were", async () => {
    const workspace = await workspaceOf(1);
    const member = memberOf(workspace, 0);
    await seedBookmark(workspace.id, null, "mail", true);
    const mine = await seedBookmark(workspace.id, member, "mail", true);

    await expect(
      asSystem(db, async (tx) => {
        await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${member}`;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    expect((await stored(workspace.id)).find((row) => row.id === mine)).toMatchObject({ owner_id: member, slug: "mail", forwarding: true });
  });

  it("serialises departures that race: all succeed, and exactly one of the bookmarks keeps the slug", async () => {
    const workspace = await workspaceOf(3);
    for (let index = 0; index < 3; index += 1) {
      await seedBookmark(workspace.id, memberOf(workspace, index), "mail", true);
    }

    await Promise.all([0, 1, 2].map((index) => depart("member removal", workspace, memberOf(workspace, index))));

    const rows = await stored(workspace.id);
    expect(rows.every((row) => row.owner_id === null)).toBe(true);
    expect(rows.filter((row) => row.slug === "mail")).toHaveLength(1);
    expect(rows.filter((row) => row.slug === null && !row.forwarding)).toHaveLength(2);
  });
});
