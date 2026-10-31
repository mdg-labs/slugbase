import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountDeletionRepository, memberRepository, type QueuedJob } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark, shareThroughFolder } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum } from "./support/workspace-fixture.ts";

// The content choice of a member's departure (doc 02 section 3.6, doc 05 sections 2.4, 3.3 and 7.1, doc 10 T1 and T2; src/sql/680-member-departure.sql). The failure scenario: A
// shares a bookmark with B and an admin removes A with `delete`; the bookmark stayed in the workspace without an owner and kept giving B access. The membership's foreign keys release
// A's bookmarks and folders, so the removal names its departure and the released rows carry it; `sys_member_departure_apply` then acts on exactly those rows: it deletes them with
// their shares, or gives them to the recipient, and a second call, a member who joined again, a recipient who left and the content of another departure change nothing they should not.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "event.member.left";
const SLUG = "mail";

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
  await seedAccount(db, { id, email: `departure${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

interface Cast {
  readonly workspaceId: string;
  /** The owner, who removes members and receives the content by default. */
  readonly owner: string;
  readonly a: string;
  readonly b: string;
  readonly r: string;
}

async function cast(): Promise<Cast> {
  const workspaceId = await seedWorkspace(db, { name: "Departure content" });
  const [owner, a, b, r] = [await account(), await account(), await account(), await account()] as [string, string, string, string];
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  for (const accountId of [a, b, r]) {
    await seedMember(db, { workspaceId, accountId, role: "member" });
  }
  return { workspaceId, owner, a, b, r };
}

interface SeedBookmark {
  readonly slug?: string;
  readonly forwarding?: boolean;
  readonly archived?: boolean;
}

/** A bookmark, counted by the workspace's counter unless it is plan-archived, as creating one counts it. */
async function bookmarkOf(workspaceId: string, ownerId: string, options: SeedBookmark = {}): Promise<string> {
  const id = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/a', 'https://example.com/a', 'example.com', 'Mail',
              ${options.slug ?? null}, ${options.forwarding ?? false}, ${options.archived === true ? new Date() : null})`;
    if (options.archived !== true) {
      await tx`UPDATE workspaces SET bookmark_count = bookmark_count + 1 WHERE id = ${workspaceId}`;
    }
  });
  return id;
}

async function folderOf(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function remember(workspaceId: string, accountId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspaceId}, ${accountId}, ${SLUG}, ${bookmarkId})`);
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "member-departure-test" }, work);
}

/** Removes the member the way the member service does, queueing the `member.left` event unless the case is about a removal that queues none. */
async function depart(workspace: Cast, member: string, content: "transfer" | "delete", transferTo: string, options: { event?: boolean } = {}): Promise<string> {
  const eventId = freshId();
  const jobs: QueuedJob[] =
    options.event === false ? [] : [{ id: eventId, queue: QUEUE, data: { eventId, workspaceId: workspace.workspaceId, accountId: member, content, transferTo } }];
  expect(await inTenant({ accountId: workspace.owner, workspaceId: workspace.workspaceId }, (tx) => memberRepository(tx).remove(member, jobs))).toBe(true);
  return eventId;
}

function apply(workspaceId: string, departureId: string, content: "transfer" | "delete", recipientId: string) {
  return inTenant({ accountId: recipientId, workspaceId }, (tx) => memberRepository(tx).applyDeparture({ departureId, content, recipientId }));
}

interface BookmarkRow {
  id: string;
  owner_id: string | null;
  slug: string | null;
  forwarding: boolean;
  departure_id: string | null;
}

interface FolderRow {
  id: string;
  name: string;
  owner_id: string | null;
  departure_id: string | null;
}

async function bookmarksIn(workspaceId: string): Promise<BookmarkRow[]> {
  return asSystem(db, (tx) => tx<BookmarkRow[]>`SELECT id, owner_id, slug, forwarding, departure_id FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`);
}

async function foldersIn(workspaceId: string): Promise<FolderRow[]> {
  return asSystem(db, (tx) => tx<FolderRow[]>`SELECT id, name::text AS name, owner_id, departure_id FROM folders WHERE workspace_id = ${workspaceId} ORDER BY id`);
}

async function counts(workspaceId: string): Promise<{ shares: number; filings: number; choices: number; counter: number }> {
  return asSystem(db, async (tx) => {
    const [row] = await tx<{ shares: number; filings: number; choices: number; counter: number }[]>`
      SELECT (SELECT count(*) FROM bookmark_shares WHERE workspace_id = ${workspaceId})::int + (SELECT count(*) FROM folder_shares WHERE workspace_id = ${workspaceId})::int AS shares,
             (SELECT count(*) FROM folder_bookmarks WHERE workspace_id = ${workspaceId})::int AS filings,
             (SELECT count(*) FROM slug_preferences WHERE workspace_id = ${workspaceId})::int AS choices,
             (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId})::int AS counter`;
    if (row === undefined) {
      throw new Error("no counts");
    }
    return row;
  });
}

const NOTHING = { bookmarksMoved: 0, foldersMoved: 0, slugsCleared: 0, foldersRenamed: 0, bookmarksDeleted: 0, foldersDeleted: 0, leftOwnerless: 0 };

describe("the departure a removal names", () => {
  it("is copied to the bookmarks and folders the removal releases, with or without a slug", async () => {
    const c = await cast();
    const withSlug = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG });
    const withoutSlug = await bookmarkOf(c.workspaceId, c.a);
    const folder = await folderOf(c.workspaceId, c.a, "Reading");
    const others = await bookmarkOf(c.workspaceId, c.b);

    const departure = await depart(c, c.a, "delete", c.owner);

    const bookmarks = await bookmarksIn(c.workspaceId);
    expect(bookmarks.filter((row) => row.id === withSlug || row.id === withoutSlug).map((row) => [row.owner_id, row.departure_id])).toEqual([
      [null, departure],
      [null, departure],
    ]);
    expect(bookmarks.find((row) => row.id === others)).toMatchObject({ owner_id: c.b, departure_id: null });
    expect(await foldersIn(c.workspaceId)).toEqual([{ id: folder, name: "Reading", owner_id: null, departure_id: departure }]);
  });

  it("is not set when the removal queues no event, nor when an account's deletion releases the content, and nothing then applies to that content", async () => {
    const c = await cast();
    const removed = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG });
    const deleted = await bookmarkOf(c.workspaceId, c.b);
    await depart(c, c.a, "delete", c.owner, { event: false });
    expect(await inTenant({ accountId: c.b }, (tx) => accountDeletionRepository(tx).delete([], []))).toBe(true);

    expect((await bookmarksIn(c.workspaceId)).map((row) => [row.id, row.owner_id, row.departure_id])).toEqual([
      [removed, null, null],
      [deleted, null, null],
    ]);
    expect(await apply(c.workspaceId, freshId(), "delete", c.owner)).toEqual(NOTHING);
    expect(await bookmarksIn(c.workspaceId)).toHaveLength(2);
  });

  it("does not leak into the next statement of the transaction that removes the member", async () => {
    const c = await cast();
    const bookmark = await bookmarkOf(c.workspaceId, c.b);

    await inTenant({ accountId: c.owner, workspaceId: c.workspaceId }, async (tx) => {
      const eventId = freshId();
      await memberRepository(tx).remove(c.a, [{ id: eventId, queue: QUEUE, data: { eventId, workspaceId: c.workspaceId, accountId: c.a, content: "delete", transferTo: c.owner } }]);
      await memberRepository(tx).remove(c.b, []);
    });

    expect((await bookmarksIn(c.workspaceId)).find((row) => row.id === bookmark)).toMatchObject({ owner_id: null, departure_id: null });
  });
});

describe("a departure with the choice delete", () => {
  it("deletes the bookmarks and folders A owned with the shares, the filings and the remembered choices on them, and lowers the counter by the bookmarks it counted", async () => {
    const c = await cast();
    const counted = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const archived = await bookmarkOf(c.workspaceId, c.a, { archived: true });
    const team = await seedTeam(db, c.workspaceId, [c.r]);
    await shareBookmark(db, c.workspaceId, counted, c.a, { accountId: c.b });
    await shareBookmark(db, c.workspaceId, counted, c.a, { teamId: team });
    await shareThroughFolder(db, c.workspaceId, archived, c.a, { accountId: c.b });
    await remember(c.workspaceId, c.b, counted);
    const keep = await bookmarkOf(c.workspaceId, c.b);
    const departure = await depart(c, c.a, "delete", c.owner);
    expect(await counts(c.workspaceId)).toMatchObject({ shares: 3, filings: 1, choices: 1, counter: 2 });

    const applied = await apply(c.workspaceId, departure, "delete", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksDeleted: 2, foldersDeleted: 1 });
    expect((await bookmarksIn(c.workspaceId)).map((row) => row.id)).toEqual([keep]);
    expect(await foldersIn(c.workspaceId)).toEqual([]);
    expect(await counts(c.workspaceId)).toEqual({ shares: 0, filings: 0, choices: 0, counter: 1 });
  });

  it("changes nothing a second time", async () => {
    const c = await cast();
    const bookmark = await bookmarkOf(c.workspaceId, c.a);
    const departure = await depart(c, c.a, "delete", c.owner);
    await bookmarkOf(c.workspaceId, c.b);
    expect(await apply(c.workspaceId, departure, "delete", c.owner)).toMatchObject({ bookmarksDeleted: 1 });
    const after = await workspaceChecksum(db, c.workspaceId);

    expect(await apply(c.workspaceId, departure, "delete", c.owner)).toEqual(NOTHING);

    expect(await workspaceChecksum(db, c.workspaceId)).toBe(after);
    expect((await bookmarksIn(c.workspaceId)).map((row) => row.id)).not.toContain(bookmark);
  });

  it("deletes with a recipient who has left, since the recipient plays no part in it", async () => {
    const c = await cast();
    await bookmarkOf(c.workspaceId, c.a);
    const departure = await depart(c, c.a, "delete", c.r);
    await depart(c, c.r, "delete", c.owner);

    expect(await apply(c.workspaceId, departure, "delete", c.r)).toMatchObject({ bookmarksDeleted: 1 });
  });
});

describe("a departure with the choice transfer", () => {
  it("gives the bookmarks and folders to the recipient, keeps their slugs, filings and shares, and leaves the counter", async () => {
    const c = await cast();
    const bookmark = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const folder = await shareThroughFolder(db, c.workspaceId, bookmark, c.a, { accountId: c.b });
    await shareBookmark(db, c.workspaceId, bookmark, c.a, { accountId: c.b });
    await remember(c.workspaceId, c.b, bookmark);
    const departure = await depart(c, c.a, "transfer", c.owner);

    const applied = await apply(c.workspaceId, departure, "transfer", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksMoved: 1, foldersMoved: 1 });
    expect(await bookmarksIn(c.workspaceId)).toEqual([{ id: bookmark, owner_id: c.owner, slug: SLUG, forwarding: true, departure_id: null }]);
    expect(await foldersIn(c.workspaceId)).toMatchObject([{ id: folder, owner_id: c.owner, departure_id: null }]);
    expect(await counts(c.workspaceId)).toEqual({ shares: 2, filings: 1, choices: 1, counter: 1 });
  });

  it("clears the slug and the forwarding of a bookmark whose slug the recipient already owns, and keeps the slug of the others", async () => {
    const c = await cast();
    await bookmarkOf(c.workspaceId, c.owner, { slug: SLUG, forwarding: true });
    const clashing = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const free = await bookmarkOf(c.workspaceId, c.a, { slug: "docs", forwarding: true });
    const departure = await depart(c, c.a, "transfer", c.owner);

    const applied = await apply(c.workspaceId, departure, "transfer", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksMoved: 2, slugsCleared: 1 });
    const rows = await bookmarksIn(c.workspaceId);
    expect(rows.find((row) => row.id === clashing)).toMatchObject({ owner_id: c.owner, slug: null, forwarding: false, departure_id: null });
    expect(rows.find((row) => row.id === free)).toMatchObject({ owner_id: c.owner, slug: "docs", forwarding: true });
  });

  it("renames a folder whose name the recipient already has to the next free suffix, in the order of their creation, and leaves the others", async () => {
    const c = await cast();
    await folderOf(c.workspaceId, c.owner, "Reading");
    await folderOf(c.workspaceId, c.owner, "Reading (2)");
    const first = await folderOf(c.workspaceId, c.a, "reading");
    const second = await folderOf(c.workspaceId, c.a, "Other");
    const departure = await depart(c, c.a, "transfer", c.owner);

    const applied = await apply(c.workspaceId, departure, "transfer", c.owner);

    expect(applied).toEqual({ ...NOTHING, foldersMoved: 2, foldersRenamed: 1 });
    const folders = await foldersIn(c.workspaceId);
    expect(folders.find((row) => row.id === first)).toMatchObject({ name: "reading (3)", owner_id: c.owner });
    expect(folders.find((row) => row.id === second)).toMatchObject({ name: "Other", owner_id: c.owner });
  });

  it("cuts the base of a long folder name so that the renamed folder stays within 64 characters", async () => {
    const c = await cast();
    const name = "x".repeat(64);
    await folderOf(c.workspaceId, c.owner, name);
    const moved = await folderOf(c.workspaceId, c.a, name);
    const departure = await depart(c, c.a, "transfer", c.owner);

    await apply(c.workspaceId, departure, "transfer", c.owner);

    const renamed = (await foldersIn(c.workspaceId)).find((row) => row.id === moved);
    expect(renamed?.name).toBe(`${"x".repeat(60)} (2)`);
  });

  it("leaves the content ownerless, with no departure left on it, when the recipient has left the workspace", async () => {
    const c = await cast();
    const bookmark = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG });
    const folder = await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "transfer", c.r);
    await depart(c, c.r, "transfer", c.owner, { event: false });

    const applied = await apply(c.workspaceId, departure, "transfer", c.r);

    expect(applied).toEqual({ ...NOTHING, leftOwnerless: 2 });
    expect(await bookmarksIn(c.workspaceId)).toEqual([{ id: bookmark, owner_id: null, slug: SLUG, forwarding: false, departure_id: null }]);
    expect(await foldersIn(c.workspaceId)).toEqual([{ id: folder, name: "Reading", owner_id: null, departure_id: null }]);
    expect(await apply(c.workspaceId, departure, "transfer", c.r)).toEqual(NOTHING);
  });

  it("changes nothing a second time", async () => {
    const c = await cast();
    await bookmarkOf(c.workspaceId, c.a, { slug: SLUG });
    await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "transfer", c.owner);
    await apply(c.workspaceId, departure, "transfer", c.owner);
    const after = await workspaceChecksum(db, c.workspaceId);

    expect(await apply(c.workspaceId, departure, "transfer", c.owner)).toEqual(NOTHING);

    expect(await workspaceChecksum(db, c.workspaceId)).toBe(after);
  });
});

/** What the release saved of the slug, the forwarding and the name a departure's content had before the ownerless namespace forced others on it. */
async function savedBy(workspaceId: string): Promise<{ bookmarks: [string, string | null, boolean | null][]; folders: [string, string | null][] }> {
  return asSystem(db, async (tx) => ({
    bookmarks: (
      await tx<{ id: string; departure_slug: string | null; departure_forwarding: boolean | null }[]>`
        SELECT id, departure_slug, departure_forwarding FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY id`
    ).map((row) => [row.id, row.departure_slug, row.departure_forwarding]),
    folders: (
      await tx<{ id: string; departure_name: string | null }[]>`SELECT id, departure_name::text AS departure_name FROM folders WHERE workspace_id = ${workspaceId} ORDER BY id`
    ).map((row) => [row.id, row.departure_name]),
  }));
}

describe("content that held a slug or a name an ownerless row already had", () => {
  /** B's account is deleted, so B's bookmark with the slug and B's folder with the name become ownerless Former-member content. */
  async function ownerlessClash(c: Cast): Promise<{ ownerlessBookmark: string; ownerlessFolder: string }> {
    const ownerlessBookmark = await bookmarkOf(c.workspaceId, c.b, { slug: SLUG });
    const ownerlessFolder = await folderOf(c.workspaceId, c.b, "Reading");
    expect(await inTenant({ accountId: c.b }, (tx) => accountDeletionRepository(tx).delete([], []))).toBe(true);
    return { ownerlessBookmark, ownerlessFolder };
  }

  it("reaches the recipient with its slug, forwarding and name when the recipient owns neither", async () => {
    const c = await cast();
    const { ownerlessBookmark, ownerlessFolder } = await ownerlessClash(c);
    const bookmark = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const folder = await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "transfer", c.owner);
    expect(await savedBy(c.workspaceId)).toEqual({
      bookmarks: expect.arrayContaining([[bookmark, SLUG, true]]) as unknown,
      folders: expect.arrayContaining([[folder, "Reading"]]) as unknown,
    });

    const applied = await apply(c.workspaceId, departure, "transfer", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksMoved: 1, foldersMoved: 1 });
    const bookmarks = await bookmarksIn(c.workspaceId);
    expect(bookmarks.find((row) => row.id === bookmark)).toEqual({ id: bookmark, owner_id: c.owner, slug: SLUG, forwarding: true, departure_id: null });
    expect(bookmarks.find((row) => row.id === ownerlessBookmark)).toMatchObject({ owner_id: null, slug: SLUG });
    const folders = await foldersIn(c.workspaceId);
    expect(folders.find((row) => row.id === folder)).toMatchObject({ owner_id: c.owner, name: "Reading", departure_id: null });
    expect(folders.find((row) => row.id === ownerlessFolder)).toMatchObject({ owner_id: null, name: "Reading" });
    const saved = await savedBy(c.workspaceId);
    expect(saved.bookmarks.every(([, slug, forwarding]) => slug === null && forwarding === null)).toBe(true);
    expect(saved.folders.every(([, name]) => name === null)).toBe(true);
  });

  it("clears the slug and renames the folder, and counts them, only where the recipient owns them", async () => {
    const c = await cast();
    await ownerlessClash(c);
    await bookmarkOf(c.workspaceId, c.owner, { slug: SLUG, forwarding: true });
    await folderOf(c.workspaceId, c.owner, "Reading");
    const bookmark = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const folder = await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "transfer", c.owner);

    const applied = await apply(c.workspaceId, departure, "transfer", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksMoved: 1, foldersMoved: 1, slugsCleared: 1, foldersRenamed: 1 });
    expect((await bookmarksIn(c.workspaceId)).find((row) => row.id === bookmark)).toMatchObject({ owner_id: c.owner, slug: null, forwarding: false });
    expect((await foldersIn(c.workspaceId)).find((row) => row.id === folder)).toMatchObject({ owner_id: c.owner, name: "Reading (2)" });
  });

  it("gives the slug back to a second departure's content that was released before the first was applied", async () => {
    const c = await cast();
    const first = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const firstFolder = await folderOf(c.workspaceId, c.a, "Reading");
    const second = await bookmarkOf(c.workspaceId, c.r, { slug: SLUG, forwarding: true });
    const secondFolder = await folderOf(c.workspaceId, c.r, "Reading");
    const firstDeparture = await depart(c, c.a, "transfer", c.owner);
    const secondDeparture = await depart(c, c.r, "transfer", c.b);
    expect(await savedBy(c.workspaceId)).toMatchObject({ bookmarks: expect.arrayContaining([[second, SLUG, true]]) as unknown });

    expect(await apply(c.workspaceId, firstDeparture, "transfer", c.owner)).toEqual({ ...NOTHING, bookmarksMoved: 1, foldersMoved: 1 });
    expect(await apply(c.workspaceId, secondDeparture, "transfer", c.b)).toEqual({ ...NOTHING, bookmarksMoved: 1, foldersMoved: 1 });

    const bookmarks = await bookmarksIn(c.workspaceId);
    expect(bookmarks.find((row) => row.id === first)).toMatchObject({ owner_id: c.owner, slug: SLUG, forwarding: true });
    expect(bookmarks.find((row) => row.id === second)).toMatchObject({ owner_id: c.b, slug: SLUG, forwarding: true });
    const folders = await foldersIn(c.workspaceId);
    expect(folders.find((row) => row.id === firstFolder)).toMatchObject({ owner_id: c.owner, name: "Reading" });
    expect(folders.find((row) => row.id === secondFolder)).toMatchObject({ owner_id: c.b, name: "Reading" });
  });

  it("is deleted with the rest of the departure's content by the choice delete, and the ownerless rows stay", async () => {
    const c = await cast();
    const { ownerlessBookmark, ownerlessFolder } = await ownerlessClash(c);
    await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "delete", c.owner);

    const applied = await apply(c.workspaceId, departure, "delete", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksDeleted: 1, foldersDeleted: 1 });
    expect((await bookmarksIn(c.workspaceId)).map((row) => row.id)).toEqual([ownerlessBookmark]);
    expect((await foldersIn(c.workspaceId)).map((row) => row.id)).toEqual([ownerlessFolder]);
  });

  it("stays ownerless with the slug cleared and the name changed, and nothing saved, when the recipient has left", async () => {
    const c = await cast();
    const { ownerlessBookmark, ownerlessFolder } = await ownerlessClash(c);
    const bookmark = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG, forwarding: true });
    const folder = await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "transfer", c.r);
    await depart(c, c.r, "transfer", c.owner, { event: false });

    const applied = await apply(c.workspaceId, departure, "transfer", c.r);

    expect(applied).toEqual({ ...NOTHING, leftOwnerless: 2 });
    const bookmarks = await bookmarksIn(c.workspaceId);
    expect(bookmarks.find((row) => row.id === bookmark)).toEqual({ id: bookmark, owner_id: null, slug: null, forwarding: false, departure_id: null });
    expect(bookmarks.find((row) => row.id === ownerlessBookmark)).toMatchObject({ owner_id: null, slug: SLUG });
    const folders = await foldersIn(c.workspaceId);
    expect(folders.find((row) => row.id === folder)).toEqual({ id: folder, name: "Reading (2)", owner_id: null, departure_id: null });
    expect(folders.find((row) => row.id === ownerlessFolder)).toMatchObject({ owner_id: null, name: "Reading" });
    const saved = await savedBy(c.workspaceId);
    expect(saved.bookmarks.every(([, slug, forwarding]) => slug === null && forwarding === null)).toBe(true);
    expect(saved.folders.every(([, name]) => name === null)).toBe(true);
    expect(await apply(c.workspaceId, departure, "transfer", c.r)).toEqual(NOTHING);
  });
});

describe("a member who joined again, and a second departure", () => {
  it("leaves the content of the member's new membership alone when the first departure is applied late", async () => {
    const c = await cast();
    await bookmarkOf(c.workspaceId, c.a, { slug: SLUG });
    await folderOf(c.workspaceId, c.a, "Reading");
    const departure = await depart(c, c.a, "delete", c.owner);
    await seedMember(db, { workspaceId: c.workspaceId, accountId: c.a, role: "member" });
    const fresh = await bookmarkOf(c.workspaceId, c.a, { slug: "new" });
    const freshFolder = await folderOf(c.workspaceId, c.a, "Fresh");

    const applied = await apply(c.workspaceId, departure, "delete", c.owner);

    expect(applied).toEqual({ ...NOTHING, bookmarksDeleted: 1, foldersDeleted: 1 });
    expect((await bookmarksIn(c.workspaceId)).map((row) => [row.id, row.owner_id])).toEqual([[fresh, c.a]]);
    expect((await foldersIn(c.workspaceId)).map((row) => [row.id, row.owner_id])).toEqual([[freshFolder, c.a]]);
  });

  it("applies each departure's own choice to its own content when both are delivered late and in the other order", async () => {
    const c = await cast();
    await bookmarkOf(c.workspaceId, c.a);
    const firstDeparture = await depart(c, c.a, "delete", c.owner);
    await seedMember(db, { workspaceId: c.workspaceId, accountId: c.a, role: "member" });
    const second = await bookmarkOf(c.workspaceId, c.a);
    const secondDeparture = await depart(c, c.a, "transfer", c.owner);

    expect(await apply(c.workspaceId, secondDeparture, "transfer", c.owner)).toEqual({ ...NOTHING, bookmarksMoved: 1 });
    expect(await apply(c.workspaceId, firstDeparture, "delete", c.owner)).toEqual({ ...NOTHING, bookmarksDeleted: 1 });

    expect((await bookmarksIn(c.workspaceId)).map((row) => [row.id, row.owner_id])).toEqual([[second, c.owner]]);
  });
});

describe("the operation's own guards", () => {
  async function released(): Promise<{ c: Cast; departure: string; bookmark: string }> {
    const c = await cast();
    const bookmark = await bookmarkOf(c.workspaceId, c.a, { slug: SLUG });
    const departure = await depart(c, c.a, "delete", c.owner);
    return { c, departure, bookmark };
  }

  async function call(tx: postgres.TransactionSql, workspaceId: string, departure: string, content: string, recipient: string): Promise<unknown> {
    const rows = await tx`SELECT * FROM public.sys_member_departure_apply(${workspaceId}::uuid, ${departure}::uuid, ${content}::text, ${recipient}::uuid)`;
    return rows[0];
  }

  async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
      return { value: await work(tx) };
    });
    return result.value;
  }

  it("deletes nothing of workspace A in a transaction that acts in workspace B, or in none, or for no account, or for a member other than the recipient", async () => {
    const { c, departure } = await released();
    const other = await cast();
    const before = await workspaceChecksum(db, c.workspaceId);

    const inOther = await appAs({ accountId: other.owner, workspaceId: other.workspaceId }, (tx) => call(tx, c.workspaceId, departure, "delete", c.owner));
    const inNone = await appAs({ accountId: c.owner }, (tx) => call(tx, c.workspaceId, departure, "delete", c.owner));
    const noAccount = await appAs({ accountId: "", workspaceId: c.workspaceId }, (tx) => call(tx, c.workspaceId, departure, "delete", c.owner));
    const notRecipient = await appAs({ accountId: c.b, workspaceId: c.workspaceId }, (tx) => call(tx, c.workspaceId, departure, "transfer", c.owner));

    for (const answer of [inOther, inNone, noAccount, notRecipient]) {
      expect(answer).toMatchObject({ bookmarks_deleted: 0, folders_deleted: 0, bookmarks_moved: 0 });
    }
    expect(await workspaceChecksum(db, c.workspaceId)).toBe(before);
    expect(await bookmarksIn(c.workspaceId)).toHaveLength(1);
  });

  it("changes nothing in a workspace that is being deleted", async () => {
    const { c, departure } = await released();
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${c.workspaceId}`);

    expect(await apply(c.workspaceId, departure, "delete", c.owner)).toEqual(NOTHING);

    expect(await bookmarksIn(c.workspaceId)).toHaveLength(1);
  });

  it("refuses a content choice other than transfer and delete, and a missing argument, and writes nothing", async () => {
    const { c, departure } = await released();

    for (const content of ["purge", "", "DELETE"]) {
      await expect(appAs({ accountId: c.owner, workspaceId: c.workspaceId }, (tx) => call(tx, c.workspaceId, departure, content, c.owner))).rejects.toMatchObject({
        code: "22023",
      });
    }
    await expect(
      appAs({ accountId: c.owner, workspaceId: c.workspaceId }, (tx) => tx`SELECT * FROM public.sys_member_departure_apply(${c.workspaceId}::uuid, NULL::uuid, 'delete'::text, ${c.owner}::uuid)`),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await bookmarksIn(c.workspaceId)).toHaveLength(1);
  });

  it("is applied in the transaction of the call: a failure after it leaves the content as it was", async () => {
    const { c, departure } = await released();

    await expect(
      inTenant({ accountId: c.owner, workspaceId: c.workspaceId }, async (tx) => {
        await memberRepository(tx).applyDeparture({ departureId: departure, content: "delete", recipientId: c.owner });
        throw new Error("the delivery failed after the operation ran");
      }),
    ).rejects.toThrow("the delivery failed");

    expect(await bookmarksIn(c.workspaceId)).toHaveLength(1);
    expect(await apply(c.workspaceId, departure, "delete", c.owner)).toMatchObject({ bookmarksDeleted: 1 });
  });
});
