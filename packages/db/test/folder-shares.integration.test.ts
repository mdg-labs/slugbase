import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { folderRepository, folderShareRepository, listRepositoryMethods, workspacePurgeOrder } from "../src/index.ts";
import { tenantHandle } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The shares of folders (doc 05 section 2.5, doc 02 section 8, doc 10 T1, T2 and T11). The failure scenario: a member of the workspace grants a share on
// another member's folder by its identifier, and the owner shares with an account that is no member of the workspace (or with the team of another
// workspace); both are refused, through the repository and with the application's predicates left out so that only the policies and the foreign keys
// stand, and no row is written. The scenario of the grant itself: a folder shared with a team makes every bookmark filed in it readable by the team's
// members, the ones filed later included, with the one row of the share, and a bookmark taken out of the folder, a member taken out of the team or a share
// revoked makes it unreadable again. Besides that: a share is one per target; the audience counts distinct members other than the owner; a share goes with
// its folder, its member and its team (a team's deletion takes its folder shares and its bookmark shares), and with the workspace; and a grant and the
// removal of its target do not meet half-way.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(displayName: string): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `shares${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", displayName });
  return id;
}

interface Workspace {
  readonly id: string;
  /** The owner, an admin, a member and a second member. */
  readonly members: readonly string[];
}

async function workspaceOf(roles: readonly Role[] = ["owner", "admin", "member", "member"]): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Shares test" });
  const members: string[] = [];
  for (const role of roles) {
    const accountId = await account(`Member ${String(members.length)}`);
    await seedMember(db, { workspaceId: id, accountId, role });
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
  return db.tenant.withTenant({ ...tenant, requestId: "shares-test" }, work);
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

async function seedFolder(workspaceId: string, ownerId: string | null): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${"Folder " + id})`);
  return id;
}

async function seedTeam(workspaceId: string, name: string, members: readonly string[] = []): Promise<string> {
  const id = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${name})`;
    for (const accountId of members) {
      await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${id}, ${accountId})`;
    }
  });
  return id;
}

/** Writes a share as slugbase_system, which stands for the operations that write in ways a request may not. */
async function seedShare(workspaceId: string, folderId: string, target: { accountId: string } | { teamId: string }, grantedBy: string | null = null): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, target_team_id, granted_by)
      VALUES (${id}, ${workspaceId}, ${folderId}, ${"accountId" in target ? target.accountId : null}, ${"teamId" in target ? target.teamId : null}, ${grantedBy})`,
  );
  return id;
}

async function storedShares(workspaceId: string): Promise<{ id: string; folder_id: string; target_account_id: string | null; target_team_id: string | null; granted_by: string | null }[]> {
  return asSystem(
    db,
    (tx) => tx<{ id: string; folder_id: string; target_account_id: string | null; target_team_id: string | null; granted_by: string | null }[]>`
      SELECT id, folder_id, target_account_id, target_team_id, granted_by FROM folder_shares WHERE workspace_id = ${workspaceId} ORDER BY id`,
  );
}

const ownerTenant = (workspace: Workspace) => ({ accountId: memberOf(workspace, 0), workspaceId: workspace.id });

describe("the table", () => {
  it("has the columns, keys, checks and indexes of doc 05 section 2.5", async () => {
    const columns = await db.owner<{ column_name: string; is_nullable: string; udt_name: string }[]>`
      SELECT column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'folder_shares' ORDER BY ordinal_position`;
    expect(columns.map((column) => [column.column_name, column.udt_name, column.is_nullable])).toEqual([
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["folder_id", "uuid", "NO"],
      ["target_account_id", "uuid", "YES"],
      ["target_team_id", "uuid", "YES"],
      ["granted_by", "uuid", "YES"],
      ["created_at", "timestamptz", "NO"],
    ]);
    const constraints = await db.owner<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'public.folder_shares'::regclass ORDER BY conname`;
    const definitions = Object.fromEntries(constraints.map((constraint) => [constraint.conname, constraint.definition]));
    expect(definitions["folder_shares_folder_fkey"]).toBe("FOREIGN KEY (workspace_id, folder_id) REFERENCES folders(workspace_id, id) ON DELETE CASCADE");
    expect(definitions["folder_shares_member_fkey"]).toBe("FOREIGN KEY (workspace_id, target_account_id) REFERENCES workspace_members(workspace_id, account_id) ON DELETE CASCADE");
    expect(definitions["folder_shares_team_fkey"]).toBe("FOREIGN KEY (workspace_id, target_team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE");
    expect(definitions["folder_shares_granted_by_accounts_id_fk"]).toBe("FOREIGN KEY (granted_by) REFERENCES accounts(id) ON DELETE SET NULL");
    expect(definitions["folder_shares_target_check"]).toContain("target_account_id IS NULL");
    const indexes = await db.owner<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'folder_shares'`;
    const byName = Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]));
    expect(byName["folder_shares_account_key"]).toMatch(/CREATE UNIQUE INDEX .* \(folder_id, target_account_id\) WHERE \(target_account_id IS NOT NULL\)/);
    expect(byName["folder_shares_team_key"]).toMatch(/CREATE UNIQUE INDEX .* \(folder_id, target_team_id\) WHERE \(target_team_id IS NOT NULL\)/);
    expect(byName["folder_shares_account_idx"]).toContain("(workspace_id, target_account_id, folder_id)");
    expect(byName["folder_shares_team_idx"]).toContain("(workspace_id, target_team_id, folder_id)");
  });

  it("has row-level security enabled and forced, with a workspace policy to read and an owner policy to write", async () => {
    const tables = await db.owner<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.folder_shares'::regclass`;
    expect(tables).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await db.owner<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'folder_shares' ORDER BY policyname`;
    expect(policies.map((policy) => [policy.policyname, policy.cmd])).toEqual([
      ["folder_shares_tenant", "SELECT"],
      ["folder_shares_tenant_delete", "DELETE"],
      ["folder_shares_tenant_insert", "INSERT"],
    ]);
    for (const policy of policies) {
      expect(`${policy.qual ?? ""}${policy.with_check ?? ""}`).toContain("app_workspace_id()");
    }
    for (const policy of policies.filter((entry) => entry.cmd !== "SELECT")) {
      expect(`${policy.qual ?? ""}${policy.with_check ?? ""}`).toContain("app_account_id()");
    }
  });

  it("registers its repository in the scoped-repository registry and the purge registry", () => {
    expect(listRepositoryMethods().filter((entry) => entry.repository === "folder_shares").map((entry) => entry.method).sort()).toEqual(["delete", "insert", "select"]);
    expect(workspacePurgeOrder.indexOf("folder_shares")).toBeLessThan(workspacePurgeOrder.indexOf("folders"));
    expect(workspacePurgeOrder.indexOf("folder_shares")).toBeLessThan(workspacePurgeOrder.indexOf("teams"));
    expect(workspacePurgeOrder.indexOf("folder_shares")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
  });

  it("refuses a share with no target and a share with two, and one share per folder and target", async () => {
    const workspace = await workspaceOf();
    const folderId = await seedFolder(workspace.id, memberOf(workspace, 0));
    const teamId = await seedTeam(workspace.id, "Both");
    const insert = (accountId: string | null, team: string | null) =>
      asSystem(db, (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, target_team_id) VALUES (${freshId()}, ${workspace.id}, ${folderId}, ${accountId}, ${team})`);
    expect(await refusedWith(insert(null, null))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert(memberOf(workspace, 2), teamId))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert(memberOf(workspace, 2), null))).toBeUndefined();
    expect(await refusedWith(insert(memberOf(workspace, 2), null))).toBe(UNIQUE_VIOLATION);
    expect(await refusedWith(insert(null, teamId))).toBeUndefined();
    expect(await refusedWith(insert(null, teamId))).toBe(UNIQUE_VIOLATION);
  });

  it("lets the application role insert the columns of a grant and delete, and never update", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const tenant = { accountId: owner, workspaceId: workspace.id };
    const shareId = freshId();
    expect(
      await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${shareId}, ${workspace.id}, ${folderId}, ${memberOf(workspace, 2)}, ${owner})`)),
    ).toBeUndefined();
    expect(await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by, created_at) VALUES (${freshId()}, ${workspace.id}, ${folderId}, ${memberOf(workspace, 3)}, ${owner}, now())`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE folder_shares SET target_account_id = ${memberOf(workspace, 3)} WHERE id = ${shareId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`DELETE FROM folder_shares WHERE id = ${shareId}`))).toBeUndefined();
    expect(await storedShares(workspace.id)).toEqual([]);
  });
});

describe("the failure scenario: a share that is not the owner's to grant, or has no target in the workspace", () => {
  it("lets a member who does not own the folder grant nothing on it by its identifier, through the repository", async () => {
    const workspace = await workspaceOf();
    const folderId = await seedFolder(workspace.id, memberOf(workspace, 0));
    const before = await storedShares(workspace.id);

    const outcome = await inTenant({ accountId: memberOf(workspace, 2), workspaceId: workspace.id }, async (tx) => {
      const repository = folderShareRepository(tx);
      return {
        owned: await repository.ownedFolder({ folderId, ownerId: memberOf(workspace, 2), use: "grant" }),
        readable: await repository.ownedFolder({ folderId, ownerId: memberOf(workspace, 2), use: "read" }),
      };
    });

    expect(outcome).toEqual({ owned: false, readable: false });
    expect(await storedShares(workspace.id)).toEqual(before);
  });

  it("refuses by policy a share that another member writes on the folder, or writes in the owner's name, with the application's predicates left out", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const intruder = memberOf(workspace, 2);
    const folderId = await seedFolder(workspace.id, owner);
    const sharedByOwner = await seedShare(workspace.id, folderId, { accountId: memberOf(workspace, 3) }, owner);
    const tenant = { accountId: intruder, workspaceId: workspace.id };
    const insert = (grantedBy: string) =>
      appAs(tenant, (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspace.id}, ${folderId}, ${intruder}, ${grantedBy})`);

    expect(await refusedWith(insert(intruder))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(owner))).toBe(INSUFFICIENT_PRIVILEGE);
    const seen = await appAs(tenant, async (tx) => ({
      removed: await tx<{ id: string }[]>`DELETE FROM folder_shares WHERE id = ${sharedByOwner} RETURNING id`,
    }));
    expect(seen.removed).toHaveLength(0);
    expect((await storedShares(workspace.id)).map((share) => share.id)).toEqual([sharedByOwner]);
  });

  it("writes no share for an account that is no member of the workspace, or for the team of another workspace, through the repository", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const outsider = memberOf(b, 2);
    const teamOfB = await seedTeam(b.id, "B only", [memberOf(b, 2)]);
    const folderId = await seedFolder(a.id, memberOf(a, 0));

    const outcome = await inTenant(ownerTenant(a), async (tx) => {
      const repository = folderShareRepository(tx);
      return {
        outsider: await repository.grant({ id: freshId(), folderId, grantedBy: memberOf(a, 0), target: { kind: "member", accountId: outsider } }),
        unknownAccount: await repository.grant({ id: freshId(), folderId, grantedBy: memberOf(a, 0), target: { kind: "member", accountId: freshId() } }),
        teamOfB: await repository.grant({ id: freshId(), folderId, grantedBy: memberOf(a, 0), target: { kind: "team", teamId: teamOfB } }),
      };
    });

    expect(outcome).toEqual({ outsider: { kind: "unknown_target" }, unknownAccount: { kind: "unknown_target" }, teamOfB: { kind: "unknown_target" } });
    expect(await storedShares(a.id)).toEqual([]);
    expect(await storedShares(b.id)).toEqual([]);
  });

  it("refuses by the foreign keys a share naming an account outside the workspace or a team of another workspace, with the application's predicates left out", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const owner = memberOf(a, 0);
    const folderId = await seedFolder(a.id, owner);
    const teamOfB = await seedTeam(b.id, "B only");
    const tenant = { accountId: owner, workspaceId: a.id };

    expect(
      await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${a.id}, ${folderId}, ${memberOf(b, 2)}, ${owner})`)),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_team_id, granted_by) VALUES (${freshId()}, ${a.id}, ${folderId}, ${teamOfB}, ${owner})`)),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(await storedShares(a.id)).toEqual([]);
  });

  it("shows, reads and changes nothing of workspace B's shares to a member of workspace A, with the application's predicates left out, and refuses a share that names B", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const folderOfB = await seedFolder(b.id, memberOf(b, 0));
    const shareOfB = await seedShare(b.id, folderOfB, { accountId: memberOf(b, 2) }, memberOf(b, 0));
    const folderOfA = await seedFolder(a.id, memberOf(a, 0));
    const shareOfA = await seedShare(a.id, folderOfA, { accountId: memberOf(a, 2) }, memberOf(a, 0));
    const before = await storedShares(b.id);

    const seen = await appAs(ownerTenant(a), async (tx) => ({
      shares: await tx<{ id: string }[]>`SELECT id FROM folder_shares`,
      removed: await tx<{ id: string }[]>`DELETE FROM folder_shares WHERE id = ${shareOfB} RETURNING id`,
    }));
    expect(seen.shares.map((row) => row.id)).toEqual([shareOfA]);
    expect(seen.removed).toHaveLength(0);
    expect(
      await refusedWith(appAs(ownerTenant(a), (tx) => tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${b.id}, ${folderOfB}, ${memberOf(b, 3)}, ${memberOf(a, 0)})`)),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedShares(b.id)).toEqual(before);

    const throughRepository = await inTenant(ownerTenant(a), async (tx) => {
      const repository = folderShareRepository(tx);
      return { list: await repository.list(folderOfB), revoked: await repository.revoke({ folderId: folderOfB, shareId: shareOfB }) };
    });
    expect(throughRepository).toEqual({ list: { shares: [], audienceSize: 0 }, revoked: undefined });
    expect(await storedShares(b.id)).toEqual(before);
  });
});

describe("granting, listing and revoking", () => {
  it("shares a folder with a member and with a team, and a repeated grant answers the share that exists", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const teamId = await seedTeam(workspace.id, "Design", [memberOf(workspace, 1)]);

    const result = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = folderShareRepository(tx);
      const first = await repository.grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "member", accountId: memberOf(workspace, 2) } });
      const repeated = await repository.grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "member", accountId: memberOf(workspace, 2) } });
      const team = await repository.grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "team", teamId } });
      const teamAgain = await repository.grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "team", teamId } });
      return { first, repeated, team, teamAgain };
    });

    expect(result.first).toMatchObject({ kind: "granted", share: { accountId: memberOf(workspace, 2), teamId: null, name: "Member 2", folderId } });
    expect(result.first.kind === "granted" && result.first.share.email).toMatch(/^shares\d+@example\.test$/);
    expect(result.repeated.kind).toBe("existing");
    expect(result.repeated.kind === "existing" && result.first.kind === "granted" && result.repeated.share.id === result.first.share.id).toBe(true);
    expect(result.team).toMatchObject({ kind: "granted", share: { accountId: null, teamId, name: "Design", email: null } });
    expect(result.teamAgain.kind).toBe("existing");
    const stored = await storedShares(workspace.id);
    expect(stored).toHaveLength(2);
    expect(stored.every((share) => share.granted_by === owner)).toBe(true);
  });

  it("counts the audience as the distinct members other than the owner, whether they are shared with directly or through teams", async () => {
    const workspace = await workspaceOf(["owner", "admin", "member", "member", "member"]);
    const [owner, admin, ada, bob, cy] = workspace.members as [string, string, string, string, string];
    const folderId = await seedFolder(workspace.id, owner);
    const otherFolder = await seedFolder(workspace.id, owner);
    const design = await seedTeam(workspace.id, "Design", [owner, admin, ada]);
    const ops = await seedTeam(workspace.id, "Ops", [ada, bob]);
    await seedTeam(workspace.id, "Empty");
    await seedShare(workspace.id, folderId, { teamId: design }, owner);
    await seedShare(workspace.id, folderId, { teamId: ops }, owner);
    await seedShare(workspace.id, folderId, { accountId: ada }, owner);
    await seedShare(workspace.id, folderId, { accountId: cy }, owner);
    await seedShare(workspace.id, otherFolder, { accountId: bob }, owner);

    const { list, other, none } = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = folderShareRepository(tx);
      return { list: await repository.list(folderId), other: await repository.list(otherFolder), none: await repository.list(freshId()) };
    });

    // admin and ada through Design, ada and bob through Ops, ada and cy directly: four members, and the owner of the folder, who is in Design, is not counted
    expect(list.audienceSize).toBe(4);
    expect(list.shares).toHaveLength(4);
    expect(list.shares.map((share) => share.name).sort()).toEqual(["Design", "Member 2", "Member 4", "Ops"]);
    expect(other.audienceSize).toBe(1);
    expect(none).toEqual({ shares: [], audienceSize: 0 });
  });

  it("revokes a share of the folder and nothing else, and answers a share of another folder, a revoked one and an unknown one as not found", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const otherFolder = await seedFolder(workspace.id, owner);
    const share = await seedShare(workspace.id, folderId, { accountId: memberOf(workspace, 2) }, owner);
    const keep = await seedShare(workspace.id, folderId, { accountId: memberOf(workspace, 3) }, owner);

    const outcome = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = folderShareRepository(tx);
      return {
        wrongFolder: await repository.revoke({ folderId: otherFolder, shareId: share }),
        unknown: await repository.revoke({ folderId, shareId: freshId() }),
        revoked: await repository.revoke({ folderId, shareId: share }),
        again: await repository.revoke({ folderId, shareId: share }),
      };
    });

    expect(outcome.wrongFolder).toBeUndefined();
    expect(outcome.unknown).toBeUndefined();
    expect(outcome.revoked).toMatchObject({ id: share, accountId: memberOf(workspace, 2), name: "Member 2" });
    expect(outcome.again).toBeUndefined();
    expect((await storedShares(workspace.id)).map((row) => row.id)).toEqual([keep]);
  });

  it("owns a folder only for the account that owns it, and for none when the owner has left", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const live = await seedFolder(workspace.id, owner);
    const ownerless = await seedFolder(workspace.id, null);

    const outcome = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = folderShareRepository(tx);
      const ask = (folderId: string, use: "read" | "grant" | "revoke") => repository.ownedFolder({ folderId, ownerId: owner, use });
      return {
        live: [await ask(live, "read"), await ask(live, "grant"), await ask(live, "revoke")],
        ownerless: [await ask(ownerless, "read"), await ask(ownerless, "grant"), await ask(ownerless, "revoke")],
        unknown: await ask(freshId(), "read"),
      };
    });

    expect(outcome).toEqual({ live: [true, true, true], ownerless: [false, false, false], unknown: false });
  });
});

describe("the failure scenario of a grant: a bookmark filed in a shared folder later, and one taken out", () => {
  async function seedBookmark(workspaceId: string, ownerId: string): Promise<string> {
    const id = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/in-folder', 'https://example.com/in-folder', 'example.com', 'In a folder')`,
    );
    return id;
  }

  /**
   * Whether `accountId` can read the bookmark through a share of a folder it is filed in: the folder branch of the access predicate of doc 05 section 4,
   * asked in the transaction of the recipient, so that the policies of the three tables it reads are the ones that judge it.
   */
  function readableThroughFolders(workspace: Workspace, accountId: string, bookmarkId: string): Promise<boolean> {
    return inTenant({ accountId, workspaceId: workspace.id }, async (tx) => {
      const rows = await tenantHandle(tx).execute<{ readable: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM public.folder_bookmarks fb
          JOIN public.folder_shares fs ON fs.workspace_id = fb.workspace_id AND fs.folder_id = fb.folder_id
          WHERE fb.workspace_id = ${workspace.id}::uuid AND fb.bookmark_id = ${bookmarkId}::uuid
            AND (fs.target_account_id = ${accountId}::uuid
              OR fs.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = ${workspace.id}::uuid AND m.account_id = ${accountId}::uuid))
        ) AS readable`);
      return rows[0]?.readable === true;
    });
  }

  const file = (workspace: Workspace, folderId: string, bookmarkIds: readonly string[], change: "file" | "unfile") =>
    inTenant(ownerTenant(workspace), (tx) => folderRepository(tx)[change]({ folderId, ownerId: memberOf(workspace, 0), bookmarkIds }));

  it("makes a bookmark filed in a folder shared with a team readable by the team's members with no new share, and unreadable again once it is taken out", async () => {
    const workspace = await workspaceOf(["owner", "admin", "member", "member"]);
    const [owner, , mia, cy] = workspace.members as [string, string, string, string];
    const folderId = await seedFolder(workspace.id, owner);
    const filed = await seedBookmark(workspace.id, owner);
    const later = await seedBookmark(workspace.id, owner);
    const outside = await seedBookmark(workspace.id, owner);
    const team = await seedTeam(workspace.id, "Design", [mia]);
    expect((await file(workspace, folderId, [filed], "file")).kind).toBe("done");

    const granted = await inTenant(ownerTenant(workspace), (tx) => folderShareRepository(tx).grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "team", teamId: team } }));
    expect(granted.kind).toBe("granted");
    const rowsAfterGrant = await storedShares(workspace.id);
    expect(rowsAfterGrant).toHaveLength(1);

    // the bookmark that was in the folder when it was shared is readable, the one outside it is not, and neither is anything readable by a member of no team
    expect(await readableThroughFolders(workspace, mia, filed)).toBe(true);
    expect(await readableThroughFolders(workspace, mia, later)).toBe(false);
    expect(await readableThroughFolders(workspace, mia, outside)).toBe(false);
    expect(await readableThroughFolders(workspace, cy, filed)).toBe(false);

    // a bookmark added to the folder afterwards is readable on the next request, and the grant is still the one row
    expect((await file(workspace, folderId, [later], "file")).kind).toBe("done");
    expect(await readableThroughFolders(workspace, mia, later)).toBe(true);
    expect(await readableThroughFolders(workspace, cy, later)).toBe(false);
    expect(await storedShares(workspace.id)).toEqual(rowsAfterGrant);

    // removing it from the folder makes it unreadable again, and the one that stays in is unaffected
    expect((await file(workspace, folderId, [later], "unfile")).kind).toBe("done");
    expect(await readableThroughFolders(workspace, mia, later)).toBe(false);
    expect(await readableThroughFolders(workspace, mia, filed)).toBe(true);
    expect(await storedShares(workspace.id)).toEqual(rowsAfterGrant);
  });

  it("follows the team and the share: a member taken out of the team, and a revoked share, read nothing through the folder any more", async () => {
    const workspace = await workspaceOf(["owner", "admin", "member", "member"]);
    const [owner, , mia, cy] = workspace.members as [string, string, string, string];
    const folderId = await seedFolder(workspace.id, owner);
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const team = await seedTeam(workspace.id, "Design", [mia]);
    await file(workspace, folderId, [bookmarkId], "file");
    const teamShare = await seedShare(workspace.id, folderId, { teamId: team }, owner);
    const directShare = await seedShare(workspace.id, folderId, { accountId: cy }, owner);

    expect([await readableThroughFolders(workspace, mia, bookmarkId), await readableThroughFolders(workspace, cy, bookmarkId)]).toEqual([true, true]);

    await asSystem(db, (tx) => tx`DELETE FROM team_members WHERE team_id = ${team} AND account_id = ${mia}`);
    expect(await readableThroughFolders(workspace, mia, bookmarkId)).toBe(false);
    await asSystem(db, (tx) => tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspace.id}, ${team}, ${mia})`);
    expect(await readableThroughFolders(workspace, mia, bookmarkId)).toBe(true);

    const revoked = await inTenant(ownerTenant(workspace), (tx) => folderShareRepository(tx).revoke({ folderId, shareId: teamShare }));
    expect(revoked?.id).toBe(teamShare);
    expect([await readableThroughFolders(workspace, mia, bookmarkId), await readableThroughFolders(workspace, cy, bookmarkId)]).toEqual([false, true]);
    expect((await storedShares(workspace.id)).map((row) => row.id)).toEqual([directShare]);
  });
});

describe("what takes a share away", () => {
  it("removes the shares of a folder with the folder, those of a member with the member, and those of a team with the team", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const doomed = await seedFolder(workspace.id, owner);
    const staying = await seedFolder(workspace.id, owner);
    const team = await seedTeam(workspace.id, "Doomed team");
    const leaving = memberOf(workspace, 3);
    await seedShare(workspace.id, doomed, { accountId: memberOf(workspace, 2) }, owner);
    await seedShare(workspace.id, staying, { accountId: leaving }, owner);
    await seedShare(workspace.id, staying, { teamId: team }, owner);
    await seedShare(workspace.id, staying, { accountId: memberOf(workspace, 2) }, owner);

    await asSystem(db, (tx) => tx`DELETE FROM folders WHERE id = ${doomed}`);
    expect(await storedShares(workspace.id)).toHaveLength(3);
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${leaving}`);
    expect(await storedShares(workspace.id)).toHaveLength(2);
    await asSystem(db, (tx) => tx`DELETE FROM teams WHERE id = ${team}`);
    expect((await storedShares(workspace.id)).map((share) => [share.folder_id, share.target_account_id])).toEqual([[staying, memberOf(workspace, 2)]]);
  });

  it("removes the folder shares and the bookmark shares of a team with the team, and leaves those of other targets", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const bookmarkId = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        VALUES (${bookmarkId}, ${workspace.id}, ${owner}, 'https://example.com/team', 'https://example.com/team', 'example.com', 'Team bookmark')`,
    );
    const doomed = await seedTeam(workspace.id, "Doomed team");
    const staying = await seedTeam(workspace.id, "Staying team");
    await seedShare(workspace.id, folderId, { teamId: doomed }, owner);
    const keptFolderShare = await seedShare(workspace.id, folderId, { teamId: staying }, owner);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_team_id, granted_by) VALUES (${freshId()}, ${workspace.id}, ${bookmarkId}, ${doomed}, ${owner}), (${freshId()}, ${workspace.id}, ${bookmarkId}, ${staying}, ${owner})`,
    );
    const bookmarkShares = () => asSystem(db, (tx) => tx<{ target_team_id: string }[]>`SELECT target_team_id FROM bookmark_shares WHERE workspace_id = ${workspace.id}`);

    await asSystem(db, (tx) => tx`DELETE FROM teams WHERE id = ${doomed}`);

    expect((await storedShares(workspace.id)).map((share) => share.id)).toEqual([keptFolderShare]);
    expect((await bookmarkShares()).map((share) => share.target_team_id)).toEqual([staying]);
  });

  it("keeps a share when the member who granted it is deleted, and when the owner of the folder has left", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const granter = await account("Granter");
    await seedMember(db, { workspaceId: workspace.id, accountId: granter, role: "member" });
    const share = await seedShare(workspace.id, folderId, { accountId: memberOf(workspace, 2) }, granter);

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${granter}`);
    await asSystem(db, (tx) => tx`DELETE FROM accounts WHERE id = ${granter}`);
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${memberOf(workspace, 1)}`);
    expect(await storedShares(workspace.id)).toEqual([{ id: share, folder_id: folderId, target_account_id: memberOf(workspace, 2), target_team_id: null, granted_by: null }]);
    await asSystem(db, (tx) => tx`UPDATE folders SET owner_id = NULL WHERE id = ${folderId}`);
    expect(await storedShares(workspace.id)).toHaveLength(1);
  });

  it("goes with the workspace: the purge registry empties it", async () => {
    const workspace = await workspaceOf();
    const folderId = await seedFolder(workspace.id, memberOf(workspace, 0));
    await seedShare(workspace.id, folderId, { accountId: memberOf(workspace, 2) }, memberOf(workspace, 0));
    await asSystem(db, async (tx) => {
      await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspace.id}`;
      const purged = await tx<{ n: number }[]>`SELECT public.sys_workspace_purge_batch(${workspace.id}, 'folder_shares', 10) AS n`;
      expect(purged[0]?.n).toBe(1);
    });
    expect(await storedShares(workspace.id)).toEqual([]);
  });
});

describe("a grant and the removal of its target at the same time", () => {
  const gateOf = (): { readonly open: () => void; readonly opened: Promise<void> } => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  };

  async function waitingPids(): Promise<number[]> {
    const rows = await db.app<{ pid: number }[]>`
      SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
      WHERE NOT l.granted AND s.datname = current_database() ORDER BY l.pid`;
    return rows.map((row) => row.pid);
  }

  async function waitUntilSomeoneWaits(what: string): Promise<number> {
    const deadline = Date.now() + BLOCKED_DEADLINE_MS;
    let waiting = await waitingPids();
    while (waiting.length < 1) {
      if (Date.now() > deadline) {
        throw new Error(`${what} never waited for a lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      waiting = await waitingPids();
    }
    expect(waiting, `${what}: only one backend should wait`).toHaveLength(1);
    return waiting[0] ?? 0;
  }

  it("answers unknown_target, and not a foreign-key error, for a member whose removal the grant waits for", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const leaving = memberOf(workspace, 2);
    const held = gateOf();
    const release = gateOf();
    // The removal holds the membership row, deleted and not yet committed, until it is released.
    const removal = asSystem(db, async (tx) => {
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${leaving}`;
      held.open();
      await release.opened;
    });
    await Promise.race([held.opened, removal]);
    try {
      const granting = inTenant(ownerTenant(workspace), (tx) =>
        folderShareRepository(tx).grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "member", accountId: leaving } }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const pid = await waitUntilSomeoneWaits("the grant");
      const blockedBy = await db.app<{ pids: number[] }[]>`SELECT pg_blocking_pids(${pid}) AS pids`;
      expect(blockedBy[0]?.pids.length).toBeGreaterThan(0);
      release.open();
      await removal;
      expect(await granting).toEqual({ value: { kind: "unknown_target" } });
    } finally {
      release.open();
    }
    await removal;
    expect(await storedShares(workspace.id)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("makes the removal of the target of a grant wait for the grant to end, and then removes the share too", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const leaving = memberOf(workspace, 2);
    const held = gateOf();
    const release = gateOf();
    const granting = inTenant(ownerTenant(workspace), async (tx) => {
      const result = await folderShareRepository(tx).grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "member", accountId: leaving } });
      held.open();
      await release.opened;
      return result;
    });
    await Promise.race([held.opened, granting]);
    let removed = false;
    const removal = asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${leaving}`).then(() => {
      removed = true;
    });
    try {
      await waitUntilSomeoneWaits("the removal");
      expect(removed).toBe(false);
    } finally {
      release.open();
    }
    expect(await granting).toMatchObject({ kind: "granted" });
    await removal;
    expect(removed).toBe(true);
    expect(await storedShares(workspace.id)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("makes the deletion of a team wait for a grant to it, and takes the share with it", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const folderId = await seedFolder(workspace.id, owner);
    const teamId = await seedTeam(workspace.id, "Going");
    const held = gateOf();
    const release = gateOf();
    const granting = inTenant(ownerTenant(workspace), async (tx) => {
      const result = await folderShareRepository(tx).grant({ id: freshId(), folderId, grantedBy: owner, target: { kind: "team", teamId } });
      held.open();
      await release.opened;
      return result;
    });
    await Promise.race([held.opened, granting]);
    let deleted = false;
    const deletion = asSystem(db, (tx) => tx`DELETE FROM teams WHERE id = ${teamId}`).then(() => {
      deleted = true;
    });
    try {
      await waitUntilSomeoneWaits("the deletion");
      expect(deleted).toBe(false);
    } finally {
      release.open();
    }
    expect(await granting).toMatchObject({ kind: "granted" });
    await deletion;
    expect(await storedShares(workspace.id)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
