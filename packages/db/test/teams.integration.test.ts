import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceRepository, isTeamNameTaken, listRepositoryMethods, teamRepository, workspacePurgeOrder } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The teams of a workspace (doc 05 section 2.3, doc 02 section 4, doc 10 T1 and T2). The failure scenario: an admin of workspace A addresses
// the teams of workspace B by identifier, through the repository and with the application's predicates left out so that only row-level security
// stands, and reads, changes, deletes and fills nothing of B's. Besides that: a name is unique per workspace without regard to case; the version
// is the database's and moves with the name and the description; the set of members is replaced under a lock and takes only current members of
// the workspace; a member who leaves the workspace leaves its teams; and a team goes with its memberships, and with the workspace.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const CHECK_VIOLATION = "23514";
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
async function account(displayName = "Teams test"): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `teams${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", displayName });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(roles: readonly Role[] = ["owner", "admin", "member"]): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Teams test" });
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
  return db.tenant.withTenant({ ...tenant, requestId: "teams-test" }, work);
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

/** Writes a team as slugbase_system, which stands for the operations that write in ways a request may not. */
async function seedTeam(workspaceId: string, name: string, members: readonly string[] = [], id = freshId()): Promise<string> {
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${name})`;
    for (const accountId of members) {
      await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${id}, ${accountId})`;
    }
  });
  return id;
}

interface StoredTeam {
  id: string;
  name: string;
  description: string;
  version: number;
}

async function storedTeams(workspaceId: string): Promise<StoredTeam[]> {
  return asSystem(db, (tx) => tx<StoredTeam[]>`SELECT id, name::text AS name, description, version FROM teams WHERE workspace_id = ${workspaceId} ORDER BY name, id`);
}

async function storedMembersVersion(teamId: string): Promise<number> {
  const [row] = await asSystem(db, (tx) => tx<{ members_version: number }[]>`SELECT members_version FROM teams WHERE id = ${teamId}`);
  return row?.members_version ?? -1;
}

async function storedMembers(teamId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string }[]>`SELECT account_id FROM team_members WHERE team_id = ${teamId} ORDER BY account_id`);
  return rows.map((row) => row.account_id);
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

describe("the tables", () => {
  it("has the columns, keys, checks and index of doc 05 section 2.3", async () => {
    const columns = await db.owner<{ table_name: string; column_name: string; is_nullable: string; udt_name: string; column_default: string | null }[]>`
      SELECT table_name, column_name, is_nullable, udt_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('teams', 'team_members') ORDER BY table_name, ordinal_position`;
    expect(columns.filter((column) => column.table_name === "teams").map((column) => [column.column_name, column.udt_name, column.is_nullable])).toEqual([
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["name", "citext", "NO"],
      ["description", "text", "NO"],
      ["version", "int4", "NO"],
      ["created_at", "timestamptz", "NO"],
      ["updated_at", "timestamptz", "NO"],
      ["members_version", "int4", "NO"],
      ["versioned_at", "timestamptz", "NO"],
    ]);
    expect(columns.filter((column) => column.table_name === "team_members").map((column) => [column.column_name, column.udt_name, column.is_nullable])).toEqual([
      ["workspace_id", "uuid", "NO"],
      ["team_id", "uuid", "NO"],
      ["account_id", "uuid", "NO"],
    ]);
    const constraints = await db.owner<{ conrelid: string; conname: string; definition: string }[]>`
      SELECT conrelid::regclass::text AS conrelid, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('public.teams'::regclass, 'public.team_members'::regclass) ORDER BY conrelid::regclass::text, conname`;
    const definitions = Object.fromEntries(constraints.map((constraint) => [constraint.conname, constraint.definition]));
    expect(definitions["teams_workspace_id_id_key"]).toBe("UNIQUE (workspace_id, id)");
    expect(definitions["teams_name_key"]).toBe("UNIQUE (workspace_id, name)");
    expect(definitions["team_members_pkey"]).toBe("PRIMARY KEY (team_id, account_id)");
    expect(definitions["team_members_team_fkey"]).toBe("FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE");
    expect(definitions["team_members_member_fkey"]).toBe("FOREIGN KEY (workspace_id, account_id) REFERENCES workspace_members(workspace_id, account_id) ON DELETE CASCADE");
    const indexes = await db.owner<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'team_members' AND indexname = 'team_members_account_idx'`;
    expect(indexes[0]?.indexdef).toContain("(workspace_id, account_id)");
  });

  it("has row-level security enabled and forced, with a tenant policy, on both tables", async () => {
    const tables = await db.owner<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('public.teams'::regclass, 'public.team_members'::regclass) ORDER BY relname`;
    expect(tables).toEqual([
      { relname: "team_members", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "teams", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const policies = await db.owner<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('teams', 'team_members') ORDER BY tablename, policyname`;
    expect(policies.map((policy) => [policy.policyname, policy.cmd])).toEqual([
      ["team_members_tenant", "SELECT"],
      ["team_members_tenant_delete", "DELETE"],
      ["team_members_tenant_insert", "INSERT"],
      ["teams_tenant", "SELECT"],
      ["teams_tenant_delete", "DELETE"],
      ["teams_tenant_insert", "INSERT"],
      ["teams_tenant_update", "UPDATE"],
    ]);
    for (const policy of policies) {
      expect(`${policy.qual ?? ""}${policy.with_check ?? ""}`).toContain("app_workspace_id()");
    }
  });

  it("registers its repositories in the scoped-repository registry and the purge registry", () => {
    const methods = listRepositoryMethods();
    expect(methods.filter((entry) => entry.repository === "teams").map((entry) => entry.method).sort()).toEqual(["delete", "insert", "select", "update"]);
    expect(methods.filter((entry) => entry.repository === "team_members").map((entry) => entry.method).sort()).toEqual(["delete", "insert", "select"]);
    expect(workspacePurgeOrder.indexOf("team_members")).toBeLessThan(workspacePurgeOrder.indexOf("teams"));
    expect(workspacePurgeOrder.indexOf("team_members")).toBeLessThan(workspacePurgeOrder.indexOf("workspace_members"));
  });

  it("refuses a name of 0 or 65 characters and a description of 281, and accepts the limits", async () => {
    const workspace = await workspaceOf(["owner"]);
    const insert = (name: string, description: string) => asSystem(db, (tx) => tx`INSERT INTO teams (id, workspace_id, name, description) VALUES (${freshId()}, ${workspace.id}, ${name}, ${description})`);
    expect(await refusedWith(insert("", ""))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("n".repeat(65), ""))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("valid", "d".repeat(281)))).toBe(CHECK_VIOLATION);
    expect(await refusedWith(insert("n".repeat(64), "d".repeat(280)))).toBeUndefined();
    expect(await refusedWith(insert("x", ""))).toBeUndefined();
  });

  it("lets the application role insert the columns of a creation and update the name, the description and the member revision only", async () => {
    const workspace = await workspaceOf(["owner"]);
    const owner = memberOf(workspace, 0);
    const tenant = { accountId: owner, workspaceId: workspace.id };
    const teamId = freshId();
    expect(await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO teams (id, workspace_id, name) VALUES (${teamId}, ${workspace.id}, 'granted')`))).toBeUndefined();
    expect(await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO teams (id, workspace_id, name, version) VALUES (${freshId()}, ${workspace.id}, 'version', 9)`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE teams SET description = 'granted' WHERE id = ${teamId}`))).toBeUndefined();
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE teams SET members_version = 1 WHERE id = ${teamId}`))).toBeUndefined();
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE teams SET version = 7 WHERE id = ${teamId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE teams SET versioned_at = now() WHERE id = ${teamId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`INSERT INTO teams (id, workspace_id, name, versioned_at) VALUES (${freshId()}, ${workspace.id}, 'stamped', now())`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE teams SET workspace_id = ${freshId()} WHERE id = ${teamId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(tenant, (tx) => tx`UPDATE team_members SET account_id = ${owner} WHERE team_id = ${teamId}`))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("the failure scenario: an admin of workspace A addressing the teams of workspace B", () => {
  it("reads, changes, deletes and fills nothing of B's through the repository, and B's rows stay as they were", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const teamOfB = await seedTeam(b.id, "B only", [memberOf(b, 1)]);
    const before = { teams: await storedTeams(b.id), members: await storedMembers(teamOfB) };
    const admin = { accountId: memberOf(a, 1), workspaceId: a.id };

    const outcome = await inTenant(admin, async (tx) => {
      const repository = teamRepository(tx);
      return {
        list: await repository.list({ after: undefined, limit: 50 }),
        find: await repository.find(teamOfB),
        update: await repository.update({ teamId: teamOfB, changes: { name: "taken over", description: "mine" }, expectedVersions: undefined }),
        replace: await repository.replaceMembers({ teamId: teamOfB, accountIds: [memberOf(a, 0)], expectedVersions: undefined }),
        remove: await repository.remove(teamOfB),
      };
    });

    expect(outcome.list).toEqual([]);
    expect(outcome.find).toBeUndefined();
    expect(outcome.update).toEqual({ kind: "not_found" });
    expect(outcome.replace).toEqual({ kind: "not_found" });
    expect(outcome.remove).toBeUndefined();
    expect({ teams: await storedTeams(b.id), members: await storedMembers(teamOfB) }).toEqual(before);
  });

  it("reads, changes, deletes and fills nothing of B's with the application's predicates left out, where only row-level security stands", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const teamOfB = await seedTeam(b.id, "B only", [memberOf(b, 1)]);
    const teamOfA = await seedTeam(a.id, "A only", [memberOf(a, 1)]);
    const before = { teams: await storedTeams(b.id), members: await storedMembers(teamOfB) };
    const admin = { accountId: memberOf(a, 1), workspaceId: a.id };

    const seen = await appAs(admin, async (tx) => ({
      teams: await tx<{ id: string }[]>`SELECT id FROM teams`,
      memberships: await tx<{ team_id: string }[]>`SELECT team_id FROM team_members`,
      renamed: await tx<{ id: string }[]>`UPDATE teams SET name = 'taken over' RETURNING id`,
      removed: await tx<{ id: string }[]>`DELETE FROM teams WHERE id = ${teamOfB} RETURNING id`,
      unlinked: await tx<{ team_id: string }[]>`DELETE FROM team_members WHERE team_id = ${teamOfB} RETURNING team_id`,
    }));

    // The only rows a statement of A's finds are A's own.
    expect(seen.teams.map((row) => row.id)).toEqual([teamOfA]);
    expect(seen.memberships.map((row) => row.team_id)).toEqual([teamOfA]);
    expect(seen.renamed.map((row) => row.id)).toEqual([teamOfA]);
    expect(seen.removed).toHaveLength(0);
    expect(seen.unlinked).toHaveLength(0);
    expect({ teams: await storedTeams(b.id), members: await storedMembers(teamOfB) }).toEqual(before);

    // A statement that names workspace B is refused by the policy.
    expect(await refusedWith(appAs(admin, (tx) => tx`INSERT INTO teams (id, workspace_id, name) VALUES (${freshId()}, ${b.id}, 'planted')`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(admin, (tx) => tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${b.id}, ${teamOfB}, ${memberOf(b, 0)})`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedTeams(b.id)).toEqual(before.teams);
    expect(await storedMembers(teamOfB)).toEqual(before.members);
  });

  it("shows a team and its members to every member of the workspace, a plain member included", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "Everyone sees", [memberOf(workspace, 1)]);
    const found = await inTenant({ accountId: memberOf(workspace, 2), workspaceId: workspace.id }, (tx) => teamRepository(tx).find(teamId));
    expect(found).toMatchObject({ id: teamId, name: "Everyone sees", memberCount: 1 });
    expect(found?.members.map((member) => member.accountId)).toEqual([memberOf(workspace, 1)]);
  });
});

describe("the name of a team", () => {
  it("is unique per workspace without regard to case, and the same name may live in another workspace", async () => {
    const a = await workspaceOf(["owner"]);
    const b = await workspaceOf(["owner"]);
    const tenantA = { accountId: memberOf(a, 0), workspaceId: a.id };
    const created = await inTenant(tenantA, (tx) => teamRepository(tx).create({ id: freshId(), name: "Design", description: "" }));
    expect(created.kind).toBe("created");
    const again = await inTenant(tenantA, (tx) => teamRepository(tx).create({ id: freshId(), name: "dEsIgN", description: "other" }));
    expect(again).toEqual({ kind: "name_taken" });
    expect(await storedTeams(a.id)).toHaveLength(1);
    const elsewhere = await inTenant({ accountId: memberOf(b, 0), workspaceId: b.id }, (tx) => teamRepository(tx).create({ id: freshId(), name: "Design", description: "" }));
    expect(elsewhere.kind).toBe("created");
  });

  it("refuses a rename to the name of another team, in any case, and writes nothing", async () => {
    const workspace = await workspaceOf(["owner"]);
    const tenant = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    await seedTeam(workspace.id, "Design");
    const other = await seedTeam(workspace.id, "Ops");
    const result = await inTenant(tenant, (tx) => teamRepository(tx).update({ teamId: other, changes: { name: "DESIGN", description: "changed" }, expectedVersions: undefined }));
    expect(result).toEqual({ kind: "name_taken" });
    expect((await storedTeams(workspace.id)).find((team) => team.id === other)).toMatchObject({ name: "Ops", description: "", version: 1 });
  });

  it("lets a team change the case of its own name, which moves the version although citext calls the names equal", async () => {
    const workspace = await workspaceOf(["owner"]);
    const tenant = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "design");
    const result = await inTenant(tenant, (tx) => teamRepository(tx).update({ teamId, changes: { name: "Design" }, expectedVersions: undefined }));
    expect(result).toMatchObject({ kind: "updated", previousName: "design", team: { name: "Design", version: 2 } });
  });

  it("answers a rename that meets another at the unique key as a name that is taken, with nothing written", async () => {
    const workspace = await workspaceOf(["owner"]);
    const owner = memberOf(workspace, 0);
    const first = await seedTeam(workspace.id, "First");
    await seedTeam(workspace.id, "Second");
    const failure = await appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`UPDATE teams SET name = 'Second' WHERE id = ${first}`).catch((caught: unknown) => caught);
    expect(isTeamNameTaken(failure)).toBe(true);
    expect(isTeamNameTaken(new Error("another failure"))).toBe(false);
    expect((await storedTeams(workspace.id)).map((team) => team.name)).toEqual(["First", "Second"]);
  });
});

describe("the version of a team", () => {
  it("moves by one with a change of the name or the description, and stays for the values the row has", async () => {
    const workspace = await workspaceOf(["owner"]);
    const tenant = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Versioned");
    const update = (changes: { name?: string; description?: string }, expectedVersions?: readonly number[]) =>
      inTenant(tenant, (tx) => teamRepository(tx).update({ teamId, changes, expectedVersions }));

    expect(await update({ description: "first" })).toMatchObject({ kind: "updated", team: { version: 2, description: "first" } });
    expect(await update({ name: "Versioned", description: "first" })).toMatchObject({ kind: "unchanged", team: { version: 2 } });
    expect(await update({})).toMatchObject({ kind: "unchanged", team: { version: 2 } });
    expect(await update({ name: "Renamed" })).toMatchObject({ kind: "updated", team: { version: 3, name: "Renamed" } });
    expect(await update({ name: "Stale" }, [2])).toEqual({ kind: "stale" });
    expect(await update({ name: "Fresh" }, [1, 3])).toMatchObject({ kind: "updated", team: { version: 4 } });
    expect(await update({ name: "Never" }, [])).toEqual({ kind: "stale" });
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ name: "Fresh", version: 4 });
  });

  it("is the trigger's alone: a statement cannot set it, whatever it writes to the version or the member revision", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "Steady");
    await asSystem(db, (tx) => tx`UPDATE teams SET version = 50, name = 'Trigger' WHERE id = ${teamId}`);
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ name: "Trigger", version: 2 });
    await asSystem(db, (tx) => tx`UPDATE teams SET version = 50, members_version = 900 WHERE id = ${teamId}`);
    expect(await storedMembersVersion(teamId)).toBe(1);
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ version: 3 });
    await asSystem(db, (tx) => tx`UPDATE teams SET name = 'Both', members_version = 5 WHERE id = ${teamId}`);
    expect(await storedMembersVersion(teamId)).toBe(2);
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ name: "Both", version: 4 });
  });

  it("moves by one with a replacement that changes the member set, and stays for the set the team has", async () => {
    const workspace = await workspaceOf();
    const tenant = { accountId: memberOf(workspace, 1), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Steady");
    const replace = (accountIds: string[], expectedVersions?: readonly number[]) =>
      inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds, expectedVersions }));

    expect(await replace([memberOf(workspace, 0), memberOf(workspace, 2)])).toMatchObject({ kind: "replaced", team: { version: 2 } });
    expect(await replace([memberOf(workspace, 2), memberOf(workspace, 0)])).toMatchObject({ kind: "unchanged", team: { version: 2 } });
    expect(await replace([memberOf(workspace, 0)], [2])).toMatchObject({ kind: "replaced", added: 0, removed: 1, team: { version: 3 } });
    expect(await replace([memberOf(workspace, 2)], [3])).toMatchObject({ kind: "replaced", added: 1, removed: 1, team: { version: 4 } });
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ version: 4 });
    expect(await storedMembersVersion(teamId)).toBe(3);
  });

  it("is compared under the team's lock: of two replacements made against one version the second is stale and writes nothing", async () => {
    const workspace = await workspaceOf();
    const tenant = { accountId: memberOf(workspace, 1), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Contested", [memberOf(workspace, 0)]);
    const replace = (accountIds: string[], expectedVersions: readonly number[]) =>
      inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds, expectedVersions }));

    const first = await replace([memberOf(workspace, 0), memberOf(workspace, 2)], [1]);
    const second = await replace([memberOf(workspace, 0)], [1]);

    expect(first).toMatchObject({ kind: "replaced", team: { version: 2 } });
    expect(second).toEqual({ kind: "stale" });
    expect(await storedMembers(teamId)).toEqual(sorted([memberOf(workspace, 0), memberOf(workspace, 2)]));
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ version: 2 });
    expect(await replace([], [])).toEqual({ kind: "stale" });
    expect(await storedMembers(teamId)).toHaveLength(2);
  });

  it("stamps the start of the transaction that moved it, and leaves the stamp where it was for a write of the values the row has", async () => {
    const workspace = await workspaceOf(["owner"]);
    const teamId = await seedTeam(workspace.id, "Stamped");
    const stampOf = async (): Promise<Date> => {
      const [row] = await asSystem(db, (tx) => tx<{ versioned_at: Date }[]>`SELECT versioned_at FROM teams WHERE id = ${teamId}`);
      if (row === undefined) {
        throw new Error("the team is gone");
      }
      return row.versioned_at;
    };
    const created = await stampOf();

    await asSystem(db, (tx) => tx`UPDATE teams SET description = '' WHERE id = ${teamId}`);
    expect((await stampOf()).getTime()).toBe(created.getTime());
    await asSystem(db, (tx) => tx`UPDATE teams SET description = 'moved' WHERE id = ${teamId}`);
    const renamed = await stampOf();
    expect(renamed.getTime()).toBeGreaterThan(created.getTime());
    await asSystem(db, (tx) => tx`UPDATE teams SET versioned_at = ${created}, members_version = 1 WHERE id = ${teamId}`);
    expect((await stampOf()).getTime()).toBeGreaterThan(renamed.getTime());
  });

  describe("when an account that joined the workspace after the version was written is added", () => {
    interface Scene {
      readonly workspace: Workspace;
      readonly owner: string;
      readonly returning: string;
      readonly teamId: string;
    }

    /** An instance admin with a second factor, who is a member of a workspace and of its team Design with its owner. */
    async function sceneOfAnInstanceAdmin(): Promise<Scene> {
      const workspace = await workspaceOf(["owner", "member"]);
      emailNumber += 1;
      const returning = freshId();
      await seedAccount(db, { id: returning, email: `teams${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", isInstanceAdmin: true, emailVerified: true });
      await db.owner.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${returning}, true)`;
        await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${returning}`;
      });
      await seedMember(db, { workspaceId: workspace.id, accountId: returning, role: "member", joinedAt: new Date(Date.now() - 60_000) });
      const owner = memberOf(workspace, 0);
      const teamId = await seedTeam(workspace.id, "Design", [owner, returning]);
      return { workspace, owner, returning, teamId };
    }

    /** The admin leaves the workspace and adds themselves again through the instance operation, which writes no invitation and moves no version. */
    async function leaveAndAddAgain({ workspace, returning }: Scene): Promise<void> {
      await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${returning}`);
      const added = await inTenant({ accountId: returning }, (tx) =>
        instanceRepository(tx).addMembership({ workspaceId: workspace.id, eventIds: { workspace: freshId(), instance: freshId() } }, null, []),
      );
      expect(added).toEqual({ kind: "added" });
    }

    const replace = ({ workspace, owner, teamId }: Scene, accountIds: string[], expectedVersions: readonly number[]) =>
      inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds, expectedVersions }));

    it("refuses a replacement read before the account left and added themselves again, leaves the set as it was and moves only the version", async () => {
      const scene = await sceneOfAnInstanceAdmin();
      const read = 1;
      await leaveAndAddAgain(scene);
      expect(await storedMembers(scene.teamId)).toEqual([scene.owner]);
      expect((await storedTeams(scene.workspace.id)).find((team) => team.id === scene.teamId)?.version).toBe(read);

      expect(await replace(scene, [scene.owner, scene.returning], [read])).toEqual({ kind: "stale" });

      expect(await storedMembers(scene.teamId)).toEqual([scene.owner]);
      expect((await storedTeams(scene.workspace.id)).find((team) => team.id === scene.teamId)?.version).toBe(read + 1);
      // The same request made again against the version it read is refused for the version.
      expect(await replace(scene, [scene.owner, scene.returning], [read])).toEqual({ kind: "stale" });
      expect(await storedMembers(scene.teamId)).toEqual([scene.owner]);
    });

    it("applies a replacement read after the account was added again, once the refusal has moved the version", async () => {
      const scene = await sceneOfAnInstanceAdmin();
      await leaveAndAddAgain(scene);
      expect(await replace(scene, [scene.owner, scene.returning], [1])).toEqual({ kind: "stale" });

      expect(await replace(scene, [scene.owner, scene.returning], [2])).toMatchObject({ kind: "replaced", added: 1, removed: 0, team: { version: 3 } });
      expect(await storedMembers(scene.teamId)).toEqual(sorted([scene.owner, scene.returning]));
    });

    it("does not refuse a replacement that does not add that account, and one without a precondition applies as it did", async () => {
      const scene = await sceneOfAnInstanceAdmin();
      const member = memberOf(scene.workspace, 1);
      await leaveAndAddAgain(scene);

      expect(await replace(scene, [scene.owner], [1])).toMatchObject({ kind: "unchanged", team: { version: 1 } });
      expect(await replace(scene, [scene.owner, member], [1])).toMatchObject({ kind: "replaced", added: 1, removed: 0, team: { version: 2 } });
      const unconditional = await inTenant({ accountId: scene.owner, workspaceId: scene.workspace.id }, (tx) =>
        teamRepository(tx).replaceMembers({ teamId: scene.teamId, accountIds: [scene.owner, member, scene.returning], expectedVersions: undefined }),
      );
      expect(unconditional).toMatchObject({ kind: "replaced", added: 1, removed: 0, team: { version: 3 } });
    });
  });

  it("is judged before the accounts: a stale request for an account that is no member is stale, and a current one for it is unknown_members", async () => {
    const workspace = await workspaceOf();
    const tenant = { accountId: memberOf(workspace, 1), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Judged");
    const outsider = freshId();
    const replace = (expectedVersions: readonly number[]) => inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds: [outsider], expectedVersions }));

    expect(await replace([9])).toEqual({ kind: "stale" });
    expect(await replace([1])).toEqual({ kind: "unknown_members" });
    expect((await storedTeams(workspace.id))[0]).toMatchObject({ version: 1 });
  });
});

describe("the members of a team", () => {
  it("are replaced: those outside the set are removed, those in it are added, one named twice counts once", async () => {
    const workspace = await workspaceOf();
    const [owner, admin, member] = [memberOf(workspace, 0), memberOf(workspace, 1), memberOf(workspace, 2)];
    const tenant = { accountId: admin, workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Replaced", [owner, admin]);
    const result = await inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds: [admin, member, member.toUpperCase()], expectedVersions: undefined }));
    expect(result).toMatchObject({ kind: "replaced", added: 1, removed: 1, team: { memberCount: 2 } });
    expect(sorted(result.kind === "replaced" ? result.team.members.map((entry) => entry.accountId) : [])).toEqual(sorted([admin, member]));
    expect(await storedMembers(teamId)).toEqual(sorted([admin, member]));
  });

  it("answers a set the team has already as unchanged, and an empty set empties the team", async () => {
    const workspace = await workspaceOf();
    const tenant = { accountId: memberOf(workspace, 1), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Steady", [memberOf(workspace, 0)]);
    expect(await inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds: [memberOf(workspace, 0)], expectedVersions: undefined }))).toMatchObject({ kind: "unchanged", team: { memberCount: 1 } });
    expect(await inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds: [], expectedVersions: undefined }))).toMatchObject({ kind: "replaced", added: 0, removed: 1, team: { memberCount: 0, members: [] } });
    expect(await storedMembers(teamId)).toEqual([]);
    expect(await inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds: [], expectedVersions: undefined }))).toMatchObject({ kind: "unchanged" });
  });

  it("take only current members of the workspace: an account of another workspace or none at all is refused and nothing is written", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const tenant = { accountId: memberOf(a, 1), workspaceId: a.id };
    const teamId = await seedTeam(a.id, "Strict", [memberOf(a, 0)]);
    const stranger = await account("Not a member");
    for (const outsider of [memberOf(b, 0), stranger, freshId()]) {
      const result = await inTenant(tenant, (tx) => teamRepository(tx).replaceMembers({ teamId, accountIds: [memberOf(a, 2), outsider], expectedVersions: undefined }));
      expect(result).toEqual({ kind: "unknown_members" });
      expect(await storedMembers(teamId)).toEqual([memberOf(a, 0)]);
    }
  });

  it("lists with their co-member projection, ordered by display name, and the list counts them", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "Listed", [memberOf(workspace, 2), memberOf(workspace, 0)]);
    await seedTeam(workspace.id, "Empty");
    const tenant = { accountId: memberOf(workspace, 2), workspaceId: workspace.id };
    const detail = await inTenant(tenant, (tx) => teamRepository(tx).find(teamId));
    expect(detail?.members.map((member) => member.displayName)).toEqual(["Member 0", "Member 2"]);
    expect(detail?.members.every((member) => member.email.endsWith("@example.test"))).toBe(true);
    const list = await inTenant(tenant, (tx) => teamRepository(tx).list({ after: undefined, limit: 50 }));
    expect(list.map((team) => [team.name, team.memberCount])).toEqual([["Empty", 0], ["Listed", 2]]);
  });

  it("are paged by a keyset over name and identifier that repeats and skips nothing", async () => {
    const workspace = await workspaceOf(["owner"]);
    const tenant = { accountId: memberOf(workspace, 0), workspaceId: workspace.id };
    for (const name of ["delta", "Alpha", "charlie", "Bravo", "echo"]) {
      await seedTeam(workspace.id, name);
    }
    const seen: string[] = [];
    let after: { name: string; id: string } | undefined;
    for (let page = 0; page < 5; page += 1) {
      const rows = await inTenant(tenant, (tx) => teamRepository(tx).list({ after, limit: 2 }));
      seen.push(...rows.map((team) => team.name));
      const last = rows.at(-1);
      if (rows.length < 2 || last === undefined) {
        break;
      }
      after = { name: last.name, id: last.id };
    }
    expect(seen).toEqual(["Alpha", "Bravo", "charlie", "delta", "echo"]);
  });
});

describe("the memberships of a team", () => {
  it("go when the member leaves the workspace, and the team and its other members stay", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "Leaving", [memberOf(workspace, 1), memberOf(workspace, 2)]);
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${memberOf(workspace, 2)}`);
    expect(await storedMembers(teamId)).toEqual([memberOf(workspace, 1)]);
    expect(await storedTeams(workspace.id)).toMatchObject([{ version: 1 }]);
  });

  it("go with a deleted team, which leaves the members in the workspace, and the repeat finds nothing", async () => {
    const workspace = await workspaceOf();
    const tenant = { accountId: memberOf(workspace, 1), workspaceId: workspace.id };
    const teamId = await seedTeam(workspace.id, "Doomed", [memberOf(workspace, 0), memberOf(workspace, 2)]);
    expect(await inTenant(tenant, (tx) => teamRepository(tx).remove(teamId))).toBe("Doomed");
    expect(await storedMembers(teamId)).toEqual([]);
    expect(await storedTeams(workspace.id)).toEqual([]);
    const members = await asSystem(db, (tx) => tx`SELECT account_id FROM workspace_members WHERE workspace_id = ${workspace.id}`);
    expect(members).toHaveLength(3);
    expect(await inTenant(tenant, (tx) => teamRepository(tx).remove(teamId))).toBeUndefined();
  });

  it("go with the workspace", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "With the workspace", [memberOf(workspace, 0)]);
    await asSystem(db, async (tx) => {
      await tx`DELETE FROM team_members WHERE workspace_id = ${workspace.id}`;
      await tx`DELETE FROM teams WHERE workspace_id = ${workspace.id}`;
    });
    expect(await storedMembers(teamId)).toEqual([]);
    const remaining = await asSystem(db, (tx) => tx`SELECT count(*)::int AS n FROM teams WHERE workspace_id = ${workspace.id}`);
    expect(remaining[0]?.["n"]).toBe(0);
  });
});

describe("a member who leaves the workspace while the member set of a team is replaced", () => {
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

  it("answers unknown_members, and not a foreign-key error, for a member whose removal the replacement waits for", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "Racing");
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
      const replacing = inTenant({ accountId: memberOf(workspace, 1), workspaceId: workspace.id }, (tx) =>
        teamRepository(tx).replaceMembers({ teamId, accountIds: [memberOf(workspace, 0), leaving], expectedVersions: undefined }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const pid = await waitUntilSomeoneWaits("the replacement");
      const blockedBy = await db.app<{ pids: number[] }[]>`SELECT pg_blocking_pids(${pid}) AS pids`;
      expect(blockedBy[0]?.pids.length).toBeGreaterThan(0);
      release.open();
      await removal;
      expect(await replacing).toEqual({ value: { kind: "unknown_members" } });
    } finally {
      release.open();
    }
    await removal;
    expect(await storedMembers(teamId)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("makes a removal of a member in the new set wait for the replacement to end, and then removes the membership too", async () => {
    const workspace = await workspaceOf();
    const teamId = await seedTeam(workspace.id, "Racing again");
    const leaving = memberOf(workspace, 2);
    const held = gateOf();
    const release = gateOf();
    const replacing = inTenant({ accountId: memberOf(workspace, 1), workspaceId: workspace.id }, async (tx) => {
      const result = await teamRepository(tx).replaceMembers({ teamId, accountIds: [leaving], expectedVersions: undefined });
      held.open();
      await release.opened;
      return result;
    });
    await Promise.race([held.opened, replacing]);
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
    expect(await replacing).toMatchObject({ kind: "replaced", added: 1 });
    await removal;
    expect(removed).toBe(true);
    expect(await storedMembers(teamId)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
