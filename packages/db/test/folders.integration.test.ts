import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { folderRepository, isFolderNameTaken, listRepositoryMethods, workspacePurgeOrder } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
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
      const page = (sort: "name" | "count" | "updated") => repository.list({ ownerId: b, search: undefined, sort, after: undefined, limit: 100 });
      return {
        listed: (await page("name")).map((folder) => folder.id),
        listedByCount: (await page("count")).map((folder) => folder.id),
        listedByUpdate: (await page("updated")).map((folder) => folder.id),
        searched: (await repository.list({ ownerId: b, search: "Private to A", sort: "name", after: undefined, limit: 100 })).map((folder) => folder.id),
        counted: await repository.count({ ownerId: b, search: undefined, limit: 100 }),
        found: await repository.find({ folderId: folderOfA, ownerId: b }),
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
        listed: await repository.list({ ownerId: a, search: undefined, sort: "name", after: undefined, limit: 100 }),
        found: await repository.find({ folderId: ownerless, ownerId: a }),
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
      through: await folderRepository(tx).find({ folderId: folderOfA, ownerId: outsider }),
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

    await expect(inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => folderRepository(tx).list({ ownerId: a, search: undefined, sort: "name", after: undefined, limit: 100 }))).rejects.toThrow(
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
    const before = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => folderRepository(tx).find({ folderId: folder, ownerId: owner }));
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
        byName: (await repository.list({ ownerId: owner, search: undefined, sort: "name", after: undefined, limit: 10 })).map((row) => [row.name, row.bookmarkCount]),
        byCount: (await repository.list({ ownerId: owner, search: undefined, sort: "count", after: undefined, limit: 10 })).map((row) => [row.name, row.bookmarkCount]),
        found: (await repository.find({ folderId: busy, ownerId: owner }))?.bookmarkCount,
        emptyFound: (await repository.find({ folderId: empty, ownerId: owner }))?.bookmarkCount,
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
          names: (await repository.list({ ownerId: owner, search: text, sort: "name", after: undefined, limit: 10 })).map((row) => row.name),
          count: await repository.count({ ownerId: owner, search: text, limit: 100 }),
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
      capped: await folderRepository(tx).count({ ownerId: owner, search: undefined, limit: 10 }),
      all: await folderRepository(tx).count({ ownerId: owner, search: undefined, limit: 100 }),
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
          const rows = await repository.list({ ownerId: owner, search: undefined, sort, after, limit: 5 });
          seen.push(...rows.map((row) => row.id));
          const last = rows.at(-1);
          if (rows.length < 5 || last === undefined) {
            break;
          }
          after = { count: sort === "count" ? last.bookmarkCount : undefined, updated: sort === "updated" ? last.updatedKey : undefined, name: last.name, id: last.id };
        }
        const whole = (await repository.list({ ownerId: owner, search: undefined, sort, after: undefined, limit: 100 })).map((row) => row.id);
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
