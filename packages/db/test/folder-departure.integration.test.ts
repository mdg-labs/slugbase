import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, instanceRepository, memberRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// What becomes of a member's folders when the membership ends (doc 05 sections 2.4 and 7.1, doc 02 sections 3.5 and 3.6). The failure
// scenario: members M1 and M2 of one workspace each own a folder "Reading", and both leave. The owner of a folder is cleared by the
// foreign key, which puts both folders into the one ownerless namespace of folders_owner_name_key, so the second departure was refused
// with 23505. A folder that would collide takes the next free suffix instead, in the transaction that ends the membership, whichever
// path deletes the row.

const HOOK_TIMEOUT_MS = 300_000;
const SECRET = Buffer.from("sealed-totp-secret");

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
  await seedAccount(db, {
    id,
    email: `folder-departure${String(emailNumber)}@example.test`,
    passwordHash: "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    emailVerified: true,
  });
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
  readonly leavers: readonly string[];
}

async function workspaceOf(leavers = 2): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Departure test" });
  const owner = await account();
  await seedMember(db, { workspaceId: id, accountId: owner, role: "owner" });
  const members: string[] = [];
  for (let index = 0; index < leavers; index += 1) {
    const accountId = await account();
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
    members.push(accountId);
  }
  return { id, owner, leavers: members };
}

function leaver(workspace: Workspace, index: number): string {
  const member = workspace.leavers[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member;
}

async function seedFolder(workspaceId: string, ownerId: string | null, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function seedBookmark(workspaceId: string, ownerId: string): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed')`,
  );
  return id;
}

async function file(workspaceId: string, folderId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`);
}

interface Stored {
  id: string;
  name: string;
  owner_id: string | null;
}

async function stored(workspaceId: string): Promise<Stored[]> {
  return asSystem(db, (tx) => tx<Stored[]>`SELECT id, name::text AS name, owner_id FROM folders WHERE workspace_id = ${workspaceId} ORDER BY name::text, id`);
}

/** The names of the ownerless folders of the workspace. */
async function ownerlessNames(workspaceId: string): Promise<string[]> {
  return (await stored(workspaceId)).filter((folder) => folder.owner_id === null).map((folder) => folder.name).sort();
}

type Path = "account deletion" | "member removal" | "instance account deletion" | "direct delete";

async function depart(path: Path, workspace: Workspace, member: string): Promise<void> {
  if (path === "account deletion") {
    expect(await db.tenant.withTenant({ accountId: member, requestId: "folder-departure-test" }, (tx) => accountDeletionRepository(tx).delete([], []))).toBe(true);
  } else if (path === "member removal") {
    expect(
      await db.tenant.withTenant({ accountId: workspace.owner, workspaceId: workspace.id, requestId: "folder-departure-test" }, (tx) => memberRepository(tx).remove(member, [])),
    ).toBe(true);
  } else if (path === "instance account deletion") {
    const admin = await account({ admin: true });
    const outcome = await db.tenant.withTenant({ accountId: admin, requestId: "folder-departure-test" }, async (tx) => {
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

describe("a member who leaves with a folder named like an ownerless one", () => {
  it.each<Path>(["account deletion", "member removal", "instance account deletion", "direct delete"])(
    "renames the second \"Reading\" to \"Reading (2)\" on %s, and both departures succeed",
    async (path) => {
      const workspace = await workspaceOf();
      await seedFolder(workspace.id, leaver(workspace, 0), "Reading");
      await seedFolder(workspace.id, leaver(workspace, 1), "Reading");

      await depart(path, workspace, leaver(workspace, 0));
      await depart(path, workspace, leaver(workspace, 1));

      expect(await ownerlessNames(workspace.id)).toEqual(["Reading", "Reading (2)"]);
      expect((await stored(workspace.id)).every((folder) => folder.owner_id === null)).toBe(true);
    },
  );

  it("takes the lowest suffix that is free among the ownerless folders", async () => {
    const workspace = await workspaceOf(1);
    await seedFolder(workspace.id, null, "Reading");
    await seedFolder(workspace.id, null, "Reading (2)");
    await seedFolder(workspace.id, null, "Reading (4)");
    await seedFolder(workspace.id, leaver(workspace, 0), "Reading");

    await depart("direct delete", workspace, leaver(workspace, 0));

    expect(await ownerlessNames(workspace.id)).toEqual(["Reading", "Reading (2)", "Reading (3)", "Reading (4)"]);
  });

  it("compares without regard to case and keeps the case the member gave", async () => {
    const workspace = await workspaceOf(1);
    await seedFolder(workspace.id, null, "Reading");
    await seedFolder(workspace.id, leaver(workspace, 0), "reading");

    await depart("direct delete", workspace, leaver(workspace, 0));

    expect(await ownerlessNames(workspace.id)).toEqual(["Reading", "reading (2)"]);
  });

  it("keeps the result within 64 characters by shortening the base name", async () => {
    const workspace = await workspaceOf(2);
    const long = "x".repeat(64);
    await seedFolder(workspace.id, null, long);
    await seedFolder(workspace.id, leaver(workspace, 0), long);
    await seedFolder(workspace.id, leaver(workspace, 1), `${"y".repeat(61)} z`);
    await seedFolder(workspace.id, null, `${"y".repeat(61)} z`);

    await depart("direct delete", workspace, leaver(workspace, 0));
    await depart("direct delete", workspace, leaver(workspace, 1));

    const names = await ownerlessNames(workspace.id);
    expect(names).toEqual([long, `${"x".repeat(60)} (2)`, `${"y".repeat(61)} z`, `${"y".repeat(60)} (2)`].sort());
    expect(Math.max(...names.map((name) => name.length))).toBe(64);
  });

  it("drops the space a cut leaves at the end of the base name", async () => {
    const workspace = await workspaceOf(1);
    const base = `${"a".repeat(59)} b`;
    await seedFolder(workspace.id, null, base);
    await seedFolder(workspace.id, leaver(workspace, 0), base);

    await depart("direct delete", workspace, leaver(workspace, 0));

    expect(await ownerlessNames(workspace.id)).toEqual([`${"a".repeat(59)} (2)`, base]);
  });

  it("leaves a folder that does not collide, and the folders of other members and workspaces, as they are", async () => {
    const workspace = await workspaceOf(2);
    const other = await workspaceOf(1);
    await seedFolder(workspace.id, null, "Reading");
    const departing = await seedFolder(workspace.id, leaver(workspace, 0), "Recipes");
    const staying = await seedFolder(workspace.id, leaver(workspace, 1), "Reading");
    await seedFolder(other.id, null, "Recipes");
    await seedFolder(other.id, leaver(other, 0), "Recipes (2)");
    const before = await stored(other.id);

    await depart("direct delete", workspace, leaver(workspace, 0));

    expect(await stored(other.id)).toEqual(before);
    const afterwards = await stored(workspace.id);
    expect(afterwards.find((folder) => folder.id === departing)).toMatchObject({ name: "Recipes", owner_id: null });
    expect(afterwards.find((folder) => folder.id === staying)).toMatchObject({ name: "Reading", owner_id: leaver(workspace, 1) });
  });

  it("renames each colliding folder of one member and none of the others", async () => {
    const workspace = await workspaceOf(1);
    const member = leaver(workspace, 0);
    await seedFolder(workspace.id, null, "Reading");
    await seedFolder(workspace.id, null, "Notes");
    await seedFolder(workspace.id, member, "Reading");
    await seedFolder(workspace.id, member, "Notes");
    await seedFolder(workspace.id, member, "Recipes");

    await depart("direct delete", workspace, member);

    expect(await ownerlessNames(workspace.id)).toEqual(["Notes", "Notes (2)", "Reading", "Reading (2)", "Recipes"]);
  });

  it("keeps the names of the ownerless folders distinct when a member's folders meet each other's new names", async () => {
    const workspace = await workspaceOf(1);
    const member = leaver(workspace, 0);
    await seedFolder(workspace.id, null, "Reading");
    await seedFolder(workspace.id, member, "Reading");
    await seedFolder(workspace.id, member, "Reading (2)");

    await depart("direct delete", workspace, member);

    const names = await ownerlessNames(workspace.id);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(3);
    expect(names).toContain("Reading");
  });

  it("leaves the filings and the bookmarks as they were", async () => {
    const workspace = await workspaceOf(2);
    const bookmark = await seedBookmark(workspace.id, leaver(workspace, 0));
    const folder = await seedFolder(workspace.id, leaver(workspace, 0), "Reading");
    await seedFolder(workspace.id, null, "Reading");
    await file(workspace.id, folder, bookmark);
    const filings = () => asSystem(db, (tx) => tx`SELECT folder_id, bookmark_id FROM folder_bookmarks WHERE workspace_id = ${workspace.id}`);
    const bookmarks = () => asSystem(db, (tx) => tx`SELECT id, url, title FROM bookmarks WHERE workspace_id = ${workspace.id}`);
    const filingsBefore = [...(await filings())];
    const bookmarksBefore = [...(await bookmarks())];

    await depart("direct delete", workspace, leaver(workspace, 0));

    expect([...(await filings())]).toEqual(filingsBefore);
    expect([...(await bookmarks())]).toEqual(bookmarksBefore);
    expect((await stored(workspace.id)).find((row) => row.id === folder)).toMatchObject({ name: "Reading (2)", owner_id: null });
  });

  it("moves the version of a renamed folder and of no other", async () => {
    const workspace = await workspaceOf(1);
    await seedFolder(workspace.id, null, "Reading");
    await seedFolder(workspace.id, leaver(workspace, 0), "Reading");
    await seedFolder(workspace.id, leaver(workspace, 0), "Recipes");

    await depart("direct delete", workspace, leaver(workspace, 0));

    const rows = await asSystem(db, (tx) => tx<{ name: string; version: number }[]>`SELECT name::text AS name, version FROM folders WHERE workspace_id = ${workspace.id} ORDER BY name::text`);
    expect(rows).toEqual([
      { name: "Reading", version: 1 },
      { name: "Reading (2)", version: 2 },
      { name: "Recipes", version: 2 },
    ]);
  });

  it("serialises two departures that race: both succeed and no name repeats", async () => {
    const workspace = await workspaceOf(3);
    for (let index = 0; index < 3; index += 1) {
      await seedFolder(workspace.id, leaver(workspace, index), "Reading");
    }

    await Promise.all([0, 1, 2].map((index) => depart("member removal", workspace, leaver(workspace, index))));

    expect(await ownerlessNames(workspace.id)).toEqual(["Reading", "Reading (2)", "Reading (3)"]);
  });

  it("is part of the transaction that deletes the membership: a rollback leaves the names and the owner as they were", async () => {
    const workspace = await workspaceOf(1);
    await seedFolder(workspace.id, null, "Reading");
    const folder = await seedFolder(workspace.id, leaver(workspace, 0), "Reading");

    await expect(
      asSystem(db, async (tx) => {
        await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${leaver(workspace, 0)}`;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    expect((await stored(workspace.id)).find((row) => row.id === folder)).toMatchObject({ name: "Reading", owner_id: leaver(workspace, 0) });
  });
});
