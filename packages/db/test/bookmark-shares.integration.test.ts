import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkShareRepository, listRepositoryMethods, shareTargetRepository, workspacePurgeOrder } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The shares of bookmarks (doc 05 section 2.5, doc 02 section 8, doc 10 T1 and T2). The failure scenario: a member of the workspace grants a share on
// another member's bookmark by its identifier, and the owner shares with an account that is no member of the workspace (or with the team of another
// workspace); both are refused, through the repository and with the application's predicates left out so that only the policies and the foreign keys
// stand, and no row is written. Besides that: a share is one per target; the audience counts distinct members other than the owner; a share goes with
// its bookmark, its member and its team, and with the workspace; and a grant and the removal of its target do not meet half-way.

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

async function seedBookmark(workspaceId: string, ownerId: string | null, extra: { archived?: boolean } = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/share', 'https://example.com/share', 'example.com', 'Shared bookmark', ${extra.archived === true ? new Date() : null})`,
  );
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
async function seedShare(workspaceId: string, bookmarkId: string, target: { accountId: string } | { teamId: string }, grantedBy: string | null = null): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by)
      VALUES (${id}, ${workspaceId}, ${bookmarkId}, ${"accountId" in target ? target.accountId : null}, ${"teamId" in target ? target.teamId : null}, ${grantedBy})`,
  );
  return id;
}

async function storedShares(workspaceId: string): Promise<{ id: string; bookmark_id: string; target_account_id: string | null; target_team_id: string | null; granted_by: string | null }[]> {
  return asSystem(
    db,
    (tx) => tx<{ id: string; bookmark_id: string; target_account_id: string | null; target_team_id: string | null; granted_by: string | null }[]>`
      SELECT id, bookmark_id, target_account_id, target_team_id, granted_by FROM bookmark_shares WHERE workspace_id = ${workspaceId} ORDER BY id`,
  );
}

const ownerTenant = (workspace: Workspace) => ({ accountId: memberOf(workspace, 0), workspaceId: workspace.id });

describe("the table", () => {
  it("has the columns, keys, checks and indexes of doc 05 section 2.5", async () => {
    const columns = await db.owner<{ column_name: string; is_nullable: string; udt_name: string }[]>`
      SELECT column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookmark_shares' ORDER BY ordinal_position`;
    expect(columns.map((column) => [column.column_name, column.udt_name, column.is_nullable])).toEqual([
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["bookmark_id", "uuid", "NO"],
      ["target_account_id", "uuid", "YES"],
      ["target_team_id", "uuid", "YES"],
      ["granted_by", "uuid", "YES"],
      ["created_at", "timestamptz", "NO"],
    ]);
    const constraints = await db.owner<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'public.bookmark_shares'::regclass ORDER BY conname`;
    const definitions = Object.fromEntries(constraints.map((constraint) => [constraint.conname, constraint.definition]));
    expect(definitions["bookmark_shares_bookmark_fkey"]).toBe("FOREIGN KEY (workspace_id, bookmark_id) REFERENCES bookmarks(workspace_id, id) ON DELETE CASCADE");
    expect(definitions["bookmark_shares_member_fkey"]).toBe("FOREIGN KEY (workspace_id, target_account_id) REFERENCES workspace_members(workspace_id, account_id) ON DELETE CASCADE");
    expect(definitions["bookmark_shares_team_fkey"]).toBe("FOREIGN KEY (workspace_id, target_team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE");
    expect(definitions["bookmark_shares_granted_by_accounts_id_fk"]).toBe("FOREIGN KEY (granted_by) REFERENCES accounts(id) ON DELETE SET NULL");
    expect(definitions["bookmark_shares_target_check"]).toContain("target_account_id IS NULL");
    const indexes = await db.owner<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'bookmark_shares'`;
    const byName = Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]));
    expect(byName["bookmark_shares_account_key"]).toMatch(/CREATE UNIQUE INDEX .* \(bookmark_id, target_account_id\) WHERE \(target_account_id IS NOT NULL\)/);
    expect(byName["bookmark_shares_team_key"]).toMatch(/CREATE UNIQUE INDEX .* \(bookmark_id, target_team_id\) WHERE \(target_team_id IS NOT NULL\)/);
    expect(byName["bookmark_shares_account_idx"]).toContain("(workspace_id, target_account_id, bookmark_id)");
    expect(byName["bookmark_shares_team_idx"]).toContain("(workspace_id, target_team_id, bookmark_id)");
  });

  it("has row-level security enabled and forced, with a workspace policy to read and an owner policy to write", async () => {
    const tables = await db.owner<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.bookmark_shares'::regclass`;
    expect(tables).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await db.owner<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bookmark_shares' ORDER BY policyname`;
    expect(policies.map((policy) => [policy.policyname, policy.cmd])).toEqual([
      ["bookmark_shares_tenant", "SELECT"],
      ["bookmark_shares_tenant_delete", "DELETE"],
      ["bookmark_shares_tenant_insert", "INSERT"],
    ]);
    for (const policy of policies) {
      expect(`${policy.qual ?? ""}${policy.with_check ?? ""}`).toContain("app_workspace_id()");
    }
    for (const policy of policies.filter((entry) => entry.cmd !== "SELECT")) {
      expect(`${policy.qual ?? ""}${policy.with_check ?? ""}`).toContain("app_account_id()");
    }
  });

  it("registers its repository in the scoped-repository registry and the purge registry", () => {
    expect(listRepositoryMethods().filter((entry) => entry.repository === "bookmark_shares").map((entry) => entry.method).sort()).toEqual(["delete", "insert", "select"]);
    expect(workspacePurgeOrder.indexOf("bookmark_shares")).toBeLessThan(workspacePurgeOrder.indexOf("bookmarks"));
    expect(workspacePurgeOrder.indexOf("bookmark_shares")).toBeLessThan(workspacePurgeOrder.indexOf("teams"));
    expect(workspacePurgeOrder.indexOf("bookmark_shares")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
  });

  it("refuses a share with no target and a share with two, and one share per bookmark and target", async () => {
    const workspace = await workspaceOf();
    const bookmarkId = await seedBookmark(workspace.id, memberOf(workspace, 0));
    const teamId = await seedTeam(workspace.id, "Both");
    const insert = (accountId: string | null, team: string | null) =>
      asSystem(db, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, target_team_id) VALUES (${freshId()}, ${workspace.id}, ${bookmarkId}, ${accountId}, ${team})`);
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
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const tenant = { accountId: owner, workspaceId: workspace.id };
    const shareId = freshId();
    expect(
      await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${shareId}, ${workspace.id}, ${bookmarkId}, ${memberOf(workspace, 2)}, ${owner})`)),
    ).toBeUndefined();
    expect(await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by, created_at) VALUES (${freshId()}, ${workspace.id}, ${bookmarkId}, ${memberOf(workspace, 3)}, ${owner}, now())`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE bookmark_shares SET target_account_id = ${memberOf(workspace, 3)} WHERE id = ${shareId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`DELETE FROM bookmark_shares WHERE id = ${shareId}`))).toBeUndefined();
    expect(await storedShares(workspace.id)).toEqual([]);
  });
});

describe("the failure scenario: a share that is not the owner's to grant, or has no target in the workspace", () => {
  it("lets a member who does not own the bookmark grant nothing on it by its identifier, through the repository", async () => {
    const workspace = await workspaceOf();
    const bookmarkId = await seedBookmark(workspace.id, memberOf(workspace, 0));
    const before = await storedShares(workspace.id);

    const outcome = await inTenant({ accountId: memberOf(workspace, 2), workspaceId: workspace.id }, async (tx) => {
      const repository = bookmarkShareRepository(tx);
      return {
        owned: await repository.ownedBookmark({ bookmarkId, ownerId: memberOf(workspace, 2), use: "grant" }),
        readable: await repository.ownedBookmark({ bookmarkId, ownerId: memberOf(workspace, 2), use: "read" }),
      };
    });

    expect(outcome).toEqual({ owned: false, readable: false });
    expect(await storedShares(workspace.id)).toEqual(before);
  });

  it("refuses by policy a share that another member writes on the bookmark, or writes in the owner's name, with the application's predicates left out", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const intruder = memberOf(workspace, 2);
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const sharedByOwner = await seedShare(workspace.id, bookmarkId, { accountId: memberOf(workspace, 3) }, owner);
    const tenant = { accountId: intruder, workspaceId: workspace.id };
    const insert = (grantedBy: string) =>
      appAs(tenant, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspace.id}, ${bookmarkId}, ${intruder}, ${grantedBy})`);

    expect(await refusedWith(insert(intruder))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(insert(owner))).toBe(INSUFFICIENT_PRIVILEGE);
    const seen = await appAs(tenant, async (tx) => ({
      removed: await tx<{ id: string }[]>`DELETE FROM bookmark_shares WHERE id = ${sharedByOwner} RETURNING id`,
    }));
    expect(seen.removed).toHaveLength(0);
    expect((await storedShares(workspace.id)).map((share) => share.id)).toEqual([sharedByOwner]);
  });

  it("writes no share for an account that is no member of the workspace, or for the team of another workspace, through the repository", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const outsider = memberOf(b, 2);
    const teamOfB = await seedTeam(b.id, "B only", [memberOf(b, 2)]);
    const bookmarkId = await seedBookmark(a.id, memberOf(a, 0));

    const outcome = await inTenant(ownerTenant(a), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      return {
        outsider: await repository.grant({ id: freshId(), bookmarkId, grantedBy: memberOf(a, 0), target: { kind: "member", accountId: outsider } }),
        unknownAccount: await repository.grant({ id: freshId(), bookmarkId, grantedBy: memberOf(a, 0), target: { kind: "member", accountId: freshId() } }),
        teamOfB: await repository.grant({ id: freshId(), bookmarkId, grantedBy: memberOf(a, 0), target: { kind: "team", teamId: teamOfB } }),
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
    const bookmarkId = await seedBookmark(a.id, owner);
    const teamOfB = await seedTeam(b.id, "B only");
    const tenant = { accountId: owner, workspaceId: a.id };

    expect(
      await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${a.id}, ${bookmarkId}, ${memberOf(b, 2)}, ${owner})`)),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_team_id, granted_by) VALUES (${freshId()}, ${a.id}, ${bookmarkId}, ${teamOfB}, ${owner})`)),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(await storedShares(a.id)).toEqual([]);
  });

  it("shows, reads and changes nothing of workspace B's shares to a member of workspace A, with the application's predicates left out, and refuses a share that names B", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const bookmarkOfB = await seedBookmark(b.id, memberOf(b, 0));
    const shareOfB = await seedShare(b.id, bookmarkOfB, { accountId: memberOf(b, 2) }, memberOf(b, 0));
    const bookmarkOfA = await seedBookmark(a.id, memberOf(a, 0));
    const shareOfA = await seedShare(a.id, bookmarkOfA, { accountId: memberOf(a, 2) }, memberOf(a, 0));
    const before = await storedShares(b.id);

    const seen = await appAs(ownerTenant(a), async (tx) => ({
      shares: await tx<{ id: string }[]>`SELECT id FROM bookmark_shares`,
      removed: await tx<{ id: string }[]>`DELETE FROM bookmark_shares WHERE id = ${shareOfB} RETURNING id`,
    }));
    expect(seen.shares.map((row) => row.id)).toEqual([shareOfA]);
    expect(seen.removed).toHaveLength(0);
    expect(
      await refusedWith(appAs(ownerTenant(a), (tx) => tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${b.id}, ${bookmarkOfB}, ${memberOf(b, 3)}, ${memberOf(a, 0)})`)),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedShares(b.id)).toEqual(before);

    const throughRepository = await inTenant(ownerTenant(a), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      return { list: await repository.list(bookmarkOfB), revoked: await repository.revoke({ bookmarkId: bookmarkOfB, shareId: shareOfB }) };
    });
    expect(throughRepository).toEqual({ list: { shares: [], audienceSize: 0 }, revoked: undefined });
    expect(await storedShares(b.id)).toEqual(before);
  });
});

describe("granting, listing and revoking", () => {
  it("shares a bookmark with a member and with a team, and a repeated grant answers the share that exists", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const teamId = await seedTeam(workspace.id, "Design", [memberOf(workspace, 1)]);

    const result = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      const first = await repository.grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "member", accountId: memberOf(workspace, 2) } });
      const repeated = await repository.grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "member", accountId: memberOf(workspace, 2) } });
      const team = await repository.grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "team", teamId } });
      const teamAgain = await repository.grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "team", teamId } });
      return { first, repeated, team, teamAgain };
    });

    expect(result.first).toMatchObject({ kind: "granted", share: { accountId: memberOf(workspace, 2), teamId: null, name: "Member 2", bookmarkId } });
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
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const otherBookmark = await seedBookmark(workspace.id, owner);
    const design = await seedTeam(workspace.id, "Design", [owner, admin, ada]);
    const ops = await seedTeam(workspace.id, "Ops", [ada, bob]);
    await seedTeam(workspace.id, "Empty");
    await seedShare(workspace.id, bookmarkId, { teamId: design }, owner);
    await seedShare(workspace.id, bookmarkId, { teamId: ops }, owner);
    await seedShare(workspace.id, bookmarkId, { accountId: ada }, owner);
    await seedShare(workspace.id, bookmarkId, { accountId: cy }, owner);
    await seedShare(workspace.id, otherBookmark, { accountId: bob }, owner);

    const { list, other, none } = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      return { list: await repository.list(bookmarkId), other: await repository.list(otherBookmark), none: await repository.list(freshId()) };
    });

    // admin and ada through Design, ada and bob through Ops, ada and cy directly: four members, and the owner of the bookmark, who is in Design, is not counted
    expect(list.audienceSize).toBe(4);
    expect(list.shares).toHaveLength(4);
    expect(list.shares.map((share) => share.name).sort()).toEqual(["Design", "Member 2", "Member 4", "Ops"]);
    expect(other.audienceSize).toBe(1);
    expect(none).toEqual({ shares: [], audienceSize: 0 });
  });

  it("revokes a share of the bookmark and nothing else, and answers a share of another bookmark, a revoked one and an unknown one as not found", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const otherBookmark = await seedBookmark(workspace.id, owner);
    const share = await seedShare(workspace.id, bookmarkId, { accountId: memberOf(workspace, 2) }, owner);
    const keep = await seedShare(workspace.id, bookmarkId, { accountId: memberOf(workspace, 3) }, owner);

    const outcome = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      return {
        wrongBookmark: await repository.revoke({ bookmarkId: otherBookmark, shareId: share }),
        unknown: await repository.revoke({ bookmarkId, shareId: freshId() }),
        revoked: await repository.revoke({ bookmarkId, shareId: share }),
        again: await repository.revoke({ bookmarkId, shareId: share }),
      };
    });

    expect(outcome.wrongBookmark).toBeUndefined();
    expect(outcome.unknown).toBeUndefined();
    expect(outcome.revoked).toMatchObject({ id: share, accountId: memberOf(workspace, 2), name: "Member 2" });
    expect(outcome.again).toBeUndefined();
    expect((await storedShares(workspace.id)).map((row) => row.id)).toEqual([keep]);
  });

  it("owns a bookmark only for the account that owns it, and refuses to grant on a bookmark the plan archived, whose shares can still be read and ended", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const live = await seedBookmark(workspace.id, owner);
    const archived = await seedBookmark(workspace.id, owner, { archived: true });
    const ownerless = await seedBookmark(workspace.id, null);

    const outcome = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      const ask = (bookmarkId: string, use: "read" | "grant" | "revoke") => repository.ownedBookmark({ bookmarkId, ownerId: owner, use });
      return {
        live: [await ask(live, "read"), await ask(live, "grant"), await ask(live, "revoke")],
        archived: [await ask(archived, "read"), await ask(archived, "grant"), await ask(archived, "revoke")],
        ownerless: [await ask(ownerless, "read"), await ask(ownerless, "grant"), await ask(ownerless, "revoke")],
        unknown: await ask(freshId(), "read"),
      };
    });

    expect(outcome).toEqual({ live: [true, true, true], archived: [true, false, true], ownerless: [false, false, false], unknown: false });
  });
});

describe("sharing many bookmarks at once", () => {
  it("shares the owner's live bookmarks with a member in one statement, once for a bookmark shared with the member already, and reports the shares it made", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const recipient = memberOf(workspace, 2);
    const [first, second, third] = [await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner)];
    await seedShare(workspace.id, first, { accountId: recipient }, owner);

    const result = await inTenant(ownerTenant(workspace), (tx) =>
      bookmarkShareRepository(tx).share({ bookmarkIds: [first, second, third, second.toUpperCase()], ownerId: owner, target: { kind: "member", accountId: recipient }, newId: freshId }),
    );

    expect(result).toEqual({ kind: "done", affected: 3, granted: 2, targetName: "Member 2" });
    const stored = await storedShares(workspace.id);
    expect(stored.map((share) => [share.bookmark_id, share.target_account_id, share.granted_by]).sort()).toEqual(
      [first, second, third].map((bookmarkId) => [bookmarkId, recipient, owner]).sort(),
    );
  });

  it("shares with a team, and a repeat of the same request makes no share", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const teamId = await seedTeam(workspace.id, "Design", [memberOf(workspace, 1)]);
    const bookmarkIds = [await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner)];

    const results = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      const request = { bookmarkIds, ownerId: owner, target: { kind: "team", teamId } as const, newId: freshId };
      return [await repository.share(request), await repository.share(request)];
    });

    expect(results).toEqual([
      { kind: "done", affected: 2, granted: 2, targetName: "Design" },
      { kind: "done", affected: 2, granted: 0, targetName: "Design" },
    ]);
    expect(await storedShares(workspace.id)).toHaveLength(2);
  });

  it("reaches only the owner's own live bookmarks: another member's, one that is plan-archived, one of another workspace and an unknown one get no share, and the recipient's access stays as it was", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const recipient = memberOf(workspace, 2);
    const own = await seedBookmark(workspace.id, owner);
    const recipientOnly = await seedBookmark(workspace.id, memberOf(workspace, 1));
    await seedShare(workspace.id, recipientOnly, { accountId: owner }, memberOf(workspace, 1));
    const archived = await seedBookmark(workspace.id, owner, { archived: true });
    const foreign = await seedBookmark(other.id, memberOf(other, 0));
    const before = await storedShares(workspace.id);

    const result = await inTenant(ownerTenant(workspace), (tx) =>
      bookmarkShareRepository(tx).share({ bookmarkIds: [own, recipientOnly, archived, foreign, freshId()], ownerId: owner, target: { kind: "member", accountId: recipient }, newId: freshId }),
    );

    expect(result).toEqual({ kind: "done", affected: 1, granted: 1, targetName: "Member 2" });
    const after = await storedShares(workspace.id);
    expect(after.filter((share) => !before.some((known) => known.id === share.id)).map((share) => [share.bookmark_id, share.target_account_id])).toEqual([[own, recipient]]);
    expect(after.filter((share) => share.bookmark_id === recipientOnly)).toEqual(before.filter((share) => share.bookmark_id === recipientOnly));
    expect(await storedShares(other.id)).toEqual([]);
  });

  it("answers unknown_target, writing nothing, for an account that is no member of the workspace and for a team of another workspace, even when no bookmark is named", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const foreignTeam = await seedTeam(other.id, "Elsewhere", [memberOf(other, 1)]);

    const results = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      return [
        await repository.share({ bookmarkIds: [bookmarkId], ownerId: owner, target: { kind: "member", accountId: memberOf(other, 1) }, newId: freshId }),
        await repository.share({ bookmarkIds: [bookmarkId], ownerId: owner, target: { kind: "team", teamId: foreignTeam }, newId: freshId }),
        await repository.share({ bookmarkIds: [], ownerId: owner, target: { kind: "member", accountId: freshId() }, newId: freshId }),
      ];
    });

    expect(results).toEqual([{ kind: "unknown_target" }, { kind: "unknown_target" }, { kind: "unknown_target" }]);
    expect(await storedShares(workspace.id)).toEqual([]);
    expect(await storedShares(other.id)).toEqual([]);
  });

  it("shares nothing as another account: only the account of the transaction shares its own bookmarks", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const bookmarkId = await seedBookmark(workspace.id, owner);

    await expect(
      inTenant({ accountId: memberOf(workspace, 2), workspaceId: workspace.id }, (tx) =>
        bookmarkShareRepository(tx).share({ bookmarkIds: [bookmarkId], ownerId: owner, target: { kind: "member", accountId: memberOf(workspace, 1) }, newId: freshId }),
      ),
    ).rejects.toThrow("only the account of the transaction shares its own bookmarks");
    expect(await storedShares(workspace.id)).toEqual([]);
  });

  it("previews who the bookmarks are shared with afterwards without writing: the audience of a member is one, that of a team its members without the owner, and added counts the bookmarks not shared yet", async () => {
    const workspace = await workspaceOf(["owner", "admin", "member", "member", "member"]);
    const owner = memberOf(workspace, 0);
    const teamId = await seedTeam(workspace.id, "Design", [owner, memberOf(workspace, 1), memberOf(workspace, 2)]);
    const [first, second] = [await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner)];
    const recipientOnly = await seedBookmark(workspace.id, memberOf(workspace, 1));
    await seedShare(workspace.id, first, { teamId }, owner);
    const before = await storedShares(workspace.id);

    const previews = await inTenant(ownerTenant(workspace), async (tx) => {
      const repository = bookmarkShareRepository(tx);
      const bookmarkIds = [first, second, recipientOnly];
      return {
        team: await repository.previewShare({ bookmarkIds, ownerId: owner, target: { kind: "team", teamId } }),
        member: await repository.previewShare({ bookmarkIds, ownerId: owner, target: { kind: "member", accountId: memberOf(workspace, 3) } }),
        unknown: await repository.previewShare({ bookmarkIds, ownerId: owner, target: { kind: "member", accountId: freshId() } }),
      };
    });

    expect(previews.team).toEqual({ kind: "previewed", affected: 2, audience: { kind: "team", id: teamId, name: "Design", memberCount: 2, added: 1 } });
    expect(previews.member).toEqual({ kind: "previewed", affected: 2, audience: { kind: "member", id: memberOf(workspace, 3), name: "Member 3", memberCount: 1, added: 2 } });
    expect(previews.unknown).toEqual({ kind: "unknown_target" });
    expect(await storedShares(workspace.id)).toEqual(before);
  });
});

describe("what takes a share away", () => {
  it("removes the shares of a bookmark with the bookmark, those of a member with the member, and those of a team with the team", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const doomed = await seedBookmark(workspace.id, owner);
    const staying = await seedBookmark(workspace.id, owner);
    const team = await seedTeam(workspace.id, "Doomed team");
    const leaving = memberOf(workspace, 3);
    await seedShare(workspace.id, doomed, { accountId: memberOf(workspace, 2) }, owner);
    await seedShare(workspace.id, staying, { accountId: leaving }, owner);
    await seedShare(workspace.id, staying, { teamId: team }, owner);
    await seedShare(workspace.id, staying, { accountId: memberOf(workspace, 2) }, owner);

    await asSystem(db, (tx) => tx`DELETE FROM bookmarks WHERE id = ${doomed}`);
    expect(await storedShares(workspace.id)).toHaveLength(3);
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${leaving}`);
    expect(await storedShares(workspace.id)).toHaveLength(2);
    await asSystem(db, (tx) => tx`DELETE FROM teams WHERE id = ${team}`);
    expect((await storedShares(workspace.id)).map((share) => [share.bookmark_id, share.target_account_id])).toEqual([[staying, memberOf(workspace, 2)]]);
  });

  it("keeps a share when the member who granted it is deleted, and when the owner of the bookmark has left", async () => {
    const workspace = await workspaceOf();
    const owner = memberOf(workspace, 0);
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const granter = await account("Granter");
    await seedMember(db, { workspaceId: workspace.id, accountId: granter, role: "member" });
    const share = await seedShare(workspace.id, bookmarkId, { accountId: memberOf(workspace, 2) }, granter);

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${granter}`);
    await asSystem(db, (tx) => tx`DELETE FROM accounts WHERE id = ${granter}`);
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${memberOf(workspace, 1)}`);
    expect(await storedShares(workspace.id)).toEqual([{ id: share, bookmark_id: bookmarkId, target_account_id: memberOf(workspace, 2), target_team_id: null, granted_by: null }]);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET owner_id = NULL WHERE id = ${bookmarkId}`);
    expect(await storedShares(workspace.id)).toHaveLength(1);
  });

  it("goes with the workspace: the purge registry empties it", async () => {
    const workspace = await workspaceOf();
    const bookmarkId = await seedBookmark(workspace.id, memberOf(workspace, 0));
    await seedShare(workspace.id, bookmarkId, { accountId: memberOf(workspace, 2) }, memberOf(workspace, 0));
    await asSystem(db, async (tx) => {
      await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspace.id}`;
      const purged = await tx<{ n: number }[]>`SELECT public.sys_workspace_purge_batch(${workspace.id}, 'bookmark_shares', 10) AS n`;
      expect(purged[0]?.n).toBe(1);
    });
    expect(await storedShares(workspace.id)).toEqual([]);
  });
});

describe("whom to share with", () => {
  it("lists the members other than the caller and the teams of the workspace, by name, and only the kinds asked for", async () => {
    const a = await workspaceOf(["owner", "admin", "member"]);
    const b = await workspaceOf(["owner"]);
    await seedTeam(a.id, "Design");
    await seedTeam(b.id, "Member B-team");
    const search = (request: { q?: string; kinds: readonly ("member" | "team")[]; limit?: number }) =>
      inTenant({ accountId: memberOf(a, 2), workspaceId: a.id }, (tx) =>
        shareTargetRepository(tx).search({ q: request.q, excludeAccountId: memberOf(a, 2), kinds: request.kinds, limit: request.limit ?? 20 }),
      );

    const everything = await search({ kinds: ["member", "team"] });
    expect(everything.map((target) => [target.kind, target.name])).toEqual([["team", "Design"], ["member", "Member 0"], ["member", "Member 1"]]);
    expect(everything.map((target) => target.id)).not.toContain(memberOf(a, 2));
    expect(everything.find((target) => target.kind === "team")?.email).toBeNull();
    expect((await search({ kinds: ["team"] })).map((target) => target.name)).toEqual(["Design"]);
    expect((await search({ kinds: ["member"] })).map((target) => target.name)).toEqual(["Member 0", "Member 1"]);
    expect(await search({ kinds: [] })).toEqual([]);
    expect((await search({ kinds: ["member", "team"], limit: 2 })).map((target) => target.name)).toEqual(["Design", "Member 0"]);
  });

  it("matches a part of a name or an address without regard to case and reads the wildcards of LIKE as text", async () => {
    const workspace = await workspaceOf(["owner", "member"]);
    const odd = await account("100%_sure");
    await seedMember(db, { workspaceId: workspace.id, accountId: odd, role: "member" });
    await seedTeam(workspace.id, "Design");
    const search = (q: string) =>
      inTenant({ accountId: memberOf(workspace, 1), workspaceId: workspace.id }, (tx) => shareTargetRepository(tx).search({ q, excludeAccountId: memberOf(workspace, 1), kinds: ["member", "team"], limit: 20 }));

    expect((await search("desi")).map((target) => target.name)).toEqual(["Design"]);
    expect((await search("MEMBER 0")).map((target) => target.name)).toEqual(["Member 0"]);
    expect((await search("example.test")).map((target) => target.kind)).toEqual(["member", "member"]);
    expect((await search("%")).map((target) => target.name)).toEqual(["100%_sure"]);
    expect((await search("_")).map((target) => target.name)).toEqual(["100%_sure"]);
    expect(await search("nobody")).toEqual([]);
  });

  it("offers nothing of another workspace: not its members, not its teams", async () => {
    const a = await workspaceOf(["owner"]);
    const b = await workspaceOf(["owner", "member"]);
    await seedTeam(b.id, "B team");
    const found = await inTenant({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => shareTargetRepository(tx).search({ q: undefined, excludeAccountId: memberOf(a, 0), kinds: ["member", "team"], limit: 50 }));
    expect(found).toEqual([]);
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
    const bookmarkId = await seedBookmark(workspace.id, owner);
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
        bookmarkShareRepository(tx).grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "member", accountId: leaving } }),
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
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const leaving = memberOf(workspace, 2);
    const held = gateOf();
    const release = gateOf();
    const granting = inTenant(ownerTenant(workspace), async (tx) => {
      const result = await bookmarkShareRepository(tx).grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "member", accountId: leaving } });
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
    const bookmarkId = await seedBookmark(workspace.id, owner);
    const teamId = await seedTeam(workspace.id, "Going");
    const held = gateOf();
    const release = gateOf();
    const granting = inTenant(ownerTenant(workspace), async (tx) => {
      const result = await bookmarkShareRepository(tx).grant({ id: freshId(), bookmarkId, grantedBy: owner, target: { kind: "team", teamId } });
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
