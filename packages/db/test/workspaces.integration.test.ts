import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountProfileRepository, membershipRepository, TenantContextError } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum } from "./support/workspace-fixture.ts";

// Workspaces and membership (doc 05 sections 2.2 and 3.3, doc 10 T1): the two
// tables, the policies that keep one account's workspaces from another's, the
// function the workspaces policy reads, and the repositories the tenant
// resolver and the profile read through. The failure scenario is an account
// that names a workspace it is not a member of, by a guessed id.

const HOOK_TIMEOUT_MS = 300_000;
const MINUTE_MS = 60_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(overrides: { passwordHash?: string | null } = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `member${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", ...overrides });
  return id;
}

/** Runs `work` on the application role with the settings of a tenant transaction and nothing else: row-level security alone decides what it sees. */
async function asApp<T>(accountId: string, workspaceId: string | undefined, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

function tenant<T>(accountId: string, workspaceId: string | undefined, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, ...(workspaceId === undefined ? {} : { workspaceId }), requestId: "workspaces-test" }, work);
}

interface World {
  readonly alice: string;
  readonly bob: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

/** Alice is the owner of workspace A and Bob the owner of workspace B; neither is a member of the other's. */
async function world(): Promise<World> {
  const alice = await account();
  const bob = await account();
  const workspaceA = await seedWorkspace(db, { name: "Workspace A", createdBy: alice });
  const workspaceB = await seedWorkspace(db, { name: "Workspace B", createdBy: bob });
  await seedMember(db, { workspaceId: workspaceA, accountId: alice, role: "owner" });
  await seedMember(db, { workspaceId: workspaceB, accountId: bob, role: "owner" });
  return { alice, bob, workspaceA, workspaceB };
}

describe("the workspace tables", () => {
  it("have the columns of doc 05 section 2.2", async () => {
    const columns = async (table: string) => {
      const rows = await db.owner<{ name: string; type: string; nullable: boolean; fallback: string | null }[]>`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS fallback
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ${`public.${table}`}::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`;
      return rows.map((row) => `${row.name} ${row.type}${row.nullable ? "" : " NOT NULL"}${row.fallback === null ? "" : ` DEFAULT ${row.fallback}`}`);
    };
    expect(await columns("workspaces")).toEqual([
      "id uuid NOT NULL",
      "name text NOT NULL",
      "created_by uuid",
      "entitlement_version integer NOT NULL DEFAULT 1",
      "bookmark_count integer NOT NULL DEFAULT 0",
      "deleting_at timestamp with time zone",
      "version integer NOT NULL DEFAULT 1",
      "created_at timestamp with time zone NOT NULL DEFAULT now()",
      "updated_at timestamp with time zone NOT NULL DEFAULT now()",
    ]);
    expect(await columns("workspace_members")).toEqual([
      "workspace_id uuid NOT NULL",
      "account_id uuid NOT NULL",
      "role member_role NOT NULL",
      "joined_at timestamp with time zone NOT NULL DEFAULT now()",
      "last_active_at timestamp with time zone",
    ]);
    const roles = await db.owner<{ value: string }[]>`SELECT unnest(enum_range(NULL::member_role))::text AS value`;
    expect(roles.map((row) => row.value)).toEqual(["owner", "admin", "member"]);
  });

  it("key a membership by its workspace and account, and refuse a name outside 1 to 64 characters and a negative bookmark count", async () => {
    const keys = await db.owner<{ columns: string[] }[]>`
      SELECT array_agg(a.attname ORDER BY k.ord)::text[] AS columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'public.workspace_members'::regclass AND c.contype = 'p'
      GROUP BY c.oid`;
    expect(keys.map((row) => row.columns)).toEqual([["workspace_id", "account_id"]]);
    const person = await account();
    const workspace = await seedWorkspace(db);
    await seedMember(db, { workspaceId: workspace, accountId: person });
    await expect(seedMember(db, { workspaceId: workspace, accountId: person })).rejects.toMatchObject({ code: "23505" });
    await expect(seedWorkspace(db, { name: "" })).rejects.toMatchObject({ code: "23514" });
    await expect(seedWorkspace(db, { name: "x".repeat(65) })).rejects.toMatchObject({ code: "23514" });
    await expect(asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = -1 WHERE id = ${workspace}`)).rejects.toMatchObject({ code: "23514" });
  });

  it("have row-level security enabled and forced, with a read policy and the write policies of the active workspace", async () => {
    const rows = await db.owner<{ table: string; enabled: boolean; forced: boolean; policies: string[] }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT array_agg(p.polname ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      WHERE c.oid IN ('public.workspaces'::regclass, 'public.workspace_members'::regclass)
      ORDER BY c.relname`;
    expect([...rows]).toEqual([
      { table: "workspace_members", enabled: true, forced: true, policies: ["workspace_members_tenant", "workspace_members_tenant_delete", "workspace_members_tenant_update"] },
      { table: "workspaces", enabled: true, forced: true, policies: ["workspaces_tenant", "workspaces_tenant_delete", "workspaces_tenant_update"] },
    ]);
  });

  it("give slugbase_app a read of both tables and a write of last_active_at alone", async () => {
    const privileges = await db.owner<{ table: string; privilege: string }[]>`
      SELECT t AS table, p AS privilege
      FROM unnest(ARRAY['workspaces', 'workspace_members']) AS t,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
      WHERE has_table_privilege('slugbase_app', 'public.' || t, p)
      ORDER BY t, p`;
    expect([...privileges]).toEqual([
      { table: "workspace_members", privilege: "SELECT" },
      { table: "workspaces", privilege: "SELECT" },
    ]);
    const columns = await db.owner<{ column: string }[]>`
      SELECT a.attname AS column
      FROM pg_attribute a
      WHERE a.attrelid = 'public.workspace_members'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.workspace_members', a.attname, 'UPDATE')`;
    expect(columns.map((row) => row.column)).toEqual(["last_active_at"]);
    const workspaceColumns = await db.owner<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_attribute a
      WHERE a.attrelid = 'public.workspaces'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.workspaces', a.attname, 'UPDATE')`;
    expect(workspaceColumns[0]?.count).toBe(0);
  });

  it("move updated_at of a workspace on an UPDATE, whatever value the statement writes to it", async () => {
    const id = await seedWorkspace(db);
    const read = () => asSystem(db, (tx) => tx<{ created_at: Date; updated_at: Date }[]>`SELECT created_at, updated_at FROM workspaces WHERE id = ${id}`);
    const [before] = await read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await asSystem(db, (tx) => tx`UPDATE workspaces SET name = 'Renamed', updated_at = '2000-01-01T00:00:00Z' WHERE id = ${id}`);
    const [after] = await read();
    expect(after?.created_at).toEqual(before?.created_at);
    expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Number.POSITIVE_INFINITY);
    const triggers = await db.owner<{ name: string }[]>`
      SELECT t.tgname AS name FROM pg_trigger t WHERE t.tgrelid = 'public.workspaces'::regclass AND NOT t.tgisinternal`;
    expect(triggers.map((row) => row.name)).toEqual(["workspaces_set_updated_at"]);
  });
});

describe("sessions.active_workspace_id", () => {
  it("references workspaces and is set to null, not deleted, when the workspace goes", async () => {
    const references = await db.owner<{ target: string; on_delete: string }[]>`
      SELECT c.confrelid::regclass::text AS target, c.confdeltype::text AS on_delete
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'public.sessions'::regclass AND c.contype = 'f' AND a.attname = 'active_workspace_id'`;
    expect([...references]).toEqual([{ target: "workspaces", on_delete: "n" }]);

    const person = await account();
    const workspace = await seedWorkspace(db);
    const { hash } = freshToken();
    const sessionId = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO sessions (id, token_hash, account_id, level, active_workspace_id, remember, expires_at, absolute_expires_at)
        VALUES (${sessionId}, ${hash}, ${person}, 'full', ${workspace}, false, now() + interval '1 day', now() + interval '2 days')`,
    );
    await asSystem(db, (tx) => tx`DELETE FROM workspaces WHERE id = ${workspace}`);
    const rows = await asSystem(db, (tx) => tx<{ active_workspace_id: string | null }[]>`SELECT active_workspace_id FROM sessions WHERE id = ${sessionId}`);
    expect([...rows]).toEqual([{ active_workspace_id: null }]);
  });

  it("refuses a workspace that does not exist", async () => {
    const person = await account();
    const { hash } = freshToken();
    await expect(
      asSystem(
        db,
        (tx) => tx`
          INSERT INTO sessions (id, token_hash, account_id, level, active_workspace_id, remember, expires_at, absolute_expires_at)
          VALUES (${freshId()}, ${hash}, ${person}, 'full', ${freshId()}, false, now() + interval '1 day', now() + interval '2 days')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("app_member_workspace_ids", () => {
  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path, callable by slugbase_app only, and in the registry", async () => {
    const rows = await db.owner<{ definer: boolean; owner: string; config: string[]; app: boolean; public: boolean; returns_set: boolean }[]>`
      SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.proretset AS returns_set,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'app_member_workspace_ids'`;
    expect([...rows]).toEqual([
      { definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], returns_set: true, app: true, public: false },
    ]);
    expect(systemOperations).toContain("app_member_workspace_ids");
  });

  it("returns the calling account's workspaces without one being deleted, and nothing outside withTenant", async () => {
    const person = await account();
    const first = await seedWorkspace(db);
    const second = await seedWorkspace(db);
    const deleting = await seedWorkspace(db, { deletingAt: new Date() });
    const foreign = await seedWorkspace(db);
    for (const workspaceId of [first, second, deleting]) {
      await seedMember(db, { workspaceId, accountId: person });
    }
    const other = await account();
    await seedMember(db, { workspaceId: foreign, accountId: other });

    const ids = await asApp(person, undefined, (tx) => tx<{ id: string }[]>`SELECT * FROM app_member_workspace_ids() AS id`);
    expect(ids.map((row) => row.id).sort()).toEqual([first, second].sort());
    expect([...(await db.app<{ id: string }[]>`SELECT * FROM app_member_workspace_ids() AS id`)]).toEqual([]);
  });
});

describe("the policies, with row-level security as the only guard (T1)", () => {
  it("show an account the workspaces it belongs to and the members of its active workspace, and no row of another", async () => {
    const { alice, bob, workspaceA, workspaceB } = await world();
    const colleague = await account();
    await seedMember(db, { workspaceId: workspaceA, accountId: colleague });
    const before = await workspaceChecksum(db, workspaceB);

    await asApp(alice, workspaceA, async (tx) => {
      const workspaces = await tx<{ id: string }[]>`SELECT id FROM workspaces`;
      expect(workspaces.map((row) => row.id)).toContain(workspaceA);
      expect(workspaces.map((row) => row.id)).not.toContain(workspaceB);
      expect([...(await tx`SELECT id FROM workspaces WHERE id = ${workspaceB}`)]).toEqual([]);
      const members = await tx<{ workspace_id: string; account_id: string }[]>`SELECT workspace_id, account_id FROM workspace_members`;
      expect(members.map((row) => row.workspace_id)).not.toContain(workspaceB);
      expect(members.filter((row) => row.workspace_id === workspaceA).map((row) => row.account_id).sort()).toEqual([alice, colleague].sort());
      expect([...(await tx`SELECT 1 FROM workspace_members WHERE workspace_id = ${workspaceB}`)]).toEqual([]);
      expect([...(await tx`SELECT 1 FROM workspace_members WHERE account_id = ${bob}`)]).toEqual([]);
    });
    expect(await workspaceChecksum(db, workspaceB)).toBe(before);
  });

  it("show an account its own memberships in every workspace when none is active, and only those", async () => {
    const { alice, workspaceA, workspaceB } = await world();
    const extra = await seedWorkspace(db);
    await seedMember(db, { workspaceId: extra, accountId: alice, role: "member" });
    const rows = await asApp(alice, undefined, (tx) => tx<{ workspace_id: string; account_id: string }[]>`SELECT workspace_id, account_id FROM workspace_members`);
    expect(rows.map((row) => row.workspace_id).sort()).toEqual([workspaceA, extra].sort());
    expect(new Set(rows.map((row) => row.account_id))).toEqual(new Set([alice]));
    expect(rows.map((row) => row.workspace_id)).not.toContain(workspaceB);
  });

  it("show nothing without an account, or to an account with no membership, whatever workspace is named", async () => {
    const { workspaceA } = await world();
    const stranger = await account();
    expect([...(await asApp(stranger, undefined, (tx) => tx`SELECT id FROM workspaces`))]).toEqual([]);
    expect([...(await asApp(stranger, undefined, (tx) => tx`SELECT workspace_id FROM workspace_members`))]).toEqual([]);
    expect([...(await db.app`SELECT id FROM workspaces WHERE id = ${workspaceA}`)]).toEqual([]);
    expect([...(await db.app`SELECT workspace_id FROM workspace_members`)]).toEqual([]);
  });

  it("hide a workspace being deleted, from its own members and in the transaction that names it", async () => {
    const person = await account();
    const live = await seedWorkspace(db);
    const dying = await seedWorkspace(db, { deletingAt: new Date() });
    await seedMember(db, { workspaceId: live, accountId: person });
    await seedMember(db, { workspaceId: dying, accountId: person });
    expect((await asApp(person, undefined, (tx) => tx<{ id: string }[]>`SELECT id FROM workspaces`)).map((row) => row.id)).toEqual([live]);
    expect([...(await asApp(person, dying, (tx) => tx`SELECT id FROM workspaces WHERE id = ${dying}`))]).toEqual([]);
  });

  it("refuse a write to another workspace's membership and to any column but last_active_at, and leave workspace B unchanged", async () => {
    const { alice, bob, workspaceA, workspaceB } = await world();
    const before = await workspaceChecksum(db, workspaceB);

    const touchedB = await asApp(alice, workspaceA, (tx) => tx`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = ${workspaceB} RETURNING account_id`);
    expect([...touchedB]).toEqual([]);
    const touchedBob = await asApp(alice, workspaceA, (tx) => tx`UPDATE workspace_members SET last_active_at = now() WHERE account_id = ${bob} RETURNING account_id`);
    expect([...touchedBob]).toEqual([]);
    await expect(asApp(alice, workspaceA, (tx) => tx`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ${workspaceB}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(alice, workspaceA, (tx) => tx`UPDATE workspaces SET name = 'taken' WHERE id = ${workspaceB}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(alice, workspaceA, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceB}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(alice, workspaceA, (tx) => tx`DELETE FROM workspaces WHERE id = ${workspaceB}`)).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(alice, workspaceA, (tx) => tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspaceB}, ${alice}, 'owner')`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(alice, workspaceA, (tx) => tx`INSERT INTO workspaces (id, name) VALUES (${freshId()}, 'made up')`)).rejects.toMatchObject({ code: "42501" });

    expect(await workspaceChecksum(db, workspaceB)).toBe(before);
  });

  it("let a member move its own last_active_at in the active workspace", async () => {
    const { alice, workspaceA } = await world();
    const rows = await asApp(alice, workspaceA, (tx) => tx<{ account_id: string }[]>`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = ${workspaceA} AND account_id = ${alice} RETURNING account_id`);
    expect(rows.map((row) => row.account_id)).toEqual([alice]);
  });
});

describe("the membership repository", () => {
  it("lists the account's memberships with the workspace name and role, most recently active first, never another account's", async () => {
    const person = await account();
    const rival = await account();
    const now = Date.now();
    const idle = await seedWorkspace(db, { name: "Idle" });
    const older = await seedWorkspace(db, { name: "Older" });
    const newer = await seedWorkspace(db, { name: "Newer" });
    const neverActiveOld = await seedWorkspace(db, { name: "Joined long ago" });
    const neverActiveNew = await seedWorkspace(db, { name: "Joined lately" });
    const dying = await seedWorkspace(db, { name: "Dying", deletingAt: new Date() });
    const foreign = await seedWorkspace(db, { name: "Foreign" });
    await seedMember(db, { workspaceId: idle, accountId: person, role: "member", joinedAt: new Date(now - 9 * MINUTE_MS), lastActiveAt: new Date(now - 8 * MINUTE_MS) });
    await seedMember(db, { workspaceId: older, accountId: person, role: "admin", joinedAt: new Date(now - 30 * MINUTE_MS), lastActiveAt: new Date(now - 20 * MINUTE_MS) });
    await seedMember(db, { workspaceId: newer, accountId: person, role: "owner", joinedAt: new Date(now - 40 * MINUTE_MS), lastActiveAt: new Date(now - 1 * MINUTE_MS) });
    await seedMember(db, { workspaceId: neverActiveOld, accountId: person, joinedAt: new Date(now - 60 * MINUTE_MS) });
    await seedMember(db, { workspaceId: neverActiveNew, accountId: person, joinedAt: new Date(now - 50 * MINUTE_MS) });
    await seedMember(db, { workspaceId: dying, accountId: person, lastActiveAt: new Date(now) });
    await seedMember(db, { workspaceId: foreign, accountId: rival, lastActiveAt: new Date(now) });

    const memberships = await tenant(person, undefined, (tx) => membershipRepository(tx).list());
    expect(memberships.map((membership) => [membership.name, membership.role])).toEqual([
      ["Newer", "owner"],
      ["Idle", "member"],
      ["Older", "admin"],
      ["Joined lately", "member"],
      ["Joined long ago", "member"],
    ]);
    expect(memberships[0]).toMatchObject({ workspaceId: newer, lastActiveAt: new Date(now - MINUTE_MS) });
    expect(memberships.at(-1)?.lastActiveAt).toBeNull();
    expect(await tenant(await account(), undefined, (tx) => membershipRepository(tx).list())).toEqual([]);
  });

  it("lists the same memberships in a transaction that has an active workspace", async () => {
    const { alice, workspaceA } = await world();
    const memberships = await tenant(alice, workspaceA, (tx) => membershipRepository(tx).list());
    expect(memberships.map((membership) => membership.workspaceId)).toEqual([workspaceA]);
  });

  it("moves last_active_at at most once a minute, and only for the member in the transaction's workspace", async () => {
    const { alice, bob, workspaceA, workspaceB } = await world();
    const colleague = await account();
    await seedMember(db, { workspaceId: workspaceA, accountId: colleague });
    const before = await workspaceChecksum(db, workspaceB);
    const stored = (accountId: string, workspaceId: string) =>
      asSystem(db, (tx) => tx<{ last_active_at: Date | null }[]>`SELECT last_active_at FROM workspace_members WHERE account_id = ${accountId} AND workspace_id = ${workspaceId}`).then((rows) => rows[0]?.last_active_at ?? null);

    expect(await stored(alice, workspaceA)).toBeNull();
    expect(await tenant(alice, workspaceA, (tx) => membershipRepository(tx).touch())).toBe(true);
    const first = await stored(alice, workspaceA);
    expect(first).toBeInstanceOf(Date);
    expect(await tenant(alice, workspaceA, (tx) => membershipRepository(tx).touch())).toBe(false);
    expect(await stored(alice, workspaceA)).toEqual(first);

    await asSystem(db, (tx) => tx`UPDATE workspace_members SET last_active_at = now() - interval '61 seconds' WHERE account_id = ${alice} AND workspace_id = ${workspaceA}`);
    expect(await tenant(alice, workspaceA, (tx) => membershipRepository(tx).touch())).toBe(true);
    expect((await stored(alice, workspaceA))?.getTime()).toBeGreaterThan(Date.now() - 30_000);

    expect(await stored(colleague, workspaceA)).toBeNull();
    expect(await stored(bob, workspaceB)).toBeNull();
    expect(await workspaceChecksum(db, workspaceB)).toBe(before);
  });

  it("does not touch a membership the account does not have, even in a workspace it names", async () => {
    const { alice, workspaceB } = await world();
    const before = await workspaceChecksum(db, workspaceB);
    expect(await tenant(alice, workspaceB, (tx) => membershipRepository(tx).touch())).toBe(false);
    expect(await workspaceChecksum(db, workspaceB)).toBe(before);
  });

  it("needs a transaction with a workspace to touch", async () => {
    const { alice } = await world();
    await expect(tenant(alice, undefined, (tx) => membershipRepository(tx).touch())).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the account profile repository", () => {
  it("returns the account's preferences, whether the email is verified and whether it has a password, and nothing secret", async () => {
    const withPassword = await account();
    const withoutPassword = await account({ passwordHash: null });
    await asSystem(db, (tx) => tx`UPDATE accounts SET email_verified_at = now(), accent = 'violet', locale = 'de', ai_opt_out = true WHERE id = ${withPassword}`);

    const profile = await tenant(withPassword, undefined, (tx) => accountProfileRepository(tx).profile());
    expect(profile).toEqual({
      id: withPassword,
      email: expect.stringMatching(/^member\d+@example\.test$/) as string,
      displayName: "Test account",
      locale: "de",
      theme: "system",
      accent: "violet",
      defaultBookmarkView: "grid",
      singleKeyShortcuts: true,
      signinAlerts: true,
      aiOptOut: true,
      analyticsConsent: "unset",
      onboarding: { browserSetupDone: false, importDone: false, checklistDismissed: false },
      emailVerified: true,
      hasPassword: true,
      mfaEnabled: false,
      pendingEmail: null,
    });
    expect(JSON.stringify(profile)).not.toContain("argon2");

    const bare = await tenant(withoutPassword, undefined, (tx) => accountProfileRepository(tx).profile());
    expect(bare).toMatchObject({ emailVerified: false, hasPassword: false, accent: null });
  });

  it("reports the address of a pending email change as stored, and null when none is pending", async () => {
    const changing = await account();
    const settled = await account();
    await asSystem(db, (tx) => tx`UPDATE accounts SET pending_email = 'Pending.Address@Example.test' WHERE id = ${changing}`);

    expect(await tenant(changing, undefined, (tx) => accountProfileRepository(tx).profile())).toMatchObject({ pendingEmail: "Pending.Address@Example.test" });
    expect(await tenant(settled, undefined, (tx) => accountProfileRepository(tx).profile())).toMatchObject({ pendingEmail: null });
  });

  it("reports the second factor as on only for an account whose MFA is confirmed, and for no other", async () => {
    const confirmed = await account();
    const pendingOnly = await account();
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = '\\x01', mfa_secret_key_id = 'key-1', mfa_enabled_at = now() WHERE id = ${confirmed}`);
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = '\\x01', mfa_secret_key_id = 'key-1' WHERE id = ${pendingOnly}`);

    expect(await tenant(confirmed, undefined, (tx) => accountProfileRepository(tx).profile())).toMatchObject({ mfaEnabled: true });
    expect(await tenant(pendingOnly, undefined, (tx) => accountProfileRepository(tx).profile())).toMatchObject({ mfaEnabled: false });
  });

  it("answers nothing for an account whose row is not visible", async () => {
    expect(await tenant(freshId(), undefined, (tx) => accountProfileRepository(tx).profile())).toBeUndefined();
  });

  it("registers sys_account_has_password, which answers NULL outside a tenant transaction", async () => {
    expect(systemOperations).toContain("sys_account_has_password");
    const rows = await db.app<{ answer: boolean | null }[]>`SELECT sys_account_has_password() AS answer`;
    expect([...rows]).toEqual([{ answer: null }]);
  });
});
