import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, folderRepository, isFolderNameTaken, listRepositoryMethods, workspacePurgeOrder } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The folders of a member (doc 05 section 2.4, doc 02 section 7.1, doc 10 T2). The failure scenario: in one workspace member B lists,
// reads, renames and deletes member A's folder by identifier and every call finds nothing, and no member of another workspace sees a row
// of it. Besides that: a name is unique per owner without regard to case, and ownerless folders share one namespace; the version is the
// database's and moves with the name, the icon and the colour; the count of a folder leaves plan-archived bookmarks out; the pages of
// every sort are a keyset that repeats and skips nothing; and the associations of a folder go with it, with the workspace, and leave the
// bookmarks.

const HOOK_TIMEOUT_MS = 300_000;
const CHECK_VIOLATION = "23514";
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
  await seedAccount(db, { id, email: `folders${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 2): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Folders test" });
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
  return db.tenant.withTenant({ ...tenant, requestId: "folders-test" }, work);
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

/** Writes a folder as slugbase_system, which stands for the operations that write in ways a request may not. */
async function seedFolder(workspaceId: string, ownerId: string | null, name: string, id = freshId()): Promise<string> {
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

async function file(workspaceId: string, folderId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`);
}

interface StoredFolder {
  id: string;
  name: string;
  owner_id: string | null;
  icon: string;
  color: number;
  version: number;
}

async function storedFolders(workspaceId: string): Promise<StoredFolder[]> {
  return asSystem(db, (tx) => tx<StoredFolder[]>`SELECT id, name, owner_id, icon, color, version FROM folders WHERE workspace_id = ${workspaceId} ORDER BY name, id`);
}

async function storedFilings(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM folder_bookmarks WHERE workspace_id = ${workspaceId}`);
  return Number(rows[0]?.n);
}

const newFolder = (ownerId: string, name: string, icon = "folder", color = 1) => ({ id: freshId(), ownerId, name, icon, color });

describe("the tables", () => {
  it("has the columns, keys, checks and index of doc 05 section 2.4", async () => {
    const columns = await db.owner<{ table_name: string; column_name: string; is_nullable: string; udt_name: string; column_default: string | null }[]>`
      SELECT table_name, column_name, is_nullable, udt_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('folders', 'folder_bookmarks') ORDER BY table_name, ordinal_position`;
    expect(columns.filter((column) => column.table_name === "folders").map((column) => [column.column_name, column.udt_name, column.is_nullable])).toEqual([
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["owner_id", "uuid", "YES"],
      ["name", "citext", "NO"],
      ["icon", "text", "NO"],
      ["color", "int2", "NO"],
      ["version", "int4", "NO"],
      ["created_at", "timestamptz", "NO"],
      ["updated_at", "timestamptz", "NO"],
    ]);
    const defaults = Object.fromEntries(columns.filter((column) => column.table_name === "folders").map((column) => [column.column_name, column.column_default]));
    expect(defaults["icon"]).toContain("folder");
    expect(defaults["color"]).toBe("1");
    expect(columns.filter((column) => column.table_name === "folder_bookmarks").map((column) => [column.column_name, column.is_nullable])).toEqual([
      ["workspace_id", "NO"],
      ["folder_id", "NO"],
      ["bookmark_id", "NO"],
      ["added_at", "NO"],
    ]);

    const constraints = await db.owner<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('public.folders'::regclass, 'public.folder_bookmarks'::regclass) AND contype <> 'n' ORDER BY conname`;
    const byName = new Map(constraints.map((constraint) => [constraint.conname, constraint.definition]));
    expect([...byName.keys()]).toEqual([
      "folder_bookmarks_bookmark_fkey",
      "folder_bookmarks_folder_fkey",
      "folder_bookmarks_pkey",
      "folders_color_check",
      "folders_icon_check",
      "folders_name_check",
      "folders_owner_fkey",
      "folders_owner_name_key",
      "folders_pkey",
      "folders_workspace_id_id_key",
      "folders_workspace_id_workspaces_id_fk",
    ]);
    expect(byName.get("folders_owner_name_key")).toBe("UNIQUE NULLS NOT DISTINCT (workspace_id, owner_id, name)");
    expect(byName.get("folders_workspace_id_id_key")).toBe("UNIQUE (workspace_id, id)");
    expect(byName.get("folders_owner_fkey")).toBe("FOREIGN KEY (workspace_id, owner_id) REFERENCES workspace_members(workspace_id, account_id) ON DELETE SET NULL (owner_id)");
    expect(byName.get("folders_color_check")).toContain("color >= 1");
    expect(byName.get("folder_bookmarks_pkey")).toBe("PRIMARY KEY (folder_id, bookmark_id)");
    expect(byName.get("folder_bookmarks_folder_fkey")).toBe("FOREIGN KEY (workspace_id, folder_id) REFERENCES folders(workspace_id, id) ON DELETE CASCADE");
    expect(byName.get("folder_bookmarks_bookmark_fkey")).toBe("FOREIGN KEY (workspace_id, bookmark_id) REFERENCES bookmarks(workspace_id, id) ON DELETE CASCADE");

    const indexes = await db.owner<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'folder_bookmarks_bookmark_idx'`;
    expect(indexes[0]?.indexdef).toContain("(workspace_id, bookmark_id)");
  });

  it("has row-level security enabled and forced on both, with every policy naming the workspace", async () => {
    const tables = await db.owner<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('folders', 'folder_bookmarks') ORDER BY relname`;
    expect(tables).toEqual([
      { relname: "folder_bookmarks", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "folders", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const policies = await db.owner<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('folders', 'folder_bookmarks') ORDER BY tablename, policyname`;
    expect(policies.map((policy) => [policy.tablename, policy.policyname, policy.cmd])).toEqual([
      ["folder_bookmarks", "folder_bookmarks_tenant", "SELECT"],
      ["folder_bookmarks", "folder_bookmarks_tenant_delete", "DELETE"],
      ["folder_bookmarks", "folder_bookmarks_tenant_insert", "INSERT"],
      ["folders", "folders_tenant", "SELECT"],
      ["folders", "folders_tenant_delete", "DELETE"],
      ["folders", "folders_tenant_insert", "INSERT"],
      ["folders", "folders_tenant_update", "UPDATE"],
    ]);
    for (const policy of policies) {
      for (const predicate of [policy.qual, policy.with_check]) {
        if (predicate !== null) {
          expect(predicate).toContain("app_workspace_id()");
        }
      }
    }
  });

  it("lets slugbase_app insert the columns of a creation, update the name, the icon and the colour, delete a folder, read the associations and write them only as folder-filing.integration.test.ts shows, and nothing more", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const folder = await seedFolder(workspace.id, owner, "Existing");
    const as = { accountId: owner, workspaceId: workspace.id };

    await appAs(as, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name, icon, color) VALUES (${freshId()}, ${workspace.id}, ${owner}, 'Second', 'star', 4)`);
    await appAs(as, (tx) => tx`UPDATE folders SET name = 'Renamed', icon = 'heart', color = 2 WHERE id = ${folder}`);
    expect(await appAs(as, (tx) => tx`SELECT count(*)::int AS n FROM folder_bookmarks`)).toHaveLength(1);

    for (const attempt of [
      (tx: postgres.TransactionSql) => tx`INSERT INTO folders (id, workspace_id, owner_id, name, version) VALUES (${freshId()}, ${workspace.id}, ${owner}, 'Versioned', 9)`,
      (tx: postgres.TransactionSql) => tx`INSERT INTO folders (id, workspace_id, owner_id, name, created_at) VALUES (${freshId()}, ${workspace.id}, ${owner}, 'Dated', now())`,
      (tx: postgres.TransactionSql) => tx`UPDATE folders SET owner_id = NULL WHERE id = ${folder}`,
      (tx: postgres.TransactionSql) => tx`UPDATE folders SET version = 9 WHERE id = ${folder}`,
      (tx: postgres.TransactionSql) => tx`UPDATE folders SET updated_at = now() WHERE id = ${folder}`,
      (tx: postgres.TransactionSql) => tx`UPDATE folder_bookmarks SET added_at = now()`,
      (tx: postgres.TransactionSql) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspace.id}, ${folder}, ${freshId()})`,
    ]) {
      expect(await refusedWith(appAs(as, attempt))).toBe(INSUFFICIENT_PRIVILEGE);
    }
    await appAs(as, (tx) => tx`DELETE FROM folders WHERE id = ${folder}`);
    expect((await storedFolders(workspace.id)).map((row) => row.name)).toEqual(["Second"]);
  });

  it("refuses a colour outside 1 to 8, an icon of no characters and a name of no characters or more than 64", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const insert = (name: string, icon: string, color: number) => asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name, icon, color) VALUES (${freshId()}, ${workspace.id}, ${owner}, ${name}, ${icon}, ${color})`);

    expect(await refusedWith(insert("Ok", "folder", 0))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("Ok", "folder", 9))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("Ok", "", 1))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("", "folder", 1))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("x".repeat(65), "folder", 1))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("x".repeat(64), "folder", 8))).toBeUndefined();
  });
});

describe("a folder is its owner's alone (T2)", () => {
  it("is not listed, read, changed or deleted by another member of the workspace, who finds nothing at its identifier", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const folderOfA = await seedFolder(workspace.id, a, "Private to A");
    const folderOfB = await seedFolder(workspace.id, b, "Private to B");
    const before = await storedFolders(workspace.id);

    const outcome = await inTenant({ accountId: b, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const page = (sort: "name" | "count" | "updated") => repository.list({ viewerId: b, scope: "mine", search: undefined, sort, after: undefined, limit: 100 });
      return {
        listed: (await page("name")).map((folder) => folder.id),
        listedByCount: (await page("count")).map((folder) => folder.id),
        listedByUpdate: (await page("updated")).map((folder) => folder.id),
        searched: (await repository.list({ viewerId: b, scope: "mine", search: "Private to A", sort: "name", after: undefined, limit: 100 })).map((folder) => folder.id),
        counted: await repository.count({ viewerId: b, scope: "mine", search: undefined, limit: 100 }),
        found: await repository.find({ folderId: folderOfA, viewerId: b }),
        updated: await repository.update({ folderId: folderOfA, ownerId: b, changes: { name: "Taken over", icon: "star", color: 3 }, expectedVersions: undefined }),
        removed: await repository.remove({ folderId: folderOfA, ownerId: b }),
      };
    });

    expect(outcome).toEqual({
      listed: [folderOfB],
      listedByCount: [folderOfB],
      listedByUpdate: [folderOfB],
      searched: [],
      counted: 1,
      found: undefined,
      updated: { kind: "not_found" },
      removed: false,
    });
    expect(await storedFolders(workspace.id)).toEqual(before);
  });

  it("is not read, changed or deleted by an ownerless lookup: a folder whose owner left belongs to no member", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const ownerless = await seedFolder(workspace.id, null, "Former member's");

    const outcome = await inTenant({ accountId: a, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      return {
        listed: await repository.list({ viewerId: a, scope: "mine", search: undefined, sort: "name", after: undefined, limit: 100 }),
        found: await repository.find({ folderId: ownerless, viewerId: a }),
        removed: await repository.remove({ folderId: ownerless, ownerId: a }),
      };
    });

    expect(outcome).toEqual({ listed: [], found: undefined, removed: false });
    expect(b).not.toBe(a);
    expect((await storedFolders(workspace.id)).map((folder) => folder.id)).toEqual([ownerless]);
  });

  it("is seen by no member of another workspace, even with the application's predicates left out: row-level security keeps the workspaces apart", async () => {
    const first = await workspaceOf(1);
    const second = await workspaceOf(1);
    const [a, outsider] = [memberOf(first, 0), memberOf(second, 0)];
    const folderOfA = await seedFolder(first.id, a, "Only in the first");
    const before = await storedFolders(first.id);
    const entry = (method: "select" | "update" | "delete") => {
      const found = listRepositoryMethods().find((candidate) => candidate.repository === "folders" && candidate.method === method);
      if (found === undefined) {
        throw new Error(`the registry has no folders.${method}`);
      }
      return found;
    };

    const outcome = await inTenant({ accountId: outsider, workspaceId: second.id }, async (tx) => ({
      selected: await entry("select").invokeRlsOnly(tx),
      updated: await entry("update").invokeRlsOnly(tx, { set: { name: "Taken over" } }),
      deleted: await entry("delete").invokeRlsOnly(tx),
      through: await folderRepository(tx).find({ folderId: folderOfA, viewerId: outsider }),
    }));
    const raw = await appAs({ accountId: outsider, workspaceId: second.id }, async (tx) => ({
      selected: await tx`SELECT id FROM folders`,
      updated: await tx`UPDATE folders SET name = 'Everyone''s' RETURNING id`,
      deleted: await tx`DELETE FROM folders RETURNING id`,
      filings: await tx`SELECT folder_id FROM folder_bookmarks`,
    }));

    expect(outcome).toEqual({ selected: [], updated: [], deleted: [], through: undefined });
    expect(raw).toEqual({ selected: [], updated: [], deleted: [], filings: [] });
    expect(await storedFolders(first.id)).toEqual(before);
  });

  it("cannot be created in another workspace, with the application's stamp left out", async () => {
    const first = await workspaceOf(1);
    const second = await workspaceOf(1);
    const outsider = memberOf(second, 0);

    const refusal = await refusedWith(
      appAs({ accountId: outsider, workspaceId: second.id }, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${first.id}, NULL, 'Planted')`),
    );

    expect(refusal).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedFolders(first.id)).toEqual([]);
  });

  it("cannot be moved to another workspace by an update", async () => {
    const workspace = await workspaceOf(1);
    const other = await workspaceOf(1);
    const a = memberOf(workspace, 0);
    await seedFolder(workspace.id, a, "Mine");

    await expect(appAs({ accountId: a, workspaceId: workspace.id }, (tx) => tx`UPDATE folders SET workspace_id = ${other.id}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect((await storedFolders(workspace.id)).map((folder) => folder.owner_id)).toEqual([a]);
  });

  it("refuses a request that names an account other than the one of the transaction", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];

    await expect(inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => folderRepository(tx).list({ viewerId: a, scope: "mine", search: undefined, sort: "name", after: undefined, limit: 100 }))).rejects.toThrow(
      "the account of the transaction",
    );
  });
});

describe("the name of a folder", () => {
  it("is stored as entered, and a second folder of the same owner with the same name in any case is name_taken without ending the transaction", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const first = await repository.create(newFolder(owner, "Reading List"));
      const same = await repository.create(newFolder(owner, "Reading List"));
      const lower = await repository.create(newFolder(owner, "reading list"));
      const other = await repository.create(newFolder(owner, "Other"));
      return { first, same, lower, other: other.kind };
    });

    expect(outcome.first).toMatchObject({ kind: "created", folder: { name: "Reading List", icon: "folder", color: 1, version: 1, bookmarkCount: 0, ownerId: owner } });
    expect(outcome.same).toEqual({ kind: "name_taken" });
    expect(outcome.lower).toEqual({ kind: "name_taken" });
    expect(outcome.other).toBe("created");
    expect((await storedFolders(workspace.id)).map((folder) => folder.name)).toEqual(["Other", "Reading List"]);
  });

  it("is free for another owner, and for the same owner in another workspace", async () => {
    const workspace = await workspaceOf(2);
    const other = await workspaceOf(0);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    await seedMember(db, { workspaceId: other.id, accountId: a, role: "member" });

    const created = [
      await inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => folderRepository(tx).create(newFolder(a, "Shared name"))),
      await inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => folderRepository(tx).create(newFolder(b, "SHARED NAME"))),
      await inTenant({ accountId: a, workspaceId: other.id }, (tx) => folderRepository(tx).create(newFolder(a, "Shared name"))),
    ];

    expect(created.map((result) => result.kind)).toEqual(["created", "created", "created"]);
  });

  it("makes one folder of creations of one name at the same time", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => folderRepository(tx).create(newFolder(owner, "Race")))),
    );

    expect(results.map((result) => result.kind).sort()).toEqual(["created", "name_taken", "name_taken", "name_taken"]);
    expect(await storedFolders(workspace.id)).toHaveLength(1);
  });

  it("is taken by a rename to a name another folder of the owner has, in any case, and is free to change in case on the folder itself", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const first = await seedFolder(workspace.id, a, "Alpha");
    await seedFolder(workspace.id, a, "Beta");
    await seedFolder(workspace.id, b, "Gamma");

    const outcome = await inTenant({ accountId: a, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const update = (name: string) => repository.update({ folderId: first, ownerId: a, changes: { name }, expectedVersions: undefined });
      return { taken: await update("BETA"), others: await update("Gamma"), recased: await update("ALPHA") };
    });

    expect(outcome.taken).toEqual({ kind: "name_taken" });
    expect(outcome.others).toMatchObject({ kind: "updated", folder: { name: "Gamma" } });
    // The case of a name is what a member reads, so a change of case moves the version although citext calls the two names equal.
    expect(outcome.recased).toMatchObject({ kind: "updated", folder: { name: "ALPHA", version: 3 } });
  });

  it("is an error the caller can recognise when two renames meet at the key, and leaves the other folder as it was", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const first = await seedFolder(workspace.id, owner, "One");
    const second = await seedFolder(workspace.id, owner, "Two");

    const gate = inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const result = await repository.update({ folderId: first, ownerId: owner, changes: { name: "Same" }, expectedVersions: undefined });
      await sleep(300);
      return result;
    });
    await sleep(100);
    const loser = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) =>
      folderRepository(tx).update({ folderId: second, ownerId: owner, changes: { name: "Same" }, expectedVersions: undefined }),
    ).catch((error: unknown) => error);

    expect((await gate).kind).toBe("updated");
    expect(isFolderNameTaken(loser)).toBe(true);
    expect((await storedFolders(workspace.id)).map((folder) => folder.name)).toEqual(["Same", "Two"]);
  });

  it("is one namespace for the ownerless folders of a workspace, which the key refuses to repeat", async () => {
    const workspace = await workspaceOf(1);
    await seedFolder(workspace.id, null, "Former");

    const refusal = await refusedWith(seedFolder(workspace.id, null, "former"));

    expect(refusal).toBe("23505");
  });
});

describe("a change of a folder", () => {
  it("moves the version and the update time by the name, the icon and the colour, and by nothing it writes unchanged", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const folder = await seedFolder(workspace.id, owner, "Versioned");
    const before = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => folderRepository(tx).find({ folderId: folder, viewerId: owner }));
    await sleep(20);

    const results = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const change = (changes: { name?: string; icon?: string; color?: number }) => repository.update({ folderId: folder, ownerId: owner, changes, expectedVersions: undefined });
      return [await change({ name: "Versioned" }), await change({ icon: "star" }), await change({ color: 5 }), await change({ name: "Renamed", icon: "star", color: 5 }), await change({})];
    });

    expect(results.map((result) => (result.kind === "updated" || result.kind === "unchanged" ? [result.kind, result.folder.version] : [result.kind]))).toEqual([
      ["unchanged", 1],
      ["updated", 2],
      ["updated", 3],
      ["updated", 4],
      ["unchanged", 4],
    ]);
    const last = results[4];
    expect(last?.kind === "unchanged" ? last.folder : undefined).toMatchObject({ name: "Renamed", icon: "star", color: 5, version: 4 });
    expect(last?.kind === "unchanged" ? last.folder.updatedAt.getTime() : 0).toBeGreaterThan(before?.updatedAt.getTime() ?? Number.MAX_SAFE_INTEGER);
    expect(last?.kind === "unchanged" ? last.folder.createdAt : undefined).toEqual(before?.createdAt);
  });

  it("is refused as stale, with nothing written, when the version read under the lock is none of the accepted ones", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const folder = await seedFolder(workspace.id, owner, "Guarded");

    const results = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const change = (expectedVersions: readonly number[] | undefined) => repository.update({ folderId: folder, ownerId: owner, changes: { name: "Changed" }, expectedVersions });
      return { none: await change([]), other: await change([7]), match: await change([7, 1]) };
    });

    expect(results.none).toEqual({ kind: "stale" });
    expect(results.other).toEqual({ kind: "stale" });
    expect(results.match).toMatchObject({ kind: "updated", folder: { name: "Changed", version: 2 } });
  });

  it("makes two changes against one version one change: the second waits for the lock and is stale", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const folder = await seedFolder(workspace.id, owner, "Contended");
    const change = (name: string, hold: number) =>
      inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
        const result = await folderRepository(tx).update({ folderId: folder, ownerId: owner, changes: { name }, expectedVersions: [1] });
        await sleep(hold);
        return result;
      });

    const first = change("First", 300);
    await sleep(100);
    const second = change("Second", 0);

    expect((await first).kind).toBe("updated");
    expect(await second).toEqual({ kind: "stale" });
    expect((await storedFolders(workspace.id)).map((row) => [row.name, row.version])).toEqual([["First", 2]]);
  });
});

describe("the list", () => {
  it("counts the bookmarks filed in each folder and leaves plan-archived ones out", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const busy = await seedFolder(workspace.id, owner, "Busy");
    const empty = await seedFolder(workspace.id, owner, "Empty");
    for (const archived of [false, false, true]) {
      await file(workspace.id, busy, await seedBookmark(workspace.id, owner, archived));
    }

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      return {
        byName: (await repository.list({ viewerId: owner, scope: "mine", search: undefined, sort: "name", after: undefined, limit: 10 })).map((row) => [row.name, row.bookmarkCount]),
        byCount: (await repository.list({ viewerId: owner, scope: "mine", search: undefined, sort: "count", after: undefined, limit: 10 })).map((row) => [row.name, row.bookmarkCount]),
        found: (await repository.find({ folderId: busy, viewerId: owner }))?.bookmarkCount,
        emptyFound: (await repository.find({ folderId: empty, viewerId: owner }))?.bookmarkCount,
      };
    });

    expect(outcome).toEqual({ byName: [["Busy", 2], ["Empty", 0]], byCount: [["Busy", 2], ["Empty", 0]], found: 2, emptyFound: 0 });
  });

  it("matches a search as a part of the name without regard to case, and reads the characters of a LIKE pattern as themselves", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    for (const name of ["Reading list", "Bread", "100%", "a_b", "axb", "back\\slash"]) {
      await seedFolder(workspace.id, owner, name);
    }
    const search = (text: string) =>
      inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
        const repository = folderRepository(tx);
        return {
          names: (await repository.list({ viewerId: owner, scope: "mine", search: text, sort: "name", after: undefined, limit: 10 })).map((row) => row.name),
          count: await repository.count({ viewerId: owner, scope: "mine", search: text, limit: 100 }),
        };
      });

    expect(await search("READ")).toEqual({ names: ["Bread", "Reading list"], count: 2 });
    expect(await search("%")).toEqual({ names: ["100%"], count: 1 });
    expect(await search("_")).toEqual({ names: ["a_b"], count: 1 });
    expect(await search("\\")).toEqual({ names: ["back\\slash"], count: 1 });
    expect(await search("nothing")).toEqual({ names: [], count: 0 });
  });

  it("caps the count at the limit it is given", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    await asSystem(
      db,
      (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ${workspace.id}, ${owner}, 'Bulk ' || n::text FROM generate_series(1, 25) AS n`,
    );

    const counts = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => ({
      capped: await folderRepository(tx).count({ viewerId: owner, scope: "mine", search: undefined, limit: 10 }),
      all: await folderRepository(tx).count({ viewerId: owner, scope: "mine", search: undefined, limit: 100 }),
    }));

    expect(counts).toEqual({ capped: 10, all: 25 });
  });

  it("walks every sort in pages without repeating or skipping a folder, ties and microseconds included", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    // Four sets of names that tie on the count, and update times that share their millisecond: one statement stamps them all.
    await asSystem(
      db,
      (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) SELECT gen_random_uuid(), ${workspace.id}, ${owner}, 'Folder ' || lpad(n::text, 2, '0') FROM generate_series(1, 12) AS n`,
    );
    const first = (await storedFolders(workspace.id))[0];
    if (first === undefined) {
      throw new Error("no folder was seeded");
    }
    for (const archived of [false, false, true]) {
      await file(workspace.id, first.id, await seedBookmark(workspace.id, owner, archived));
    }

    const walk = (sort: "name" | "count" | "updated") =>
      inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
        const repository = folderRepository(tx);
        const seen: string[] = [];
        let after: Parameters<typeof repository.list>[0]["after"];
        for (let page = 0; page < 20; page += 1) {
          const rows = await repository.list({ viewerId: owner, scope: "mine", search: undefined, sort, after, limit: 5 });
          seen.push(...rows.map((row) => row.id));
          const last = rows.at(-1);
          if (rows.length < 5 || last === undefined) {
            break;
          }
          after = { count: sort === "count" ? last.bookmarkCount : undefined, updated: sort === "updated" ? last.updatedKey : undefined, name: last.name, id: last.id };
        }
        const whole = (await repository.list({ viewerId: owner, scope: "mine", search: undefined, sort, after: undefined, limit: 100 })).map((row) => row.id);
        return { seen, whole };
      });

    for (const sort of ["name", "count", "updated"] as const) {
      const { seen, whole } = await walk(sort);
      expect(seen, sort).toEqual(whole);
      expect(new Set(seen).size, sort).toBe(12);
    }
    const byCount = await walk("count");
    expect(byCount.whole[0]).toBe(first.id);
  });
});

describe("deleting a folder", () => {
  it("deletes the folder and its filings and leaves the bookmarks", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const folder = await seedFolder(workspace.id, owner, "Doomed");
    const kept = await seedFolder(workspace.id, owner, "Kept");
    const bookmark = await seedBookmark(workspace.id, owner);
    await file(workspace.id, folder, bookmark);
    await file(workspace.id, kept, bookmark);

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      return { first: await repository.remove({ folderId: folder, ownerId: owner }), again: await repository.remove({ folderId: folder, ownerId: owner }) };
    });

    expect(outcome).toEqual({ first: true, again: false });
    expect((await storedFolders(workspace.id)).map((row) => row.name)).toEqual(["Kept"]);
    expect(await storedFilings(workspace.id)).toBe(1);
    const bookmarks = await asSystem(db, (tx) => tx`SELECT id FROM bookmarks WHERE id = ${bookmark}`);
    expect(bookmarks).toHaveLength(1);
  });

  it("is deleted with the filings of a bookmark that is deleted, which leaves the folder", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const folder = await seedFolder(workspace.id, owner, "Stays");
    const bookmark = await seedBookmark(workspace.id, owner);
    await file(workspace.id, folder, bookmark);

    await asSystem(db, (tx) => tx`DELETE FROM bookmarks WHERE id = ${bookmark}`);

    expect(await storedFilings(workspace.id)).toBe(0);
    expect((await storedFolders(workspace.id)).map((row) => row.name)).toEqual(["Stays"]);
  });

  it("refuses a filing that joins a folder and a bookmark of different workspaces", async () => {
    const first = await workspaceOf(1);
    const second = await workspaceOf(1);
    const folder = await seedFolder(first.id, memberOf(first, 0), "Here");
    const bookmark = await seedBookmark(second.id, memberOf(second, 0));

    expect(await refusedWith(file(first.id, folder, bookmark))).toBe("23503");
    expect(await refusedWith(file(second.id, folder, bookmark))).toBe("23503");
  });
});

describe("the owner leaving the workspace", () => {
  it("leaves the folder with the workspace and no owner, and its filings with it", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const folder = await seedFolder(workspace.id, b, "Left behind");
    await file(workspace.id, folder, await seedBookmark(workspace.id, b));
    const before = await storedFolders(workspace.id);

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${b}`);

    const after = await storedFolders(workspace.id);
    expect(before.map((row) => [row.id, row.owner_id, row.version])).toEqual([[folder, b, 1]]);
    expect(after.map((row) => [row.id, row.owner_id, row.version])).toEqual([[folder, null, 2]]);
    expect(await storedFilings(workspace.id)).toBe(1);
    expect(a).not.toBe(b);
  });
});

describe("the workspace purge", () => {
  it("names the filings before the folders and the bookmarks they reference", () => {
    expect(workspacePurgeOrder.indexOf("folder_bookmarks")).toBeLessThan(workspacePurgeOrder.indexOf("folders"));
    expect(workspacePurgeOrder.indexOf("folder_bookmarks")).toBeLessThan(workspacePurgeOrder.indexOf("bookmarks"));
    expect(workspacePurgeOrder.indexOf("folders")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
  });
});

// A folder shared with a member (doc 02 section 8.2, doc 04 section 10.7, doc 10 T2). The failure scenario: a member the folder is shared with changes,
// deletes or files into it and the store must not write, while a member it is not shared with finds nothing at its identifier, in any scope.
describe("a folder shared with a member (T2)", () => {
  async function share(workspaceId: string, folderId: string, grantedBy: string, target: { accountId: string } | { teamId: string }): Promise<void> {
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, target_team_id, granted_by)
        VALUES (${freshId()}, ${workspaceId}, ${folderId}, ${"accountId" in target ? target.accountId : null}, ${"teamId" in target ? target.teamId : null}, ${grantedBy})`,
    );
  }

  const page = (viewerId: string, scope: "all" | "mine" | "shared") => (tx: Parameters<typeof folderRepository>[0]) =>
    folderRepository(tx).list({ viewerId, scope, search: undefined, sort: "name", after: undefined, limit: 100 });

  it("is listed, counted and read by the member it is shared with directly or through a team, as its owner's folder, and by no other member", async () => {
    const workspace = await workspaceOf(4);
    const owner = memberOf(workspace, 0);
    const direct = memberOf(workspace, 1);
    const viaTeam = memberOf(workspace, 2);
    const stranger = memberOf(workspace, 3);
    const own = await seedFolder(workspace.id, direct, "Direct's own");
    const folder = await seedFolder(workspace.id, owner, "Shared by owner");
    const unshared = await seedFolder(workspace.id, owner, "Not shared");
    await share(workspace.id, folder, owner, { accountId: direct });
    await share(workspace.id, folder, owner, { teamId: await seedTeam(db, workspace.id, [viaTeam]) });

    const seenBy = async (accountId: string) =>
      inTenant({ accountId, workspaceId: workspace.id }, async (tx) => ({
        shared: (await page(accountId, "shared")(tx)).map((row) => row.id),
        all: (await page(accountId, "all")(tx)).map((row) => row.id),
        mine: (await page(accountId, "mine")(tx)).map((row) => row.id),
        counted: [await folderRepository(tx).count({ viewerId: accountId, scope: "shared", search: undefined, limit: 100 }), await folderRepository(tx).count({ viewerId: accountId, scope: "all", search: undefined, limit: 100 })],
        found: (await folderRepository(tx).find({ folderId: folder, viewerId: accountId }))?.id,
        foundUnshared: (await folderRepository(tx).find({ folderId: unshared, viewerId: accountId }))?.id,
      }));

    expect(await seenBy(direct)).toEqual({ shared: [folder], all: [own, folder], mine: [own], counted: [1, 2], found: folder, foundUnshared: undefined });
    expect(await seenBy(viaTeam)).toEqual({ shared: [folder], all: [folder], mine: [], counted: [1, 1], found: folder, foundUnshared: undefined });
    expect(await seenBy(stranger)).toEqual({ shared: [], all: [], mine: [], counted: [0, 0], found: undefined, foundUnshared: undefined });
    expect(await seenBy(owner)).toEqual({ shared: [], all: [unshared, folder], mine: [unshared, folder], counted: [0, 2], found: folder, foundUnshared: unshared });
  });

  it("carries its owner for a recipient and how it is shared for its owner, who sees the members directly and the teams by name", async () => {
    const workspace = await workspaceOf(4);
    const owner = memberOf(workspace, 0);
    const ada = memberOf(workspace, 1);
    const bob = memberOf(workspace, 2);
    const cy = memberOf(workspace, 3);
    const folder = await seedFolder(workspace.id, owner, "Reading");
    const private_ = await seedFolder(workspace.id, owner, "Private");
    await asSystem(db, (tx) => tx`UPDATE accounts SET display_name = 'Olive Owner' WHERE id = ${owner}`);
    await share(workspace.id, folder, owner, { accountId: ada });
    await share(workspace.id, folder, owner, { accountId: bob });
    const design = await seedTeam(db, workspace.id, [cy]);
    await share(workspace.id, folder, owner, { teamId: design });
    await asSystem(db, (tx) => tx`UPDATE teams SET name = 'Design' WHERE id = ${design}`);

    const asOwner = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => folderRepository(tx).list({ viewerId: owner, scope: "mine", search: undefined, sort: "name", after: undefined, limit: 10 }));
    const asRecipient = await inTenant({ accountId: ada, workspaceId: workspace.id }, async (tx) => folderRepository(tx).find({ folderId: folder, viewerId: ada }));

    expect(asOwner.map((row) => [row.id, row.owner, row.shareSummary])).toEqual([
      [private_, null, { memberCount: 0, teams: [] }],
      [folder, null, { memberCount: 2, teams: [{ id: design, name: "Design" }] }],
    ]);
    expect(asRecipient).toMatchObject({ id: folder, ownerId: owner, owner: { accountId: owner, displayName: "Olive Owner" }, shareSummary: null });
  });

  it("counts the bookmarks filed in it that are not plan-archived, and leaves the owner of a folder whose owner left without a name", async () => {
    const workspace = await workspaceOf(3);
    const owner = memberOf(workspace, 0);
    const recipient = memberOf(workspace, 1);
    const leaver = memberOf(workspace, 2);
    const folder = await seedFolder(workspace.id, owner, "Counted");
    await file(workspace.id, folder, await seedBookmark(workspace.id, owner));
    await file(workspace.id, folder, await seedBookmark(workspace.id, owner));
    await file(workspace.id, folder, await seedBookmark(workspace.id, owner, true));
    await share(workspace.id, folder, owner, { accountId: recipient });
    const orphan = await seedFolder(workspace.id, leaver, "Orphaned");
    await share(workspace.id, orphan, leaver, { accountId: recipient });
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${leaver}`);

    const seen = await inTenant({ accountId: recipient, workspaceId: workspace.id }, (tx) => page(recipient, "shared")(tx));

    expect(seen.map((row) => [row.id, row.bookmarkCount, row.ownerId, row.owner])).toEqual([
      [folder, 2, owner, { accountId: owner, displayName: "Test account" }],
      [orphan, 0, null, null],
    ]);
  });

  it("is not changed, deleted or filed into by the member it is shared with: the store finds nothing of theirs to write, and says the folder is shared", async () => {
    const workspace = await workspaceOf(3);
    const owner = memberOf(workspace, 0);
    const recipient = memberOf(workspace, 1);
    const stranger = memberOf(workspace, 2);
    const folder = await seedFolder(workspace.id, owner, "Read only");
    const theirs = await seedBookmark(workspace.id, recipient);
    await share(workspace.id, folder, owner, { accountId: recipient });
    const before = await storedFolders(workspace.id);

    const outcome = await inTenant({ accountId: recipient, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      return {
        updated: await repository.update({ folderId: folder, ownerId: recipient, changes: { name: "Mine now", icon: "star", color: 3 }, expectedVersions: undefined }),
        filed: await repository.file({ folderId: folder, ownerId: recipient, bookmarkIds: [theirs] }),
        unfiled: await repository.unfile({ folderId: folder, ownerId: recipient, bookmarkIds: [theirs] }),
        removed: await repository.remove({ folderId: folder, ownerId: recipient }),
        sharedWith: await repository.sharedWith({ folderId: folder, accountId: recipient }),
      };
    });
    const strangers = await inTenant({ accountId: stranger, workspaceId: workspace.id }, async (tx) => ({
      sharedWith: await folderRepository(tx).sharedWith({ folderId: folder, accountId: stranger }),
      removed: await folderRepository(tx).remove({ folderId: folder, ownerId: stranger }),
    }));
    const owners = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => folderRepository(tx).sharedWith({ folderId: folder, accountId: owner }));

    expect(outcome).toEqual({ updated: { kind: "not_found" }, filed: { kind: "not_found" }, unfiled: { kind: "not_found" }, removed: false, sharedWith: true });
    expect(strangers).toEqual({ sharedWith: false, removed: false });
    expect(owners).toBe(false);
    expect(await storedFolders(workspace.id)).toEqual(before);
    expect(await storedFilings(workspace.id)).toBe(0);
  });

  it("is no longer read once the share is revoked, the team is deleted or the member leaves the team", async () => {
    const workspace = await workspaceOf(3);
    const owner = memberOf(workspace, 0);
    const direct = memberOf(workspace, 1);
    const member = memberOf(workspace, 2);
    const folder = await seedFolder(workspace.id, owner, "Revocable");
    await share(workspace.id, folder, owner, { accountId: direct });
    const team = await seedTeam(db, workspace.id, [member]);
    await share(workspace.id, folder, owner, { teamId: team });
    const sees = (accountId: string) => inTenant({ accountId, workspaceId: workspace.id }, async (tx) => (await page(accountId, "shared")(tx)).length);

    expect([await sees(direct), await sees(member)]).toEqual([1, 1]);
    await asSystem(db, (tx) => tx`DELETE FROM team_members WHERE team_id = ${team} AND account_id = ${member}`);
    await asSystem(db, (tx) => tx`DELETE FROM folder_shares WHERE folder_id = ${folder} AND target_account_id = ${direct}`);

    expect([await sees(direct), await sees(member)]).toEqual([0, 0]);
  });

  it("is not reached from another workspace the member belongs to, whatever scope is asked for (cross-tenant)", async () => {
    const first = await workspaceOf(2);
    const second = await workspaceOf(1);
    const [owner, recipient] = [memberOf(first, 0), memberOf(first, 1)];
    await seedMember(db, { workspaceId: second.id, accountId: recipient });
    const folder = await seedFolder(first.id, owner, "Only in the first");
    await share(first.id, folder, owner, { accountId: recipient });

    const inSecond = await inTenant({ accountId: recipient, workspaceId: second.id }, async (tx) => ({
      shared: await page(recipient, "shared")(tx),
      all: await page(recipient, "all")(tx),
      counted: await folderRepository(tx).count({ viewerId: recipient, scope: "shared", search: undefined, limit: 100 }),
      found: await folderRepository(tx).find({ folderId: folder, viewerId: recipient }),
      sharedWith: await folderRepository(tx).sharedWith({ folderId: folder, accountId: recipient }),
    }));

    expect(inSecond).toEqual({ shared: [], all: [], counted: 0, found: undefined, sharedWith: false });
  });

  it("is searched and paged like the member's own: by name, and by every sort without repeating or skipping a folder", async () => {
    const workspace = await workspaceOf(2);
    const [owner, recipient] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const ids: string[] = [];
    for (const name of ["Delta", "Alpha", "Charlie", "Bravo", "Echo"]) {
      const id = await seedFolder(workspace.id, owner, name);
      await share(workspace.id, id, owner, { accountId: recipient });
      ids.push(id);
    }
    await seedFolder(workspace.id, owner, "Alpha two");

    const walked = await inTenant({ accountId: recipient, workspaceId: workspace.id }, async (tx) => {
      const repository = folderRepository(tx);
      const seen: string[] = [];
      let after: { count: undefined; updated: undefined; name: string; id: string } | undefined;
      for (;;) {
        const rows = await repository.list({ viewerId: recipient, scope: "shared", search: undefined, sort: "name", after, limit: 2 });
        seen.push(...rows.map((row) => row.name));
        const last = rows.at(-1);
        if (rows.length < 2 || last === undefined) {
          break;
        }
        after = { count: undefined, updated: undefined, name: last.name, id: last.id };
      }
      return { seen, searched: (await repository.list({ viewerId: recipient, scope: "shared", search: "alp", sort: "name", after: undefined, limit: 10 })).map((row) => row.name) };
    });

    expect(walked).toEqual({ seen: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"], searched: ["Alpha"] });
    expect(ids).toHaveLength(5);
  });
});

describe("the bookmarks of a folder shared with a member (T2)", () => {
  async function share(workspaceId: string, folderId: string, grantedBy: string, target: { accountId: string } | { teamId: string }): Promise<void> {
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, target_team_id, granted_by)
        VALUES (${freshId()}, ${workspaceId}, ${folderId}, ${"accountId" in target ? target.accountId : null}, ${"teamId" in target ? target.teamId : null}, ${grantedBy})`,
    );
  }

  const listed = (workspaceId: string, accountId: string, filter: { scope?: "all" | "mine" | "shared_with_me"; folderId: string }) =>
    inTenant({ accountId, workspaceId }, async (tx) => {
      const repository = bookmarkRepository(tx);
      const request = { filter: { ownerId: accountId, ...filter }, sort: "recent" as const, after: undefined, limit: 100 };
      return { ids: (await repository.list(request)).map((row) => row.bookmark.id).sort(), counted: await repository.count(request.filter, 100) };
    });

  it("are listed and counted for the member the folder is shared with, with the folder filter, in every scope that holds shared bookmarks, and for no other member", async () => {
    const workspace = await workspaceOf(3);
    const owner = memberOf(workspace, 0);
    const recipient = memberOf(workspace, 1);
    const stranger = memberOf(workspace, 2);
    const folder = await seedFolder(workspace.id, owner, "Shared folder");
    const inside = [await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner)].sort();
    for (const id of inside) {
      await file(workspace.id, folder, id);
    }
    await file(workspace.id, folder, await seedBookmark(workspace.id, owner, true));
    await seedBookmark(workspace.id, owner);
    await share(workspace.id, folder, owner, { accountId: recipient });

    const both = { ids: inside, counted: 2 };
    const none = { ids: [], counted: 0 };
    expect(await listed(workspace.id, recipient, { folderId: folder })).toEqual(none);
    expect(await listed(workspace.id, recipient, { scope: "mine", folderId: folder })).toEqual(none);
    expect(await listed(workspace.id, recipient, { scope: "all", folderId: folder })).toEqual(both);
    expect(await listed(workspace.id, recipient, { scope: "shared_with_me", folderId: folder })).toEqual(both);
    expect(await listed(workspace.id, stranger, { scope: "all", folderId: folder })).toEqual(none);
    expect(await listed(workspace.id, stranger, { scope: "shared_with_me", folderId: folder })).toEqual(none);
    expect(await listed(workspace.id, owner, { scope: "shared_with_me", folderId: folder })).toEqual(none);
    expect(await listed(workspace.id, owner, { scope: "all", folderId: folder })).toEqual(both);
  });

  it("are still listed and counted for the member after the owner of the folder leaves the workspace, as the folder's own count says", async () => {
    const workspace = await workspaceOf(4);
    const [owner, recipient, stranger] = [memberOf(workspace, 1), memberOf(workspace, 2), memberOf(workspace, 3)];
    const folder = await seedFolder(workspace.id, owner, "Reading");
    const inside = [await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner)].sort();
    for (const id of inside) {
      await file(workspace.id, folder, id);
    }
    await share(workspace.id, folder, owner, { accountId: recipient });
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${owner}`);

    const row = await inTenant({ accountId: recipient, workspaceId: workspace.id }, async (tx) =>
      (await folderRepository(tx).list({ viewerId: recipient, scope: "shared", search: undefined, sort: "name", after: undefined, limit: 10 })).find((candidate) => candidate.id === folder),
    );
    expect(row).toMatchObject({ ownerId: null, bookmarkCount: 2 });
    expect(await listed(workspace.id, recipient, { scope: "all", folderId: folder })).toEqual({ ids: inside, counted: 2 });
    expect(await listed(workspace.id, recipient, { scope: "shared_with_me", folderId: folder })).toEqual({ ids: inside, counted: 2 });
    expect(await listed(workspace.id, stranger, { scope: "all", folderId: folder })).toEqual({ ids: [], counted: 0 });
  });

  it("do not leak into the filter of a folder the member cannot read: a bookmark shared directly is not listed under another folder it happens to be filed in", async () => {
    const workspace = await workspaceOf(2);
    const [owner, recipient] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const private_ = await seedFolder(workspace.id, owner, "Private folder");
    const bookmark = await seedBookmark(workspace.id, owner);
    await file(workspace.id, private_, bookmark);
    await asSystem(db, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspace.id}, ${bookmark}, ${recipient}, ${owner})`);

    expect(await listed(workspace.id, recipient, { scope: "all", folderId: private_ })).toEqual({ ids: [], counted: 0 });
    expect(await listed(workspace.id, recipient, { scope: "shared_with_me", folderId: private_ })).toEqual({ ids: [], counted: 0 });
  });

  it("are not listed through a folder of another workspace the member belongs to", async () => {
    const first = await workspaceOf(2);
    const second = await workspaceOf(1);
    const [owner, recipient] = [memberOf(first, 0), memberOf(first, 1)];
    await seedMember(db, { workspaceId: second.id, accountId: recipient });
    const folder = await seedFolder(first.id, owner, "First only");
    await file(first.id, folder, await seedBookmark(first.id, owner));
    await share(first.id, folder, owner, { accountId: recipient });

    expect(await listed(second.id, recipient, { scope: "all", folderId: folder })).toEqual({ ids: [], counted: 0 });
    expect(await listed(first.id, recipient, { scope: "all", folderId: folder })).toMatchObject({ counted: 1 });
  });
});
