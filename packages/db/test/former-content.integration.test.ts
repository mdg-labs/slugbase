import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formerContentRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The former members' content of a workspace (doc 02 section 2.10, doc 05 sections 2.4 and 7.5, doc 10 T1 and T2). The failure scenario: the policies of
// `bookmarks` and `folders` name the workspace only, so a list that filters on the workspace alone returns another member's private bookmark, and a
// bookmark that a departure still holds, to an admin. The lists hold the rows with no owner and no departure, and for bookmarks no plan-archived one, of
// the workspace of the transaction and no other.

const HOOK_TIMEOUT_MS = 300_000;
const DEPARTURE = "0192f3a0-dddd-7000-8000-000000000001";
const ANY_DATE: unknown = expect.any(Date);

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
  await seedAccount(db, { id, email: `former-content${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly admin: string;
  readonly member: string;
}

async function workspaceOf(): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Former content test" });
  const admin = await account();
  const member = await account();
  await seedMember(db, { workspaceId: id, accountId: admin, role: "owner" });
  await seedMember(db, { workspaceId: id, accountId: member, role: "member" });
  return { id, admin, member };
}

interface SeedBookmark {
  readonly workspaceId: string;
  readonly ownerId?: string | null;
  readonly departureId?: string | null;
  readonly planArchivedAt?: Date | null;
  readonly title: string;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
}

async function seedBookmark(bookmark: SeedBookmark): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, departure_id, plan_archived_at, url, url_canonical, host, title, slug, forwarding)
      VALUES (${id}, ${bookmark.workspaceId}, ${bookmark.ownerId ?? null}, ${bookmark.departureId ?? null}, ${bookmark.planArchivedAt ?? null},
              'https://example.com/former', 'https://example.com/former', 'example.com', ${bookmark.title}, ${bookmark.slug ?? null}, ${bookmark.forwarding ?? false})`,
  );
  return id;
}

async function seedFolder(workspaceId: string, name: string, options: { ownerId?: string | null; departureId?: string | null } = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, departure_id, name, icon, color) VALUES (${id}, ${workspaceId}, ${options.ownerId ?? null}, ${options.departureId ?? null}, ${name}, 'book', 3)`,
  );
  return id;
}

async function file(workspaceId: string, folderId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`);
}

async function inWorkspace<T>(workspace: Workspace, work: (repository: ReturnType<typeof formerContentRepository>) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ accountId: workspace.admin, workspaceId: workspace.id, requestId: "former-content-test" }, (tx) => work(formerContentRepository(tx)));
}

describe("the former members' bookmarks of a workspace", () => {
  it("lists the bookmarks that have no owner and no departure and are not plan-archived, and no other row of the workspace or of another one", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const listed = [
      await seedBookmark({ workspaceId: workspace.id, title: "Ownerless one", slug: "former-one", forwarding: true }),
      await seedBookmark({ workspaceId: workspace.id, title: "Ownerless two" }),
    ];
    await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.member, title: "A member's private bookmark" });
    await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.admin, title: "The admin's own bookmark" });
    await seedBookmark({ workspaceId: workspace.id, departureId: DEPARTURE, title: "Waiting for its departure" });
    await seedBookmark({ workspaceId: workspace.id, planArchivedAt: new Date(), title: "Plan-archived" });
    await seedBookmark({ workspaceId: other.id, title: "Ownerless in another workspace" });
    await seedBookmark({ workspaceId: other.id, ownerId: other.member, title: "Owned in another workspace" });

    const rows = await inWorkspace(workspace, (repository) => repository.listBookmarks(null, 50));

    expect(rows.map((row) => row.id)).toEqual(listed);
    expect(rows.map((row) => row.title)).toEqual(["Ownerless one", "Ownerless two"]);
    expect(rows[0]).toEqual({
      id: listed[0],
      title: "Ownerless one",
      url: "https://example.com/former",
      host: "example.com",
      slug: "former-one",
      forwarding: true,
      createdAt: ANY_DATE,
      updatedAt: ANY_DATE,
    });
    expect(rows[1]?.slug).toBeNull();
    expect(rows[1]?.forwarding).toBe(false);
  });

  it("pages in the order of the identifiers: a page after an identifier holds the rows after it, at most the limit", async () => {
    const workspace = await workspaceOf();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await seedBookmark({ workspaceId: workspace.id, title: `Page ${String(index)}` }));
    }
    const first = await inWorkspace(workspace, (repository) => repository.listBookmarks(null, 2));
    const second = await inWorkspace(workspace, (repository) => repository.listBookmarks(first.at(-1)?.id ?? null, 2));
    const third = await inWorkspace(workspace, (repository) => repository.listBookmarks(second.at(-1)?.id ?? null, 2));
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(second.map((row) => row.id)).toEqual(ids.slice(2, 4));
    expect(third.map((row) => row.id)).toEqual(ids.slice(4));
  });

  it("lists nothing of a workspace in which the transaction does not act, and refuses a transaction opened without a workspace", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    await seedBookmark({ workspaceId: other.id, title: "Ownerless in another workspace" });
    expect(await inWorkspace(workspace, (repository) => repository.listBookmarks(null, 50))).toEqual([]);
    await expect(
      db.tenant.withTenant({ accountId: workspace.admin, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).listBookmarks(null, 50)),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the former members' folders of a workspace", () => {
  it("lists the folders that have no owner and no departure, with the count of the listed bookmarks filed in each, and no other row", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const reading = await seedFolder(workspace.id, "Reading");
    const empty = await seedFolder(workspace.id, "Empty");
    const owned = await seedFolder(workspace.id, "A member's folder", { ownerId: workspace.member });
    await seedFolder(workspace.id, "Waiting for its departure", { departureId: DEPARTURE });
    await seedFolder(other.id, "Ownerless in another workspace");
    const counted = [await seedBookmark({ workspaceId: workspace.id, title: "Filed one" }), await seedBookmark({ workspaceId: workspace.id, title: "Filed two" })];
    for (const bookmarkId of counted) {
      await file(workspace.id, reading, bookmarkId);
    }
    // Filed in the folder and not counted: archived by the plan, held by a departure, and a bookmark a member owns.
    await file(workspace.id, reading, await seedBookmark({ workspaceId: workspace.id, planArchivedAt: new Date(), title: "Archived" }));
    await file(workspace.id, reading, await seedBookmark({ workspaceId: workspace.id, departureId: DEPARTURE, title: "Waiting" }));
    await file(workspace.id, reading, await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.member, title: "A member's" }));
    await file(workspace.id, owned, await seedBookmark({ workspaceId: workspace.id, ownerId: workspace.member, title: "In a member's folder" }));

    const rows = await inWorkspace(workspace, (repository) => repository.listFolders(null, 50));

    expect(rows).toEqual([
      { id: reading, name: "Reading", icon: "book", color: 3, bookmarkCount: 2, createdAt: ANY_DATE },
      { id: empty, name: "Empty", icon: "book", color: 3, bookmarkCount: 0, createdAt: ANY_DATE },
    ]);
  });

  it("pages in the order of the identifiers", async () => {
    const workspace = await workspaceOf();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await seedFolder(workspace.id, `Page ${String(index)}`));
    }
    const first = await inWorkspace(workspace, (repository) => repository.listFolders(null, 2));
    const second = await inWorkspace(workspace, (repository) => repository.listFolders(first.at(-1)?.id ?? null, 2));
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(second.map((row) => row.id)).toEqual(ids.slice(2));
  });

  it("lists nothing of another workspace, and refuses a transaction opened without a workspace", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    await seedFolder(other.id, "Ownerless in another workspace");
    expect(await inWorkspace(workspace, (repository) => repository.listFolders(null, 50))).toEqual([]);
    await expect(
      db.tenant.withTenant({ accountId: workspace.admin, requestId: "former-content-test" }, (tx) => formerContentRepository(tx).listFolders(null, 50)),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});
