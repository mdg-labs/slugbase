import type { NewBookmark } from "@slugbase/core";
import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookmarkRepository, memberRepository, TenantContextError, workspacePurgeOrder } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The bookmarks of a workspace (doc 05 sections 2.2, 2.4 and 3.3, doc 02 section 5, doc 10 T1, T2 and T11). The failure
// scenarios: a bookmark that stores a script or a local file as its destination, or a title, description or slug outside
// the grammar; one owned by someone who is not a member of its workspace; a member who leaves and takes the bookmark, or
// the workspace's key, with them; a read, a write or a count that reaches the rows of another workspace, through the
// repository or with the application layer left out; a bookmark the application role updates, deletes or writes the
// columns of that a request may not; a counter that is read and raised in two steps and lets two creations at the
// limit minus one both through, that is not given back when the insert fails, or that moves for a workspace the
// transaction does not act in; and a workspace whose bookmarks survive its deletion.

const HOOK_TIMEOUT_MS = 300_000;
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";
const QUEUE = "event.bookmark.created";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  // The queue and job tables `migrate` creates through pg-boss, reduced to the columns the enqueue writes and reads.
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
});

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `bookmarks${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  /** The members, in the order of the roles given. */
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 2): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Bookmarks test" });
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

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "bookmarks-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
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

function newBookmark(ownerId: string, overrides: Partial<NewBookmark> = {}): NewBookmark {
  return {
    id: freshId(),
    ownerId,
    url: "https://example.com/docs",
    urlCanonical: "https://example.com/docs",
    host: "example.com",
    title: "Docs",
    description: null,
    pinned: false,
    ...overrides,
  };
}

function jobFor(workspaceId: string, bookmarkId: string, accountId: string, queue = QUEUE) {
  return { id: freshId(), queue, data: { eventId: freshId(), workspaceId, bookmarkId, accountId } };
}

interface SeedBookmark {
  readonly id?: string;
  readonly workspaceId: string;
  readonly ownerId?: string | null;
  readonly url?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
  readonly planArchivedAt?: Date | null;
}

/** Writes a bookmark as slugbase_system, which stands for the operations that write in ways a request may not. */
async function seedBookmark(bookmark: SeedBookmark): Promise<string> {
  const id = bookmark.id ?? freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${bookmark.workspaceId}, ${bookmark.ownerId ?? null}, ${bookmark.url ?? "https://example.com/seed"}, 'https://example.com/seed',
              'example.com', ${bookmark.title ?? "Seed"}, ${bookmark.description ?? null}, ${bookmark.slug ?? null}, ${bookmark.forwarding ?? false},
              ${bookmark.planArchivedAt ?? null})`,
  );
  return id;
}

async function bookmarkCount(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`);
  return rows[0]?.bookmark_count ?? Number.NaN;
}

async function storedRows(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmarks WHERE workspace_id = ${workspaceId}`);
  return Number(rows[0]?.n);
}

async function jobCount(): Promise<number> {
  const rows = await db.app<{ n: string }[]>`SELECT count(*)::text AS n FROM pgboss.job`;
  return Number(rows[0]?.n);
}

describe("the table", () => {
  it("has every column of doc 05 section 2.4, the search document among them generated by the database", async () => {
    const columns = await db.owner<{ column_name: string; is_nullable: string; is_generated: string }[]>`
      SELECT column_name, is_nullable, is_generated FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bookmarks' ORDER BY ordinal_position`;

    expect(columns.map((column) => column.column_name)).toEqual([
      "id", "workspace_id", "owner_id", "url", "url_canonical", "host", "title", "description", "slug", "forwarding", "pinned_at",
      "plan_archived_at", "open_count", "last_opened_at", "version", "created_at", "updated_at", "search",
    ]);
    const nullable = columns.filter((column) => column.is_nullable === "YES").map((column) => column.column_name);
    expect(nullable).toEqual(["owner_id", "description", "slug", "pinned_at", "plan_archived_at", "last_opened_at", "search"]);
    expect(columns.filter((column) => column.is_generated === "ALWAYS").map((column) => column.column_name)).toEqual(["search"]);
  });

  it("has the unique key on the workspace and the identifier, the checks and the keys of doc 05, and the owner's key clears the owner alone", async () => {
    const constraints = await db.owner<{ conname: string; contype: string; definition: string; setcols: number[] | null }[]>`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition, confdelsetcols AS setcols FROM pg_constraint
      WHERE conrelid = 'public.bookmarks'::regclass AND contype <> 'n' ORDER BY conname`;
    const byName = new Map(constraints.map((constraint) => [constraint.conname, constraint]));

    expect([...byName.keys()]).toEqual([
      "bookmarks_description_check",
      "bookmarks_forwarding_check",
      "bookmarks_owner_fkey",
      "bookmarks_pkey",
      "bookmarks_slug_check",
      "bookmarks_title_check",
      "bookmarks_url_length_check",
      "bookmarks_url_scheme_check",
      "bookmarks_workspace_id_id_key",
      "bookmarks_workspace_id_workspaces_id_fk",
    ]);
    expect(byName.get("bookmarks_workspace_id_id_key")?.definition).toBe("UNIQUE (workspace_id, id)");
    expect(byName.get("bookmarks_forwarding_check")?.definition).toMatch(/^CHECK \(+\(?NOT forwarding\)? OR \(slug IS NOT NULL\)\)+$/);
    expect(byName.get("bookmarks_workspace_id_workspaces_id_fk")?.definition).toBe("FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE");
    const owner = byName.get("bookmarks_owner_fkey");
    expect(owner?.definition).toContain("FOREIGN KEY (workspace_id, owner_id) REFERENCES workspace_members(workspace_id, account_id)");
    // Only owner_id is cleared: the column list of the action holds the one column, and not workspace_id, which is NOT NULL.
    const ownerColumn = await db.owner<{ attnum: number }[]>`SELECT attnum FROM pg_attribute WHERE attrelid = 'public.bookmarks'::regclass AND attname = 'owner_id'`;
    expect(owner?.setcols).toEqual([ownerColumn[0]?.attnum]);
  });

  it("refuses a destination that is not http or https, and a URL over 2 048 characters", async () => {
    const workspace = await workspaceOf(1);
    for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,hello", "file:///etc/passwd", "vbscript:msgbox(1)", "ftp://example.com/", "//example.com/", "example.com", "", " https://example.com/"]) {
      expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, url })), url).toBe(CHECK_VIOLATION);
    }
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, url: `https://example.com/${"a".repeat(2048)}` }))).toBe(CHECK_VIOLATION);

    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, url: `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}` }))).toBeUndefined();
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, url: "HTTP://EXAMPLE.com/" }))).toBeUndefined();
    expect(await storedRows(workspace.id)).toBe(2);
  });

  it("refuses a title outside 1 to 300 characters, a description over 1 000 and a slug outside the grammar", async () => {
    const workspace = await workspaceOf(1);
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, title: "" }))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, title: "t".repeat(301) }))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, description: "d".repeat(1001) }))).toBe(CHECK_VIOLATION);
    for (const slug of ["Upper", "-leading", "has space", "under_score", "", "a".repeat(65)]) {
      expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, slug })), slug).toBe(CHECK_VIOLATION);
    }

    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, title: "😀".repeat(300), description: "d".repeat(1000), slug: "a".repeat(64) }))).toBeUndefined();
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, slug: "0-ok-slug" }))).toBeUndefined();
  });

  it("refuses forwarding without a slug", async () => {
    const workspace = await workspaceOf(1);
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, forwarding: true }))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, forwarding: true, slug: "go" }))).toBeUndefined();
    expect(await refusedWith(seedBookmark({ workspaceId: workspace.id, forwarding: false }))).toBeUndefined();
  });

  it("builds a search document for a bookmark with no slug from its title, host and description, and not from the path of its URL", async () => {
    const workspace = await workspaceOf(1);
    const id = await seedBookmark({ workspaceId: workspace.id, url: "https://example.com/secretpath", title: "Quarterly planning", description: "Roadmap notes" });
    const slugged = await seedBookmark({ workspaceId: workspace.id, title: "Other", slug: "plan" });

    const matches = async (query: string): Promise<string[]> =>
      (await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspace.id} AND search @@ to_tsquery('simple', ${query})`)).map((row) => row.id);
    expect(await matches("quarterly")).toEqual([id]);
    // The host is one token of the document, as the default parser reads a host name.
    expect(await matches("'example.com'")).toEqual(expect.arrayContaining([id]));
    expect(await matches("roadmap")).toEqual([id]);
    expect(await matches("secretpath")).toEqual([]);
    expect(await matches("plan")).toEqual([slugged]);
    const rows = await asSystem(db, (tx) => tx<{ search: string | null }[]>`SELECT search FROM bookmarks WHERE id = ${id}`);
    expect(rows[0]?.search).not.toBeNull();
  });

  it("counts a bookmark as owned only by a member of its own workspace", async () => {
    const a = await workspaceOf(2);
    const b = await workspaceOf(1);
    const nobody = await account();

    expect(await refusedWith(seedBookmark({ workspaceId: a.id, ownerId: nobody }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await refusedWith(seedBookmark({ workspaceId: a.id, ownerId: memberOf(b, 0) }))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await refusedWith(seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 1) }))).toBeUndefined();
    expect(await refusedWith(seedBookmark({ workspaceId: a.id, ownerId: null }))).toBeUndefined();
  });

  it("leaves the bookmarks of a member who leaves with the workspace, ownerless and in the workspace, and touches no other", async () => {
    const a = await workspaceOf(3);
    const b = await workspaceOf(1);
    const leaving = memberOf(a, 1);
    const staying = memberOf(a, 2);
    const mine = await seedBookmark({ workspaceId: a.id, ownerId: leaving, title: "Mine" });
    const theirs = await seedBookmark({ workspaceId: a.id, ownerId: staying, title: "Theirs" });
    const elsewhere = await seedBookmark({ workspaceId: b.id, ownerId: memberOf(b, 0), title: "Elsewhere" });
    // The same account is a member of both workspaces: only its membership in A ends.
    await seedMember(db, { workspaceId: b.id, accountId: leaving, role: "member" });
    const alsoElsewhere = await seedBookmark({ workspaceId: b.id, ownerId: leaving, title: "Also elsewhere" });

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${a.id} AND account_id = ${leaving}`);

    const owners = await asSystem(db, (tx) => tx<{ id: string; workspace_id: string; owner_id: string | null }[]>`SELECT id, workspace_id, owner_id FROM bookmarks WHERE id IN ${tx([mine, theirs, elsewhere, alsoElsewhere])} ORDER BY title`);
    expect(owners.map((row) => [row.id, row.workspace_id, row.owner_id])).toEqual([
      [alsoElsewhere, b.id, leaving],
      [elsewhere, b.id, memberOf(b, 0)],
      [mine, a.id, null],
      [theirs, a.id, staying],
    ]);
  });
});

describe("row-level security and privileges", () => {
  it("has RLS enabled and forced with the policies of the workspace, and slugbase_app may select, insert and update the columns of a request and never delete", async () => {
    const [table] = await db.owner<{ enabled: boolean; forced: boolean }[]>`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.bookmarks'::regclass`;
    expect(table).toEqual({ enabled: true, forced: true });
    const policies = await db.owner<{ policyname: string; cmd: string }[]>`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'bookmarks' ORDER BY policyname`;
    expect(policies).toEqual([
      { policyname: "bookmarks_tenant", cmd: "SELECT" },
      { policyname: "bookmarks_tenant_insert", cmd: "INSERT" },
      { policyname: "bookmarks_tenant_update", cmd: "UPDATE" },
    ]);
    const [onTable] = await db.owner<Record<string, boolean>[]>`
      SELECT has_table_privilege('slugbase_app', 'public.bookmarks', 'SELECT') AS "select", has_table_privilege('slugbase_app', 'public.bookmarks', 'INSERT') AS "insert",
             has_table_privilege('slugbase_app', 'public.bookmarks', 'UPDATE') AS "update", has_table_privilege('slugbase_app', 'public.bookmarks', 'DELETE') AS "delete",
             has_table_privilege('slugbase_app', 'public.bookmarks', 'TRUNCATE') AS "truncate", has_table_privilege('slugbase_app', 'public.bookmarks', 'REFERENCES') AS "references"`;
    expect(onTable).toEqual({ select: true, insert: false, update: false, delete: false, truncate: false, references: false });
    const columns = await db.owner<{ privilege_type: string; column_name: string }[]>`
      SELECT privilege_type, column_name FROM information_schema.column_privileges
      WHERE table_name = 'bookmarks' AND grantee = 'slugbase_app' AND privilege_type IN ('INSERT', 'UPDATE') ORDER BY privilege_type, column_name`;
    expect(columns).toEqual([
      ...["description", "forwarding", "host", "id", "owner_id", "pinned_at", "slug", "title", "url", "url_canonical", "workspace_id"].map((column_name) => ({ privilege_type: "INSERT", column_name })),
      ...["description", "forwarding", "host", "pinned_at", "slug", "title", "url", "url_canonical"].map((column_name) => ({ privilege_type: "UPDATE", column_name })),
    ]);
  });

  it("refuses the application role a delete of a bookmark of its own workspace, and an update of a column a request may not write", async () => {
    const workspace = await workspaceOf(2);
    const owner = memberOf(workspace, 0);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner });
    const acting = { accountId: owner, workspaceId: workspace.id };

    expect(await refusedWith(appAs(acting, (tx) => tx`DELETE FROM bookmarks WHERE id = ${id}`))).toBe(INSUFFICIENT_PRIVILEGE);
    for (const set of ["plan_archived_at = now()", "open_count = 7", "last_opened_at = now()", "version = 9", `owner_id = '${memberOf(workspace, 1)}'`, `workspace_id = '${workspace.id}'`, "id = id", "created_at = now()", "updated_at = now()"]) {
      expect(await refusedWith(appAs(acting, (tx) => tx.unsafe(`UPDATE bookmarks SET ${set} WHERE id = '${id}'`))), set).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await storedRows(workspace.id)).toBe(1);
  });

  it("lets the application role update the columns of a request, and moves no row of another workspace, with the application layer left out (T1)", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const own = await seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 0), title: "Own" });
    const foreign = await seedBookmark({ workspaceId: b.id, ownerId: memberOf(b, 0), title: "Secret of B" });
    const acting = { accountId: memberOf(a, 0), workspaceId: a.id };

    const changed = await appAs(acting, (tx) => tx`UPDATE bookmarks SET title = 'Changed', description = 'D', pinned_at = now() WHERE id = ${own} RETURNING id`);
    const reached = await appAs(acting, (tx) => tx`UPDATE bookmarks SET title = 'Hijacked' WHERE id = ${foreign} RETURNING id`);
    const everything = await appAs(acting, (tx) => tx<{ id: string }[]>`UPDATE bookmarks SET description = 'swept' RETURNING id`);

    expect(changed).toHaveLength(1);
    expect(reached).toHaveLength(0);
    expect(everything.map((row) => row.id)).toEqual([own]);
    const rows = await asSystem(db, (tx) => tx<{ id: string; title: string; description: string | null }[]>`SELECT id, title, description FROM bookmarks WHERE id IN ${tx([own, foreign])}`);
    expect(rows.find((row) => row.id === foreign)).toMatchObject({ title: "Secret of B", description: null });
    expect(rows.find((row) => row.id === own)).toMatchObject({ title: "Changed", description: "swept" });
  });

  it("refuses an insert that names a column a request may not write: the archive, the usage, the version and the counter of the workspace", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const insertWith = (column: string, value: string) =>
      appAs({ accountId: owner, workspaceId: workspace.id }, (tx) =>
        tx.unsafe(
          `INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, ${column})
           VALUES ('${freshId()}', '${workspace.id}', '${owner}', 'https://example.com/', 'https://example.com', 'example.com', 'Docs', ${value})`,
        ),
      );

    expect(await refusedWith(insertWith("plan_archived_at", "now()"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insertWith("open_count", "7"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insertWith("last_opened_at", "now()"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insertWith("version", "9"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`UPDATE workspaces SET bookmark_count = 0 WHERE id = ${workspace.id}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedRows(workspace.id)).toBe(0);
  });

  it("shows a transaction acting in A none of B's bookmarks and refuses it an insert that names B, with the application layer left out (T1)", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const ownBookmark = await seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 0) });
    const foreign = await seedBookmark({ workspaceId: b.id, ownerId: memberOf(b, 0), title: "Secret of B" });
    const acting = { accountId: memberOf(a, 0), workspaceId: a.id };

    const seen = await appAs(acting, (tx) => tx<{ id: string; workspace_id: string }[]>`SELECT id, workspace_id FROM bookmarks`);
    expect(seen).toEqual([{ id: ownBookmark, workspace_id: a.id }]);
    expect(await appAs(acting, (tx) => tx`SELECT id FROM bookmarks WHERE id = ${foreign}`)).toHaveLength(0);
    expect(await appAs(acting, (tx) => tx`SELECT id FROM bookmarks WHERE title = 'Secret of B'`)).toHaveLength(0);

    const insertInto = (workspaceId: string, ownerId: string | null) =>
      appAs(acting, (tx) =>
        tx`INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
           VALUES (${freshId()}, ${workspaceId}, ${ownerId}, 'https://example.com/', 'https://example.com', 'example.com', 'Planted')`,
      );
    expect(await refusedWith(insertInto(b.id, memberOf(b, 0)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insertInto(b.id, null))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedRows(b.id)).toBe(1);
  });

  it("shows an account that acts in no workspace no bookmark at all, and lets it insert none", async () => {
    const a = await workspaceOf(1);
    await seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 0) });
    const outsider = await account();

    expect(await appAs({ accountId: outsider }, (tx) => tx`SELECT id FROM bookmarks`)).toHaveLength(0);
    expect(
      await refusedWith(
        appAs({ accountId: outsider }, (tx) =>
          tx`INSERT INTO bookmarks (id, workspace_id, url, url_canonical, host, title) VALUES (${freshId()}, ${a.id}, 'https://example.com/', 'https://example.com', 'example.com', 'Planted')`,
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("create and find", () => {
  it("stores the bookmark for the account of the transaction, takes a place, queues the job and finds it again", async () => {
    const workspace = await workspaceOf(2);
    const owner = memberOf(workspace, 1);
    const bookmark = newBookmark(owner, { title: "Docs", description: "The docs", pinned: true });

    const created = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [jobFor(workspace.id, bookmark.id, owner)] }),
    );

    expect(created.kind).toBe("created");
    if (created.kind !== "created") {
      return;
    }
    expect(created.bookmark).toMatchObject({
      id: bookmark.id,
      ownerId: owner,
      url: "https://example.com/docs",
      host: "example.com",
      title: "Docs",
      description: "The docs",
      slug: null,
      forwarding: false,
      pinned: true,
      openCount: 0,
      lastOpenedAt: null,
      version: 1,
    });
    expect(created.bookmark.createdAt).toBeInstanceOf(Date);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    const jobs = await db.app<{ name: string; data: { bookmarkId: string; workspaceId: string; accountId: string } }[]>`SELECT name, data FROM pgboss.job`;
    expect(jobs.map((job) => [job.name, job.data.bookmarkId, job.data.workspaceId, job.data.accountId])).toEqual([[QUEUE, bookmark.id, workspace.id, owner]]);
    const found = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).find(bookmark.id));
    expect(found).toEqual(created.bookmark);
    const stored = await asSystem(db, (tx) => tx<{ url_canonical: string; pinned_at: Date | null }[]>`SELECT url_canonical, pinned_at FROM bookmarks WHERE id = ${bookmark.id}`);
    expect(stored[0]?.url_canonical).toBe("https://example.com/docs");
    expect(stored[0]?.pinned_at).toBeInstanceOf(Date);
  });

  it("leaves a bookmark that is not pinned unpinned", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const created = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(owner), ceiling: null, jobs: [] }));

    expect(created.kind === "created" && created.bookmark.pinned).toBe(false);
  });

  it("finds a bookmark of another member of the workspace, which the service then keeps from its reader, and none of another workspace", async () => {
    const a = await workspaceOf(2);
    const b = await workspaceOf(1);
    const theirs = await seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 1) });
    const ofB = await seedBookmark({ workspaceId: b.id, ownerId: memberOf(b, 0) });

    const found = await inTenant({ accountId: memberOf(a, 0), workspaceId: a.id }, async (tx) => ({
      theirs: await bookmarkRepository(tx).find(theirs),
      ofB: await bookmarkRepository(tx).find(ofB),
    }));

    expect(found.theirs?.ownerId).toBe(memberOf(a, 1));
    expect(found.ofB).toBeUndefined();
  });

  it("does not find a plan-archived bookmark, or one that does not exist", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const archived = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, planArchivedAt: new Date() });

    const found = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => [await bookmarkRepository(tx).find(archived), await bookmarkRepository(tx).find(freshId())]);

    expect(found).toEqual([undefined, undefined]);
  });

  it("refuses to create without a workspace, and an account-level transaction reads no bookmark", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    await expect(inTenant({ accountId: owner }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(owner), ceiling: null, jobs: [] }))).rejects.toThrow(TenantContextError);
    await expect(inTenant({ accountId: owner }, (tx) => bookmarkRepository(tx).find(freshId()))).rejects.toThrow(TenantContextError);
  });
});

describe("the bookmark count", () => {
  it("raises the counter with every creation and leaves it alone for a seeded bookmark", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    await seedBookmark({ workspaceId: workspace.id, ownerId: owner });
    expect(await bookmarkCount(workspace.id)).toBe(0);

    for (let index = 0; index < 3; index += 1) {
      await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(owner), ceiling: null, jobs: [] }));
    }

    expect(await bookmarkCount(workspace.id)).toBe(3);
  });

  it("refuses the creation at the ceiling with the count it judged, and writes, counts and queues nothing", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const create = (ceiling: number | null) => {
      const bookmark = newBookmark(owner);
      return inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling, jobs: [jobFor(workspace.id, bookmark.id, owner)] }));
    };

    expect((await create(2)).kind).toBe("created");
    expect((await create(2)).kind).toBe("created");
    expect(await create(2)).toEqual({ kind: "limit_reached", used: 2 });
    expect(await create(1)).toEqual({ kind: "limit_reached", used: 2 });
    expect(await bookmarkCount(workspace.id)).toBe(2);
    expect(await storedRows(workspace.id)).toBe(2);
    expect(await jobCount()).toBe(2);

    expect((await create(3)).kind).toBe("created");
    expect((await create(null)).kind).toBe("created");
    expect(await bookmarkCount(workspace.id)).toBe(4);
  });

  it("refuses every creation under a ceiling of zero", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    const created = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(owner), ceiling: 0, jobs: [] }));

    expect(created).toEqual({ kind: "limit_reached", used: 0 });
    expect(await storedRows(workspace.id)).toBe(0);
  });

  it("lets one of two creations at the limit minus one through, however they interleave (T11)", async () => {
    const workspace = await workspaceOf(2);
    const first = memberOf(workspace, 0);
    const second = memberOf(workspace, 1);
    await inTenant({ accountId: first, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(first), ceiling: 2, jobs: [] }));

    // The first holds its transaction open after it has taken the place, so the second reaches the counter while the lock is held.
    const results = await Promise.all([
      inTenant({ accountId: first, workspaceId: workspace.id }, async (tx) => {
        const created = await bookmarkRepository(tx).create({ bookmark: newBookmark(first), ceiling: 2, jobs: [] });
        await sleep(400);
        return created;
      }),
      sleep(100).then(() => inTenant({ accountId: second, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(second), ceiling: 2, jobs: [] }))),
    ]);

    expect(results.map((result) => result.kind)).toEqual(["created", "limit_reached"]);
    expect(results[1]).toEqual({ kind: "limit_reached", used: 2 });
    expect(await bookmarkCount(workspace.id)).toBe(2);
    expect(await storedRows(workspace.id)).toBe(2);
  }, 30_000);

  it("gives the place back when the insert fails after it was taken, and when the job cannot be queued", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const failing = (bookmark: NewBookmark, jobs: Parameters<ReturnType<typeof bookmarkRepository>["create"]>[0]["jobs"] = []) =>
      inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: 5, jobs }));

    // A destination the table refuses reaches the insert after the counter was raised.
    expect(await refusedWith(failing(newBookmark(owner, { url: "javascript:alert(1)" })))).toBe(CHECK_VIOLATION);
    const missing = newBookmark(owner);
    await expect(failing(missing, [jobFor(workspace.id, missing.id, owner, "event.missing.queue")])).rejects.toThrow(/does not exist/);

    expect(await bookmarkCount(workspace.id)).toBe(0);
    expect(await storedRows(workspace.id)).toBe(0);
    expect(await jobCount()).toBe(0);
  });

  it("answers unavailable, and counts nothing, for an account that is no member of the workspace", async () => {
    const workspace = await workspaceOf(1);
    const outsider = await account();

    const created = await inTenant({ accountId: outsider, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(outsider), ceiling: null, jobs: [] }));

    expect(created).toEqual({ kind: "unavailable" });
    expect(await bookmarkCount(workspace.id)).toBe(0);
    expect(await storedRows(workspace.id)).toBe(0);
  });

  it("answers unavailable for a workspace being deleted", async () => {
    const id = await seedWorkspace(db, { name: "Going", deletingAt: new Date() });
    const owner = await account();
    await seedMember(db, { workspaceId: id, accountId: owner, role: "owner" });

    const created = await inTenant({ accountId: owner, workspaceId: id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(owner), ceiling: null, jobs: [] }));

    expect(created).toEqual({ kind: "unavailable" });
    expect(await storedRows(id)).toBe(0);
  });

  it("takes no place in a workspace other than the one the transaction acts in, also for an account that is a member of both", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const owner = memberOf(a, 0);
    await seedMember(db, { workspaceId: b.id, accountId: owner, role: "member" });

    const outcome = await appAs({ accountId: owner, workspaceId: a.id }, (tx) => tx<{ outcome: string; used: number | null }[]>`SELECT outcome, used FROM sys_bookmark_count_take(${b.id}::uuid, NULL)`);
    const noAccount = await appAs({ accountId: owner, workspaceId: a.id }, (tx) => tx`SELECT set_config('app.account_id', '', true)`.then(() => tx<{ outcome: string }[]>`SELECT outcome FROM sys_bookmark_count_take(${a.id}::uuid, NULL)`));

    expect(outcome).toEqual([{ outcome: "unavailable", used: null }]);
    expect(noAccount).toEqual([{ outcome: "unavailable" }]);
    expect(await bookmarkCount(b.id)).toBe(0);
    expect(await bookmarkCount(a.id)).toBe(0);
  });

  it("refuses a ceiling that is negative", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    expect(await refusedWith(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`SELECT * FROM sys_bookmark_count_take(${workspace.id}::uuid, -1)`))).toBe("22023");
  });
});

function urlOf(url: string): { url: string; canonical: string; host: string } {
  return { url, canonical: url, host: new URL(url).host };
}

interface VersionRow {
  readonly version: number;
  readonly title: string;
  readonly updated_at: Date;
}

async function versionOf(id: string): Promise<VersionRow | undefined> {
  const rows = await asSystem(db, (tx) => tx<VersionRow[]>`SELECT version, title, updated_at FROM bookmarks WHERE id = ${id}`);
  return rows[0];
}

describe("the version", () => {
  it("moves by one with every update that changes what a member sees or edits, whoever sets it, and stays for one that does not", async () => {
    const workspace = await workspaceOf(2);
    const owner = memberOf(workspace, 0);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, title: "Docs", description: "D" });
    expect((await versionOf(id))?.version).toBe(1);

    await asSystem(db, (tx) => tx`UPDATE bookmarks SET title = 'Renamed' WHERE id = ${id}`);
    expect((await versionOf(id))?.version).toBe(2);
    // A statement that writes the values the row has, and the usage a flush writes, leave the version.
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET title = 'Renamed', description = 'D' WHERE id = ${id}`);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET open_count = open_count + 3, last_opened_at = now() WHERE id = ${id}`);
    expect((await versionOf(id))?.version).toBe(2);
    // Every other field a member sees moves it.
    for (const set of ["description = NULL", "slug = 'docs'", "forwarding = true", "pinned_at = now()", "plan_archived_at = now()", "url = 'https://example.org/'", `owner_id = '${memberOf(workspace, 1)}'`]) {
      const before = (await versionOf(id))?.version ?? 0;
      await asSystem(db, (tx) => tx.unsafe(`UPDATE bookmarks SET ${set} WHERE id = '${id}'`));
      expect((await versionOf(id))?.version, set).toBe(before + 1);
    }
    // The statement cannot set the version: the trigger overwrites it.
    const before = (await versionOf(id))?.version ?? 0;
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET title = 'Again', version = 99 WHERE id = ${id}`);
    expect((await versionOf(id))?.version).toBe(before + 1);
  });
});

describe("update", () => {
  const update = (tenant: { accountId: string; workspaceId: string }, request: Parameters<ReturnType<typeof bookmarkRepository>["update"]>[0]) =>
    inTenant(tenant, (tx) => bookmarkRepository(tx).update(request));

  it("changes the fields of the owner's bookmark, derives the columns of the URL again and moves the version and the timestamp", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, title: "Docs", description: "D" });
    const before = await versionOf(id);

    const result = await update(
      { accountId: owner, workspaceId: workspace.id },
      { bookmarkId: id, ownerId: owner, expectedVersions: [1], changes: { url: urlOf("https://example.org/new"), title: "New", description: null, pinned: true } },
    );

    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") {
      return;
    }
    expect(result.bookmark).toMatchObject({ id, ownerId: owner, url: "https://example.org/new", host: "example.org", title: "New", description: null, pinned: true, version: 2, slug: null });
    expect(result.bookmark.updatedAt.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Number.POSITIVE_INFINITY);
    const stored = await asSystem(db, (tx) => tx<{ url_canonical: string; host: string; pinned_at: Date | null }[]>`SELECT url_canonical, host, pinned_at FROM bookmarks WHERE id = ${id}`);
    expect(stored[0]).toMatchObject({ url_canonical: "https://example.org/new", host: "example.org" });
    expect(stored[0]?.pinned_at).toBeInstanceOf(Date);
  });

  it("keeps the time a bookmark was pinned when it is pinned again, and unpins it", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const acting = { accountId: owner, workspaceId: workspace.id };
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner });
    await update(acting, { bookmarkId: id, ownerId: owner, expectedVersions: undefined, changes: { pinned: true } });
    const pinnedAt = (await asSystem(db, (tx) => tx<{ pinned_at: Date }[]>`SELECT pinned_at FROM bookmarks WHERE id = ${id}`))[0]?.pinned_at;

    const again = await update(acting, { bookmarkId: id, ownerId: owner, expectedVersions: undefined, changes: { pinned: true } });
    expect(again.kind).toBe("unchanged");
    expect((await asSystem(db, (tx) => tx<{ pinned_at: Date }[]>`SELECT pinned_at FROM bookmarks WHERE id = ${id}`))[0]?.pinned_at).toEqual(pinnedAt);

    const off = await update(acting, { bookmarkId: id, ownerId: owner, expectedVersions: undefined, changes: { pinned: false } });
    expect(off).toMatchObject({ kind: "updated", bookmark: { pinned: false, version: 3 } });
  });

  it("answers unchanged, writing nothing, for a patch that names the values the row has and for an empty one", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, title: "Docs", description: "D", url: "https://example.com/seed" });
    const before = await versionOf(id);

    for (const changes of [{}, { title: "Docs" }, { description: "D", url: urlOf("https://example.com/seed") }] as const) {
      const result = await update({ accountId: owner, workspaceId: workspace.id }, { bookmarkId: id, ownerId: owner, expectedVersions: [1], changes });
      expect(result.kind).toBe("unchanged");
    }
    expect(await versionOf(id)).toEqual(before);
  });

  it("answers stale, writing nothing, for a version outside the accepted ones, an empty list included, and judges the version under the lock", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const acting = { accountId: owner, workspaceId: workspace.id };
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, title: "Docs" });

    expect(await update(acting, { bookmarkId: id, ownerId: owner, expectedVersions: [2, 3], changes: { title: "X" } })).toEqual({ kind: "stale" });
    expect(await update(acting, { bookmarkId: id, ownerId: owner, expectedVersions: [], changes: { title: "X" } })).toEqual({ kind: "stale" });
    expect((await versionOf(id))?.title).toBe("Docs");

    // Two changes against version 1: the second waits on the first's lock, reads version 2 and is refused.
    const results = await Promise.all([
      inTenant(acting, async (tx) => {
        const result = await bookmarkRepository(tx).update({ bookmarkId: id, ownerId: owner, expectedVersions: [1], changes: { title: "First" } });
        await sleep(400);
        return result;
      }),
      sleep(100).then(() => update(acting, { bookmarkId: id, ownerId: owner, expectedVersions: [1], changes: { title: "Second" } })),
    ]);
    expect(results.map((result) => result.kind)).toEqual(["updated", "stale"]);
    expect(await versionOf(id)).toMatchObject({ title: "First", version: 2 });
  }, 30_000);

  it("finds no bookmark of another member, of another workspace, a plan-archived one or one that does not exist, and writes nothing (T1, T2)", async () => {
    const a = await workspaceOf(2);
    const b = await workspaceOf(1);
    const mine = memberOf(a, 0);
    const theirs = await seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 1), title: "Theirs" });
    const ofB = await seedBookmark({ workspaceId: b.id, ownerId: memberOf(b, 0), title: "Of B" });
    const ownerless = await seedBookmark({ workspaceId: a.id, ownerId: null, title: "Ownerless" });
    const archived = await seedBookmark({ workspaceId: a.id, ownerId: mine, title: "Archived", planArchivedAt: new Date() });
    const counted = await bookmarkCount(a.id);

    for (const bookmarkId of [theirs, ofB, ownerless, archived, freshId()]) {
      const result = await update({ accountId: mine, workspaceId: a.id }, { bookmarkId, ownerId: mine, expectedVersions: [1], changes: { title: "Hijacked" } });
      expect(result, bookmarkId).toEqual({ kind: "not_found" });
    }
    expect((await versionOf(theirs))?.title).toBe("Theirs");
    expect((await versionOf(ofB))?.title).toBe("Of B");
    expect((await versionOf(archived))?.title).toBe("Archived");
    expect(await bookmarkCount(a.id)).toBe(counted);
  });

  it("refuses to change without a workspace", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    await expect(inTenant({ accountId: owner }, (tx) => bookmarkRepository(tx).update({ bookmarkId: freshId(), ownerId: owner, expectedVersions: undefined, changes: { title: "X" } }))).rejects.toThrow(TenantContextError);
  });
});

describe("remove", () => {
  const remove = (tenant: { accountId: string; workspaceId: string }, bookmarkId: string, ownerId = tenant.accountId) =>
    inTenant(tenant, (tx) => bookmarkRepository(tx).remove({ bookmarkId, ownerId }));

  async function createdBy(workspaceId: string, accountId: string, count = 1): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const bookmark = newBookmark(accountId);
      const created = await inTenant({ accountId, workspaceId }, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [] }));
      expect(created.kind).toBe("created");
      ids.push(bookmark.id);
    }
    return ids;
  }

  it("deletes the owner's bookmark, gives its place back and answers false to a repeat", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const [first, second] = await createdBy(workspace.id, owner, 2);
    expect(await bookmarkCount(workspace.id)).toBe(2);

    expect(await remove({ accountId: owner, workspaceId: workspace.id }, first ?? "")).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await storedRows(workspace.id)).toBe(1);
    expect(await remove({ accountId: owner, workspaceId: workspace.id }, first ?? "")).toBe(false);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await remove({ accountId: owner, workspaceId: workspace.id }, second ?? "")).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(0);
  });

  it("leaves the counter alone for a plan-archived bookmark, so the counter stays the number of rows that are not archived", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const [live, toArchive] = await createdBy(workspace.id, owner, 2);
    // The archive operation of a downgrade takes the bookmark out of the count when it archives it.
    await asSystem(db, async (tx) => {
      await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${toArchive ?? ""}`;
      await tx`UPDATE workspaces SET bookmark_count = bookmark_count - 1 WHERE id = ${workspace.id}`;
    });
    const notArchived = async () =>
      Number((await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmarks WHERE workspace_id = ${workspace.id} AND plan_archived_at IS NULL`))[0]?.n);
    expect([await bookmarkCount(workspace.id), await notArchived(), await storedRows(workspace.id)]).toEqual([1, 1, 2]);

    expect(await remove({ accountId: owner, workspaceId: workspace.id }, toArchive ?? "")).toBe(true);
    expect([await bookmarkCount(workspace.id), await notArchived(), await storedRows(workspace.id)]).toEqual([1, 1, 1]);
    expect(await remove({ accountId: owner, workspaceId: workspace.id }, live ?? "")).toBe(true);
    expect([await bookmarkCount(workspace.id), await notArchived(), await storedRows(workspace.id)]).toEqual([0, 0, 0]);
  });

  it("deletes nothing and moves no counter when another member of the workspace, another workspace's member or an ownerless row is named (T1, T2)", async () => {
    const a = await workspaceOf(2);
    const b = await workspaceOf(1);
    const [theirs] = await createdBy(a.id, memberOf(a, 0));
    const [ofB] = await createdBy(b.id, memberOf(b, 0));
    const ownerless = await seedBookmark({ workspaceId: a.id, ownerId: null });
    const counters = [await bookmarkCount(a.id), await bookmarkCount(b.id)];

    // B is a member of A and deletes A's private bookmark by id: the row and the counter stay.
    expect(await remove({ accountId: memberOf(a, 1), workspaceId: a.id }, theirs ?? "")).toBe(false);
    expect(await remove({ accountId: memberOf(a, 1), workspaceId: a.id }, ownerless)).toBe(false);
    expect(await remove({ accountId: memberOf(a, 0), workspaceId: a.id }, ownerless)).toBe(false);
    expect(await remove({ accountId: memberOf(a, 0), workspaceId: a.id }, ofB ?? "")).toBe(false);
    expect(await remove({ accountId: memberOf(b, 0), workspaceId: b.id }, theirs ?? "")).toBe(false);
    expect(await remove({ accountId: memberOf(a, 0), workspaceId: a.id }, freshId())).toBe(false);
    expect(await storedRows(a.id)).toBe(2);
    expect(await storedRows(b.id)).toBe(1);
    expect([await bookmarkCount(a.id), await bookmarkCount(b.id)]).toEqual(counters);
  });

  it("deletes the bookmark of a member of two workspaces only in the workspace the transaction acts in", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const both = memberOf(a, 0);
    await seedMember(db, { workspaceId: b.id, accountId: both, role: "member" });
    const [inA] = await createdBy(a.id, both);
    const [inB] = await createdBy(b.id, both);

    expect(await remove({ accountId: both, workspaceId: a.id }, inB ?? "")).toBe(false);
    expect(await remove({ accountId: both, workspaceId: b.id }, inA ?? "")).toBe(false);
    expect(await storedRows(a.id)).toBe(1);
    expect(await storedRows(b.id)).toBe(1);
    expect(await remove({ accountId: both, workspaceId: a.id }, inA ?? "")).toBe(true);
    expect([await bookmarkCount(a.id), await bookmarkCount(b.id)]).toEqual([0, 1]);
  });

  it("answers false, deleting nothing, for a workspace being deleted and for a call that names a workspace other than the one the transaction acts in", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const owner = memberOf(a, 0);
    const [id] = await createdBy(a.id, owner);
    const [ofB] = await createdBy(b.id, memberOf(b, 0));

    const elsewhere = await appAs({ accountId: owner, workspaceId: a.id }, (tx) => tx<{ deleted: boolean }[]>`SELECT sys_bookmark_delete(${b.id}::uuid, ${ofB ?? ""}::uuid) AS deleted`);
    const noAccount = await appAs({ accountId: owner, workspaceId: a.id }, (tx) => tx`SELECT set_config('app.account_id', '', true)`.then(() => tx<{ deleted: boolean }[]>`SELECT sys_bookmark_delete(${a.id}::uuid, ${id ?? ""}::uuid) AS deleted`));
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${a.id}`);
    const deleting = await appAs({ accountId: owner, workspaceId: a.id }, (tx) => tx<{ deleted: boolean }[]>`SELECT sys_bookmark_delete(${a.id}::uuid, ${id ?? ""}::uuid) AS deleted`);

    expect(elsewhere).toEqual([{ deleted: false }]);
    expect(noAccount).toEqual([{ deleted: false }]);
    expect(deleting).toEqual([{ deleted: false }]);
    expect(await storedRows(a.id)).toBe(1);
    expect(await storedRows(b.id)).toBe(1);
    expect(await bookmarkCount(b.id)).toBe(1);
  });

  it("refuses a call without a workspace or a bookmark, a transaction without a workspace, and an owner other than the account of the transaction", async () => {
    const workspace = await workspaceOf(2);
    const owner = memberOf(workspace, 0);
    const [id] = await createdBy(workspace.id, owner);

    expect(await refusedWith(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`SELECT sys_bookmark_delete(NULL, ${id ?? ""}::uuid)`))).toBe("22023");
    expect(await refusedWith(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`SELECT sys_bookmark_delete(${workspace.id}::uuid, NULL)`))).toBe("22023");
    await expect(inTenant({ accountId: owner }, (tx) => bookmarkRepository(tx).remove({ bookmarkId: id ?? "", ownerId: owner }))).rejects.toThrow(TenantContextError);
    await expect(inTenant({ accountId: memberOf(workspace, 1), workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).remove({ bookmarkId: id ?? "", ownerId: owner }))).rejects.toThrow(/own bookmark/);
    expect(await storedRows(workspace.id)).toBe(1);
    expect(await bookmarkCount(workspace.id)).toBe(1);
  });

  it("fails the deletion, and keeps the row, when the counter disagrees with the rows and would fall below zero", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: owner });

    expect(await refusedWith(remove({ accountId: owner, workspaceId: workspace.id }, id))).toBe(CHECK_VIOLATION);
    expect(await storedRows(workspace.id)).toBe(1);
    expect(await bookmarkCount(workspace.id)).toBe(0);
  });

  it("lets a deletion and a creation at the limit minus one run together: the place the deletion frees is the creation's", async () => {
    const workspace = await workspaceOf(2);
    const first = memberOf(workspace, 0);
    const second = memberOf(workspace, 1);
    const [existing] = await createdBy(workspace.id, first);
    await createdBy(workspace.id, second);

    const results = await Promise.all([
      remove({ accountId: first, workspaceId: workspace.id }, existing ?? ""),
      inTenant({ accountId: second, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(second), ceiling: 2, jobs: [] })),
    ]);

    expect(results[0]).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(await storedRows(workspace.id));
  }, 30_000);
});

describe("a bookmark change against a member's removal", () => {
  const DEADLOCK_DETECTED = "40P01";

  /** The value of `work`, or `error:<SQLSTATE>` when it fails, so a test can name the code a loser of a deadlock gets. */
  async function settle<T>(work: Promise<T>): Promise<T | string> {
    const code = await refusedWith(work.then(() => undefined));
    return code === undefined ? work : `error:${code}`;
  }

  // The removal of a member reads the roles under the workspace's row lock and only then deletes the membership, whose foreign key
  // clears the owner of the member's bookmarks. `holdsWorkspace` is resolved once the removal has the lock; the removal then waits
  // `holdMs` before it deletes the membership, which gives the change time to take whatever it takes first.
  function removal(workspace: Workspace, admin: string, member: string, holdMs: number): { removed: Promise<boolean | string>; holdsWorkspace: Promise<void> } {
    let holds: () => void = () => undefined;
    const holdsWorkspace = new Promise<void>((resolve) => {
      holds = resolve;
    });
    const removed = inTenant({ accountId: admin, workspaceId: workspace.id }, async (tx) => {
      const members = memberRepository(tx);
      await members.roles(member);
      holds();
      await sleep(holdMs);
      return members.remove(member, []);
    });
    return { removed: settle(removed), holdsWorkspace };
  }

  async function ownerOf(bookmarkId: string): Promise<string | null | undefined> {
    const rows = await asSystem(db, (tx) => tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks WHERE id = ${bookmarkId}`);
    return rows[0]?.owner_id;
  }

  it("deletes a bookmark of a member who is being removed without a deadlock: the delete queues on the workspace and then finds the bookmark ownerless", async () => {
    const workspace = await workspaceOf(2);
    const admin = memberOf(workspace, 0);
    const member = memberOf(workspace, 1);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: member });
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 1 WHERE id = ${workspace.id}`);

    const { removed, holdsWorkspace } = removal(workspace, admin, member, 700);
    await holdsWorkspace;
    const deleted = await settle(inTenant({ accountId: member, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).remove({ bookmarkId: id, ownerId: member })));

    expect(await removed).toBe(true);
    expect(deleted).not.toBe(`error:${DEADLOCK_DETECTED}`);
    expect(deleted).toBe(false);
    expect(await ownerOf(id)).toBeNull();
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await storedRows(workspace.id)).toBe(1);
  }, 30_000);

  it("changes a bookmark of a member who is being removed without a deadlock: the removal waits for the change", async () => {
    const workspace = await workspaceOf(2);
    const admin = memberOf(workspace, 0);
    const member = memberOf(workspace, 1);
    const id = await seedBookmark({ workspaceId: workspace.id, ownerId: member, title: "Before" });

    const { removed, holdsWorkspace } = removal(workspace, admin, member, 200);
    await holdsWorkspace;
    const changed = await settle(
      inTenant({ accountId: member, workspaceId: workspace.id }, async (tx) => {
        const result = await bookmarkRepository(tx).update({ bookmarkId: id, ownerId: member, expectedVersions: undefined, changes: { title: "After" } });
        await sleep(600);
        return result.kind;
      }),
    );

    expect(changed).toBe("updated");
    expect(await removed).toBe(true);
    expect(await ownerOf(id)).toBeNull();
    expect(await asSystem(db, (tx) => tx<{ title: string }[]>`SELECT title FROM bookmarks WHERE id = ${id}`)).toEqual([{ title: "After" }]);
  }, 30_000);
});

describe("deleting a workspace", () => {
  it("lists bookmarks before the members in the purge order, and the purge function deletes them in batches", async () => {
    expect(workspacePurgeOrder.indexOf("bookmarks")).toBeGreaterThanOrEqual(0);
    expect(workspacePurgeOrder.indexOf("bookmarks")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));

    const doomed = await workspaceOf(2);
    const kept = await workspaceOf(1);
    for (let index = 0; index < 5; index += 1) {
      await seedBookmark({ workspaceId: doomed.id, ownerId: memberOf(doomed, index % 2) });
    }
    await seedBookmark({ workspaceId: kept.id, ownerId: memberOf(kept, 0) });
    const purge = (workspaceId: string) =>
      db.app<{ n: number }[]>`SELECT sys_workspace_purge_batch(${workspaceId}::uuid, 'bookmarks', 2) AS n`.then((rows) => rows[0]?.n);

    // A workspace that is not being deleted loses nothing.
    expect(await purge(doomed.id)).toBe(0);
    expect(await storedRows(doomed.id)).toBe(5);

    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${doomed.id}`);
    expect([await purge(doomed.id), await purge(doomed.id), await purge(doomed.id), await purge(doomed.id)]).toEqual([2, 2, 1, 0]);
    expect(await storedRows(doomed.id)).toBe(0);
    expect(await storedRows(kept.id)).toBe(1);
  });
});
