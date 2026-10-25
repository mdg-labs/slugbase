import type { NewBookmark } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, folderRepository, listRepositoryMethods } from "../src/index.ts";
import { foldersOfBookmarksQuery } from "../src/repositories/folder-links.ts";
import { listQuery } from "../src/repositories/bookmarks.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Filing bookmarks in folders (doc 05 section 2.4, doc 02 sections 7.1 and 8.2, doc 13 Q22, doc 10 T1 and T2). The failure scenario: member A
// files A's bookmark into member B's folder, B's bookmark into A's folder, and a bookmark or a folder of another workspace into one of this one,
// through the repository and with the application layer left out, and every one of them is refused with no link written. Besides that: a request
// that names one bookmark too many files none, the policies of `folder_bookmarks` admit a link of the account's own folder and bookmark only,
// a bookmark is filed in the folders its creation and its change name, a list can be narrowed to one folder of the caller's, and the list that
// does it reads the links of the folder through the primary key of `folder_bookmarks` and not the table of bookmarks.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";

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
  await seedAccount(db, { id, email: `filing${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(members: readonly string[]): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Filing test" });
  for (const [index, accountId] of members.entries()) {
    await seedMember(db, { workspaceId: id, accountId, role: index === 0 ? "owner" : "member" });
  }
  return { id, members };
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "filing-test" }, work);
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

async function seedFolder(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function seedBookmark(workspaceId: string, ownerId: string, archived = false): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed', ${archived ? new Date() : null})`,
  );
  return id;
}

async function linksOf(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ link: string }[]>`SELECT folder_id || '/' || bookmark_id AS link FROM folder_bookmarks WHERE workspace_id = ${workspaceId} ORDER BY 1`);
  return rows.map((row) => row.link);
}

function newBookmark(ownerId: string, title = "Filed"): NewBookmark {
  return { id: freshId(), ownerId, url: "https://example.com/filed", urlCanonical: "https://example.com/filed", host: "example.com", title, description: null, pinned: false };
}

describe("the failure scenario: filing across members and workspaces files nothing (T1, T2)", () => {
  it("refuses A's bookmark into B's folder and B's bookmark into A's folder, and no link is written", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const folderOfA = await seedFolder(workspace.id, a, "Of A");
    const folderOfB = await seedFolder(workspace.id, b, "Of B");
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    const bookmarkOfB = await seedBookmark(workspace.id, b);

    const request = (folderId: string, bookmarkIds: string[]) => ({ folderId, ownerId: a, bookmarkIds });
    expect(await inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => folderRepository(tx).file(request(folderOfB, [bookmarkOfA])))).toEqual({ kind: "not_found" });
    expect(await inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => folderRepository(tx).file(request(folderOfA, [bookmarkOfB])))).toEqual({ kind: "not_found" });
    expect(await inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => folderRepository(tx).file(request(folderOfA, [bookmarkOfA, bookmarkOfB])))).toEqual({ kind: "not_found" });

    expect(await linksOf(workspace.id)).toEqual([]);
  });

  it("refuses a folder or a bookmark of another workspace, whichever side it is on, and no link is written", async () => {
    const [a, b] = [await account(), await account()];
    const first = await workspaceOf([a]);
    const second = await workspaceOf([a, b]);
    const folderHere = await seedFolder(first.id, a, "Here");
    const folderThere = await seedFolder(second.id, a, "There");
    const bookmarkHere = await seedBookmark(first.id, a);
    const bookmarkThere = await seedBookmark(second.id, a);
    const asA = { accountId: a, workspaceId: first.id };

    expect(await inTenant(asA, (tx) => folderRepository(tx).file({ folderId: folderThere, ownerId: a, bookmarkIds: [bookmarkHere] }))).toEqual({ kind: "not_found" });
    expect(await inTenant(asA, (tx) => folderRepository(tx).file({ folderId: folderHere, ownerId: a, bookmarkIds: [bookmarkThere] }))).toEqual({ kind: "not_found" });
    expect(await inTenant(asA, (tx) => folderRepository(tx).file({ folderId: folderHere, ownerId: a, bookmarkIds: [bookmarkHere, bookmarkThere] }))).toEqual({ kind: "not_found" });

    expect(await linksOf(first.id)).toEqual([]);
    expect(await linksOf(second.id)).toEqual([]);
  });

  it("refuses the same statements with the application layer left out: the policies of folder_bookmarks stand alone", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const other = await workspaceOf([a]);
    const folderOfA = await seedFolder(workspace.id, a, "Of A");
    const folderOfB = await seedFolder(workspace.id, b, "Of B");
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    const bookmarkOfB = await seedBookmark(workspace.id, b);
    const folderElsewhere = await seedFolder(other.id, a, "Elsewhere");
    const bookmarkElsewhere = await seedBookmark(other.id, a);
    const asA = { accountId: a, workspaceId: workspace.id };
    const insert = (workspaceId: string, folderId: string, bookmarkId: string) =>
      appAs(asA, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`);

    expect(await refusedWith(insert(workspace.id, folderOfB, bookmarkOfA))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(workspace.id, folderOfA, bookmarkOfB))).toBe(INSUFFICIENT_PRIVILEGE);
    // The workspace of the row is not the active one.
    expect(await refusedWith(insert(other.id, folderElsewhere, bookmarkElsewhere))).toBe(INSUFFICIENT_PRIVILEGE);
    // The row names the active workspace but a folder or a bookmark that is in another: the policy cannot see it.
    expect(await refusedWith(insert(workspace.id, folderElsewhere, bookmarkOfA))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(workspace.id, folderOfA, bookmarkElsewhere))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await linksOf(other.id)).toEqual([]);

    await insert(workspace.id, folderOfA, bookmarkOfA);
    expect(await linksOf(workspace.id)).toEqual([`${folderOfA}/${bookmarkOfA}`]);
  });

  it("lets another member delete none of a member's links, and refuses to update one or to write the time it was added", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const folderOfA = await seedFolder(workspace.id, a, "Of A");
    const bookmarkOfA = await seedBookmark(workspace.id, a);
    await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspace.id}, ${folderOfA}, ${bookmarkOfA})`);

    const asB = { accountId: b, workspaceId: workspace.id };
    expect(await appAs(asB, (tx) => tx`DELETE FROM folder_bookmarks WHERE folder_id = ${folderOfA} RETURNING folder_id`)).toHaveLength(0);
    expect(await linksOf(workspace.id)).toEqual([`${folderOfA}/${bookmarkOfA}`]);

    const asA = { accountId: a, workspaceId: workspace.id };
    expect(await refusedWith(appAs(asA, (tx) => tx`UPDATE folder_bookmarks SET added_at = now()`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(asA, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id, added_at) VALUES (${workspace.id}, ${folderOfA}, ${freshId()}, now())`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await appAs(asA, (tx) => tx`DELETE FROM folder_bookmarks WHERE folder_id = ${folderOfA} RETURNING folder_id`)).toHaveLength(1);
    expect(await linksOf(workspace.id)).toEqual([]);
  });
});

describe("the scoped repository of the links, as the cross-tenant matrix runs it", () => {
  function method(name: "select" | "insert" | "delete") {
    const found = listRepositoryMethods().find((entry) => entry.repository === "folder_bookmarks" && entry.method === name);
    if (found === undefined) {
      throw new Error(`the registry has no folder_bookmarks.${name}`);
    }
    return found;
  }

  it("is in the registry with the methods the application role may run, and reads a link back by its composite key", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const folder = await seedFolder(workspace.id, a, "Matrix");
    const bookmark = await seedBookmark(workspace.id, a);
    const as = { accountId: a, workspaceId: workspace.id };

    const inserted = await inTenant(as, (tx) => method("insert").invoke(tx, { values: { folderId: folder, bookmarkId: bookmark } }));

    expect(listRepositoryMethods().filter((entry) => entry.repository === "folder_bookmarks").map((entry) => entry.method)).toEqual(["select", "insert", "delete"]);
    expect(inserted).toMatchObject([{ workspaceId: workspace.id, folderId: folder, bookmarkId: bookmark }]);
    expect(await linksOf(workspace.id)).toEqual([`${folder}/${bookmark}`]);
  });

  it("is refused by the policy alone when the row names another workspace than the active one", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const other = await workspaceOf([a]);
    const folder = await seedFolder(workspace.id, a, "Matrix");
    const bookmark = await seedBookmark(workspace.id, a);

    const refused = await refusedWith(
      inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => method("insert").invokeRlsOnly(tx, { values: { workspaceId: other.id, folderId: folder, bookmarkId: bookmark } })),
    );

    expect(refused).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await linksOf(other.id)).toEqual([]);
  });
});

describe("FolderRepository.file and unfile", () => {
  it("files the bookmarks, answers the folder with its count, and files again without a change", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const folder = await seedFolder(workspace.id, a, "Reading");
    const bookmarks = [await seedBookmark(workspace.id, a), await seedBookmark(workspace.id, a)];
    const as = { accountId: a, workspaceId: workspace.id };

    const first = await inTenant(as, (tx) => folderRepository(tx).file({ folderId: folder, ownerId: a, bookmarkIds: bookmarks }));
    const again = await inTenant(as, (tx) => folderRepository(tx).file({ folderId: folder, ownerId: a, bookmarkIds: bookmarks }));

    expect(first).toMatchObject({ kind: "done", changed: 2, folder: { id: folder, bookmarkCount: 2, version: 1 } });
    expect(again).toMatchObject({ kind: "done", changed: 0, folder: { bookmarkCount: 2 } });
    expect(await linksOf(workspace.id)).toEqual(bookmarks.map((id) => `${folder}/${id}`).sort());
  });

  it("files none when one bookmark is another member's, a plan-archived one or unknown, and unfiles none when one is another member's or unknown", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const folder = await seedFolder(workspace.id, a, "Reading");
    const own = await seedBookmark(workspace.id, a);
    const archived = await seedBookmark(workspace.id, a, true);
    const theirs = await seedBookmark(workspace.id, b);
    const as = { accountId: a, workspaceId: workspace.id };
    await inTenant(as, (tx) => folderRepository(tx).file({ folderId: folder, ownerId: a, bookmarkIds: [own] }));

    for (const bad of [theirs, archived, freshId()]) {
      expect(await inTenant(as, (tx) => folderRepository(tx).file({ folderId: folder, ownerId: a, bookmarkIds: [own, bad] }))).toEqual({ kind: "not_found" });
    }
    for (const bad of [theirs, freshId()]) {
      expect(await inTenant(as, (tx) => folderRepository(tx).unfile({ folderId: folder, ownerId: a, bookmarkIds: [own, bad] }))).toEqual({ kind: "not_found" });
    }
    expect(await linksOf(workspace.id)).toEqual([`${folder}/${own}`]);
  });

  it("takes bookmarks out of the folder, a plan-archived one included, and leaves the bookmarks", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const folder = await seedFolder(workspace.id, a, "Reading");
    const own = await seedBookmark(workspace.id, a);
    const archived = await seedBookmark(workspace.id, a, true);
    await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) SELECT ${workspace.id}, ${folder}, id FROM bookmarks WHERE id IN ${tx([own, archived])}`);
    const as = { accountId: a, workspaceId: workspace.id };

    const taken = await inTenant(as, (tx) => folderRepository(tx).unfile({ folderId: folder, ownerId: a, bookmarkIds: [own, archived] }));
    const again = await inTenant(as, (tx) => folderRepository(tx).unfile({ folderId: folder, ownerId: a, bookmarkIds: [own, archived] }));

    expect(taken).toMatchObject({ kind: "done", changed: 2, folder: { bookmarkCount: 0 } });
    expect(again).toMatchObject({ kind: "done", changed: 0 });
    expect(await linksOf(workspace.id)).toEqual([]);
    expect(await asSystem(db, (tx) => tx`SELECT id FROM bookmarks WHERE workspace_id = ${workspace.id}`)).toHaveLength(2);
  });

  it("never acts for an account other than the one of the transaction", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const folder = await seedFolder(workspace.id, b, "Of B");

    await expect(inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => folderRepository(tx).file({ folderId: folder, ownerId: b, bookmarkIds: [] }))).rejects.toThrow("account of the transaction");
  });
});

describe("the folders of a bookmark", () => {
  it("files a new bookmark in the folders its creation names, and answers them in the order of their names", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const [zebra, apple] = [await seedFolder(workspace.id, a, "Zebra"), await seedFolder(workspace.id, a, "apple")];
    const as = { accountId: a, workspaceId: workspace.id };
    const bookmark = newBookmark(a);

    const created = await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], folderIds: [zebra, apple] }));

    expect(created).toMatchObject({ kind: "created", bookmark: { id: bookmark.id, folders: [{ id: apple, name: "apple", icon: "folder", color: 1 }, { id: zebra, name: "Zebra", icon: "folder", color: 1 }] } });
    expect(await linksOf(workspace.id)).toEqual([`${apple}/${bookmark.id}`, `${zebra}/${bookmark.id}`].sort());
    expect((await inTenant(as, (tx) => bookmarkRepository(tx).find(bookmark.id)))?.folders.map((folder) => folder.id)).toEqual([apple, zebra]);
  });

  it("creates nothing, and takes no place under the ceiling, when a folder is another member's, another workspace's or unknown", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const other = await workspaceOf([a]);
    const own = await seedFolder(workspace.id, a, "Own");
    const as = { accountId: a, workspaceId: workspace.id };

    for (const foreign of [await seedFolder(workspace.id, b, "Of B"), await seedFolder(other.id, a, "Elsewhere"), freshId()]) {
      const bookmark = newBookmark(a);
      expect(await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: 5, jobs: [], folderIds: [own, foreign] }))).toEqual({ kind: "folder_not_found" });
    }

    expect(await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${workspace.id}`)).toEqual([{ n: 0 }]);
    expect(await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT bookmark_count AS n FROM workspaces WHERE id = ${workspace.id}`)).toEqual([{ n: 0 }]);
    expect(await linksOf(workspace.id)).toEqual([]);
  });

  it("replaces the folders on a change, keeps the version when only the folders change, and clears them with an empty list", async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const [one, two, three] = [await seedFolder(workspace.id, a, "One"), await seedFolder(workspace.id, a, "Two"), await seedFolder(workspace.id, a, "Three")];
    const as = { accountId: a, workspaceId: workspace.id };
    const bookmark = newBookmark(a);
    await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], folderIds: [one, two] }));
    const update = (folderIds: string[], extra: Record<string, unknown> = {}) =>
      inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { folderIds, ...extra }, expectedVersions: undefined }));

    const same = await update([two, one]);
    const replaced = await update([two, three]);
    const withTitle = await update([two, three], { title: "Renamed" });
    const cleared = await update([]);

    expect(same).toMatchObject({ kind: "unchanged", bookmark: { version: 1, folders: [{ id: one }, { id: two }] } });
    expect(replaced).toMatchObject({ kind: "updated", bookmark: { version: 1, folders: [{ id: three }, { id: two }] } });
    expect(withTitle).toMatchObject({ kind: "updated", bookmark: { version: 2, title: "Renamed", folders: [{ id: three }, { id: two }] } });
    expect(cleared).toMatchObject({ kind: "updated", bookmark: { folders: [] } });
    expect(await linksOf(workspace.id)).toEqual([]);
  });

  it("leaves the bookmark and its folders as they were when a change names a folder that is not the owner's, or a version that is stale", async () => {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const own = await seedFolder(workspace.id, a, "Own");
    const foreign = await seedFolder(workspace.id, b, "Of B");
    const as = { accountId: a, workspaceId: workspace.id };
    const bookmark = newBookmark(a);
    await inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], folderIds: [own] }));

    const refused = await inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { title: "Changed", folderIds: [own, foreign] }, expectedVersions: undefined }));
    const stale = await inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark.id, ownerId: a, changes: { title: "Changed", folderIds: [] }, expectedVersions: [9] }));

    expect(refused).toEqual({ kind: "folder_not_found" });
    expect(stale).toEqual({ kind: "stale" });
    expect(await linksOf(workspace.id)).toEqual([`${own}/${bookmark.id}`]);
    expect((await inTenant(as, (tx) => bookmarkRepository(tx).find(bookmark.id)))?.title).toBe("Filed");
  });
});

describe("the list narrowed to a folder", () => {
  async function library() {
    const [a, b] = [await account(), await account()];
    const workspace = await workspaceOf([a, b]);
    const folder = await seedFolder(workspace.id, a, "Reading");
    const folderOfB = await seedFolder(workspace.id, b, "Of B");
    const inFolder = await seedBookmark(workspace.id, a);
    const outside = await seedBookmark(workspace.id, a);
    const bookmarkOfB = await seedBookmark(workspace.id, b);
    await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspace.id}, ${folder}, ${inFolder}), (${workspace.id}, ${folderOfB}, ${bookmarkOfB})`);
    return { a, b, workspace, folder, folderOfB, inFolder, outside, bookmarkOfB };
  }

  it("lists the bookmarks of the caller that are filed in the folder, counts them, and carries the folders of each", async () => {
    const { a, workspace, folder, inFolder } = await library();
    const as = { accountId: a, workspaceId: workspace.id };
    const filter = { ownerId: a, folderId: folder };

    const rows = await inTenant(as, (tx) => bookmarkRepository(tx).list({ filter, sort: "recent", after: undefined, limit: 10 }));
    const count = await inTenant(as, (tx) => bookmarkRepository(tx).count(filter, 100));
    const ids = await inTenant(as, (tx) => bookmarkRepository(tx).ids(filter, 100));

    expect(rows.map((row) => row.bookmark.id)).toEqual([inFolder]);
    expect(rows[0]?.bookmark.folders).toEqual([{ id: folder, name: "Reading", icon: "folder", color: 1 }]);
    expect(count).toBe(1);
    expect(ids).toEqual([inFolder]);
  });

  it("lists nothing for a folder of another member, of another workspace, or none, whoever's bookmark is filed in it", async () => {
    const { a, workspace, folderOfB, outside } = await library();
    const as = { accountId: a, workspaceId: workspace.id };
    // Even a link of the caller's own bookmark to the other member's folder (one no request can write) shows nothing of that folder.
    await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspace.id}, ${folderOfB}, ${outside})`);

    for (const folderId of [folderOfB, freshId()]) {
      const filter = { ownerId: a, folderId };
      expect(await inTenant(as, (tx) => bookmarkRepository(tx).list({ filter, sort: "recent", after: undefined, limit: 10 }))).toEqual([]);
      expect(await inTenant(as, (tx) => bookmarkRepository(tx).count(filter, 100))).toBe(0);
    }
  });

  it("does not show the folders of another member on a bookmark it reads", async () => {
    const { a, b, workspace, bookmarkOfB } = await library();

    const read = await inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).find(bookmarkOfB));
    const own = await inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).find(bookmarkOfB));

    expect(read?.folders).toEqual([]);
    expect(own?.folders).toHaveLength(1);
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

function planNodes(text: string): PlanNode[] {
  const plan = (JSON.parse(text) as { Plan: PlanNode }[])[0];
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan.Plan);
}

async function explain(tenant: { accountId: string; workspaceId: string }, statement: { sql: string; params: unknown[] }): Promise<{ text: string }> {
  return db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${tenant.accountId}, true), set_config('app.workspace_id', ${tenant.workspaceId}, true)`;
    const rows = await tx.unsafe<{ "QUERY PLAN": unknown[] }[]>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params as never[]);
    return { text: JSON.stringify(rows[0]?.["QUERY PLAN"]) };
  });
}

describe("the plan of the list narrowed to a folder", () => {
  const library = { account: "", workspace: "", folder: "", sample: [] as string[] };

  beforeAll(async () => {
    const a = await account();
    const workspace = await workspaceOf([a]);
    const folder = await seedFolder(workspace.id, a, "Planned");
    await asSystem(db, (tx) => tx`
      INSERT INTO folders (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ${workspace.id}, ${a}, 'Folder ' || n FROM generate_series(1, 199) AS n`);
    await asSystem(db, (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, created_at)
      SELECT gen_random_uuid(), ${workspace.id}, ${a}, 'https://example.com/' || n, 'https://example.com/' || n, 'example.com', 'Title ' || (n % 97), timestamptz '2026-01-01' + n * interval '1 second'
      FROM generate_series(1, 20000) AS n`);
    // 200 folders of 100 bookmarks each; the folder listed is one of them.
    await asSystem(db, (tx) => tx`
      INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id)
      SELECT ${workspace.id}, f.id, b.id
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM bookmarks WHERE workspace_id = ${workspace.id}) AS b
      JOIN (SELECT id, row_number() OVER (ORDER BY (id <> ${folder}), id) AS n FROM folders WHERE workspace_id = ${workspace.id}) AS f ON f.n = (b.n % 200) + 1`);
    await db.owner.unsafe("ANALYZE bookmarks; ANALYZE folder_bookmarks; ANALYZE folders");
    const sample = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM bookmarks WHERE workspace_id = ${workspace.id} ORDER BY created_at DESC LIMIT 48`);
    Object.assign(library, { account: a, workspace: workspace.id, folder, sample: sample.map((row) => row.id) });
  }, HOOK_TIMEOUT_MS);

  it("reads the links of the folder from an index of folder_bookmarks and not from a scan of the table", async () => {
    const as = { accountId: library.account, workspaceId: library.workspace };
    const statement = await inTenant(as, (tx) => Promise.resolve(listQuery(tx, { filter: { ownerId: library.account, folderId: library.folder }, sort: "recent", after: undefined, limit: 49 }).toSQL()));

    // The links of a single folder are read by the key that leads with the folder: an index of the table, not a scan of it.
    const nodes = planNodes((await explain(as, statement)).text);

    expect(nodes.filter((node) => node["Relation Name"] === "folder_bookmarks").map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toContain("folder_bookmarks_pkey");
  });

  it("reads the folders of the bookmarks of a page by the index on (workspace_id, bookmark_id), not from a scan of the links", async () => {
    const as = { accountId: library.account, workspaceId: library.workspace };
    const statement = await inTenant(as, (tx) => Promise.resolve(foldersOfBookmarksQuery(tx, library.account, library.sample).toSQL()));

    const nodes = planNodes((await explain(as, statement)).text);

    expect(nodes.filter((node) => node["Relation Name"] === "folder_bookmarks").map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toContain("folder_bookmarks_bookmark_idx");
  });
});
