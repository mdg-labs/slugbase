import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextError, workspaceRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum } from "./support/workspace-fixture.ts";

// Reading and renaming the active workspace and reading and changing its settings (doc 05 section 2.2, doc
// 04 section 2.4, doc 10 T1 and T2). The failure scenarios: a rename that overwrites a newer name because it
// was made against an older version, two renames made against one version that both succeed, an account that
// reads or changes the workspace or the settings of another workspace, and an application role that can write
// a column of the workspace the operations do not name. The RLS-only checks run statements as slugbase_app with
// the tenant settings of A and no application layer at all.

const HOOK_TIMEOUT_MS = 300_000;
const ROW_LEVEL_SECURITY = "42501";
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
  await seedAccount(db, { id, email: `admin${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

async function seedSettings(workspaceId: string, options: { aiEnabled?: boolean } = {}): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO workspace_settings (workspace_id, ai_enabled) VALUES (${workspaceId}, ${options.aiEnabled ?? true})`);
}

interface Tenant {
  readonly accountId: string;
  readonly workspaceId: string;
}

async function tenantWith(name: string, role: "owner" | "admin" | "member" = "owner"): Promise<Tenant> {
  const accountId = await account();
  const workspaceId = await seedWorkspace(db, { name, createdBy: accountId });
  await seedMember(db, { workspaceId, accountId, role });
  await seedSettings(workspaceId);
  return { accountId, workspaceId };
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "workspace-administration-test" }, work);
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

async function stored(workspaceId: string): Promise<{ name: string; version: number; updatedAt: Date; deletingAt: Date | null }> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ name: string; version: number; updated_at: Date; deleting_at: Date | null }[]>`SELECT name, version, updated_at, deleting_at FROM workspaces WHERE id = ${workspaceId}`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such workspace");
  }
  return { name: row.name, version: row.version, updatedAt: row.updated_at, deletingAt: row.deleting_at };
}

async function storedSettings(workspaceId: string): Promise<{ aiEnabled: boolean; updatedBy: string | null; updatedAt: Date } | undefined> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ ai_enabled: boolean; updated_by: string | null; updated_at: Date }[]>`SELECT ai_enabled, updated_by, updated_at FROM workspace_settings WHERE workspace_id = ${workspaceId}`,
  );
  const row = rows[0];
  return row === undefined ? undefined : { aiEnabled: row.ai_enabled, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

async function settingsChecksum(workspaceId: string): Promise<string> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ digest: string }[]>`SELECT md5(coalesce(string_agg(s::text, '|'), '')) AS digest FROM workspace_settings s WHERE s.workspace_id = ${workspaceId}`,
  );
  return rows[0]?.digest ?? "";
}

async function everythingOf(workspaceId: string): Promise<string> {
  return `${await workspaceChecksum(db, workspaceId)}/${await settingsChecksum(workspaceId)}`;
}

describe("the privileges of the application role", () => {
  it("may write the name and the version of a workspace and nothing else, and no row of the table is added or removed by it", async () => {
    const rows = await db.owner<{ column: string }[]>`
      SELECT a.attname AS column
      FROM pg_attribute a
      WHERE a.attrelid = 'public.workspaces'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.workspaces', a.attname, 'UPDATE')
      ORDER BY a.attname`;
    expect(rows.map((row) => row.column)).toEqual(["name", "version"]);
    const [table] = await db.owner<{ insert: boolean; delete: boolean; update: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'public.workspaces', 'INSERT') AS insert,
             has_table_privilege('slugbase_app', 'public.workspaces', 'DELETE') AS delete,
             has_table_privilege('slugbase_app', 'public.workspaces', 'UPDATE') AS update`;
    expect(table).toEqual({ insert: false, delete: false, update: false });
  });

  it("may write the setting columns and who changed them, and nothing else, of workspace_settings", async () => {
    const rows = await db.owner<{ column: string }[]>`
      SELECT a.attname AS column
      FROM pg_attribute a
      WHERE a.attrelid = 'public.workspace_settings'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.workspace_settings', a.attname, 'UPDATE')
      ORDER BY a.attname`;
    expect(rows.map((row) => row.column)).toEqual(["ai_enabled", "updated_by"]);
    const [table] = await db.owner<{ insert: boolean; delete: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'public.workspace_settings', 'INSERT') AS insert,
             has_table_privilege('slugbase_app', 'public.workspace_settings', 'DELETE') AS delete`;
    expect(table).toEqual({ insert: false, delete: false });
  });

  it("has an update policy on workspace_settings that names the active workspace", async () => {
    const policies = await db.owner<{ name: string }[]>`SELECT polname AS name FROM pg_policy WHERE polrelid = 'public.workspace_settings'::regclass ORDER BY polname`;
    expect(policies.map((row) => row.name)).toEqual(["workspace_settings_tenant", "workspace_settings_tenant_update"]);
  });
});

describe("workspaceRepository.current", () => {
  it("reads the workspace of the transaction with the role of the account in it, its member count, its creation time and its version", async () => {
    const owner = await tenantWith("Research");
    const admin = await account();
    const member = await account();
    await seedMember(db, { workspaceId: owner.workspaceId, accountId: admin, role: "admin" });
    await seedMember(db, { workspaceId: owner.workspaceId, accountId: member, role: "member" });

    const asOwner = await inTenant(owner, (tx) => workspaceRepository(tx).current());
    const asAdmin = await inTenant({ accountId: admin, workspaceId: owner.workspaceId }, (tx) => workspaceRepository(tx).current());
    const asMember = await inTenant({ accountId: member, workspaceId: owner.workspaceId }, (tx) => workspaceRepository(tx).current());

    expect(asOwner).toEqual({ id: owner.workspaceId, name: "Research", createdAt: expect.any(Date) as Date, version: 1, role: "owner", memberCount: 3 });
    expect(asAdmin?.role).toBe("admin");
    expect(asMember?.role).toBe("member");
  });

  it("is undefined for an account that is not a member of the workspace and for a workspace being deleted", async () => {
    const mine = await tenantWith("Mine");
    const theirs = await tenantWith("Theirs");
    const going = await tenantWith("Going");
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${going.workspaceId}`);

    expect(await inTenant({ accountId: mine.accountId, workspaceId: theirs.workspaceId }, (tx) => workspaceRepository(tx).current())).toBeUndefined();
    expect(await inTenant(going, (tx) => workspaceRepository(tx).current())).toBeUndefined();
  });

  it("needs a transaction opened with a workspace", async () => {
    const person = await tenantWith("Any");

    await expect(inTenant({ accountId: person.accountId }, (tx) => workspaceRepository(tx).current())).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("workspaceRepository.rename", () => {
  it("replaces the name, moves the version by one and tells the name it replaced", async () => {
    const owner = await tenantWith("Before");

    const result = await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "After", expectedVersions: undefined }));

    expect(result).toEqual({ kind: "renamed", previousName: "Before", version: 2 });
    expect(await stored(owner.workspaceId)).toMatchObject({ name: "After", version: 2 });
    expect(await inTenant(owner, (tx) => workspaceRepository(tx).current())).toMatchObject({ name: "After", version: 2 });
  });

  it("refuses a version the workspace is no longer at and writes nothing, so an older read cannot overwrite a newer name", async () => {
    const owner = await tenantWith("First");
    expect(await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Second", expectedVersions: [1] }))).toMatchObject({ kind: "renamed", version: 2 });
    const before = await stored(owner.workspaceId);

    const stale = await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Overwrite", expectedVersions: [1] }));
    const none = await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Overwrite", expectedVersions: [] }));

    expect(stale).toEqual({ kind: "stale", version: 2 });
    expect(none).toEqual({ kind: "stale", version: 2 });
    expect(await stored(owner.workspaceId)).toEqual(before);
  });

  it("accepts any of the versions it is given", async () => {
    const owner = await tenantWith("Alpha");

    expect(await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Beta", expectedVersions: [7, 1] }))).toMatchObject({ kind: "renamed", version: 2 });
  });

  it("writes nothing for the name the workspace already has, whatever the precondition", async () => {
    const owner = await tenantWith("Same");
    const before = await stored(owner.workspaceId);

    const result = await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Same", expectedVersions: [1] }));

    expect(result).toEqual({ kind: "unchanged", version: 1 });
    expect(await stored(owner.workspaceId)).toEqual(before);
  });

  it("lets only one of two renames made against the same version succeed, the other being refused once the first has committed", async () => {
    const owner = await tenantWith("Start");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHasRenamed: () => void = () => undefined;
    const renamed = new Promise<void>((resolve) => {
      firstHasRenamed = resolve;
    });

    const first = inTenant(owner, async (tx) => {
      const result = await workspaceRepository(tx).rename({ name: "Winner", expectedVersions: [1] });
      firstHasRenamed();
      await gate;
      return result;
    });
    await renamed;
    const second = inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Loser", expectedVersions: [1] }));
    // The second transaction waits on the row the first one holds; it must not have answered before the first commits.
    const early = await Promise.race([second.then(() => "answered"), new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("waiting");
        }, 300);
      })]);
    release();

    expect(early).toBe("waiting");
    expect(await first).toMatchObject({ kind: "renamed", version: 2 });
    expect(await second).toEqual({ kind: "stale", version: 2 });
    expect(await stored(owner.workspaceId)).toMatchObject({ name: "Winner", version: 2 });
  });

  it("does not reach a workspace being deleted", async () => {
    const owner = await tenantWith("Going");
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${owner.workspaceId}`);

    expect(await inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "Renamed", expectedVersions: undefined }))).toEqual({ kind: "unavailable" });
    expect(await stored(owner.workspaceId)).toMatchObject({ name: "Going", version: 1 });
  });

  it("refuses a name outside 1 to 64 characters, whatever the layer above did", async () => {
    const owner = await tenantWith("Valid");

    expect(await refusedWith(inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "", expectedVersions: undefined })))).toBe("23514");
    expect(await refusedWith(inTenant(owner, (tx) => workspaceRepository(tx).rename({ name: "x".repeat(65), expectedVersions: undefined })))).toBe("23514");
    expect(await stored(owner.workspaceId)).toMatchObject({ name: "Valid", version: 1 });
  });

  it("needs a transaction opened with a workspace", async () => {
    const person = await tenantWith("Any");

    await expect(inTenant({ accountId: person.accountId }, (tx) => workspaceRepository(tx).rename({ name: "X", expectedVersions: undefined }))).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });
});

describe("workspaceRepository.settings and changeSettings", () => {
  it("reads the settings, which are on until they are turned off", async () => {
    const owner = await tenantWith("Settings");

    expect(await inTenant(owner, (tx) => workspaceRepository(tx).settings())).toEqual({ aiEnabled: true });
  });

  it("changes a setting, says what it was and what it is, and records who changed it", async () => {
    const owner = await tenantWith("Toggle");

    const off = await inTenant(owner, (tx) => workspaceRepository(tx).changeSettings({ aiEnabled: false }));
    const on = await inTenant(owner, (tx) => workspaceRepository(tx).changeSettings({ aiEnabled: true }));

    expect(off).toEqual({ previous: { aiEnabled: true }, current: { aiEnabled: false } });
    expect(on).toEqual({ previous: { aiEnabled: false }, current: { aiEnabled: true } });
    expect(await storedSettings(owner.workspaceId)).toMatchObject({ aiEnabled: true, updatedBy: owner.accountId });
  });

  it("writes nothing for a patch that changes no value", async () => {
    const owner = await tenantWith("Quiet");
    const before = await storedSettings(owner.workspaceId);

    const same = await inTenant(owner, (tx) => workspaceRepository(tx).changeSettings({ aiEnabled: true }));
    const empty = await inTenant(owner, (tx) => workspaceRepository(tx).changeSettings({}));

    expect(same).toEqual({ previous: { aiEnabled: true }, current: { aiEnabled: true } });
    expect(empty).toEqual({ previous: { aiEnabled: true }, current: { aiEnabled: true } });
    expect(await storedSettings(owner.workspaceId)).toEqual(before);
  });

  it("is undefined for a workspace without a settings row and does not create one", async () => {
    const accountId = await account();
    const workspaceId = await seedWorkspace(db, { name: "Bare", createdBy: accountId });
    await seedMember(db, { workspaceId, accountId, role: "owner" });

    expect(await inTenant({ accountId, workspaceId }, (tx) => workspaceRepository(tx).settings())).toBeUndefined();
    expect(await inTenant({ accountId, workspaceId }, (tx) => workspaceRepository(tx).changeSettings({ aiEnabled: false }))).toBeUndefined();
    expect(await storedSettings(workspaceId)).toBeUndefined();
  });

  it("reports the value a concurrent change left as the previous one", async () => {
    const owner = await tenantWith("Race");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHasChanged: () => void = () => undefined;
    const changed = new Promise<void>((resolve) => {
      firstHasChanged = resolve;
    });

    const first = inTenant(owner, async (tx) => {
      const result = await workspaceRepository(tx).changeSettings({ aiEnabled: false });
      firstHasChanged();
      await gate;
      return result;
    });
    await changed;
    const second = inTenant(owner, (tx) => workspaceRepository(tx).changeSettings({ aiEnabled: false }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();

    expect(await first).toEqual({ previous: { aiEnabled: true }, current: { aiEnabled: false } });
    expect(await second).toEqual({ previous: { aiEnabled: false }, current: { aiEnabled: false } });
  });

  it("needs a transaction opened with a workspace", async () => {
    const person = await tenantWith("Any");

    await expect(inTenant({ accountId: person.accountId }, (tx) => workspaceRepository(tx).settings())).rejects.toBeInstanceOf(TenantContextError);
    await expect(inTenant({ accountId: person.accountId }, (tx) => workspaceRepository(tx).changeSettings({ aiEnabled: false }))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("row-level security alone, with the application layer left out", () => {
  it("changes no row of workspace B from a transaction that acts in workspace A, by a rename, a lock or a setting", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    const before = await everythingOf(b.workspaceId);

    const renamed = await appAs(a, (tx) => tx`UPDATE workspaces SET name = 'Hijacked', version = version + 1 WHERE id = ${b.workspaceId} RETURNING id`);
    const locked = await appAs(a, (tx) => tx`SELECT id FROM workspaces WHERE id = ${b.workspaceId} FOR UPDATE`);
    const settings = await appAs(a, (tx) => tx`UPDATE workspace_settings SET ai_enabled = false, updated_by = ${a.accountId} WHERE workspace_id = ${b.workspaceId} RETURNING workspace_id`);
    const read = await appAs(a, (tx) => tx`SELECT workspace_id FROM workspace_settings WHERE workspace_id = ${b.workspaceId}`);

    expect(renamed).toHaveLength(0);
    expect(locked).toHaveLength(0);
    expect(settings).toHaveLength(0);
    expect(read).toHaveLength(0);
    expect(await everythingOf(b.workspaceId)).toBe(before);
  });

  it("refuses a settings row moved into another workspace and a workspace row moved to another identifier", async () => {
    const a = await tenantWith("Workspace A");
    const b = await tenantWith("Workspace B");
    const before = await everythingOf(b.workspaceId);

    expect(await refusedWith(appAs(a, (tx) => tx`UPDATE workspace_settings SET workspace_id = ${b.workspaceId} WHERE workspace_id = ${a.workspaceId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusedWith(appAs(a, (tx) => tx`UPDATE workspaces SET id = ${freshId()} WHERE id = ${a.workspaceId}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await everythingOf(b.workspaceId)).toBe(before);
  });

  it("refuses the columns the operations do not name, even in the active workspace", async () => {
    const a = await tenantWith("Workspace A");

    for (const statement of [
      (tx: postgres.TransactionSql) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${a.workspaceId}`,
      (tx: postgres.TransactionSql) => tx`UPDATE workspaces SET bookmark_count = 99 WHERE id = ${a.workspaceId}`,
      (tx: postgres.TransactionSql) => tx`UPDATE workspaces SET entitlement_version = 99 WHERE id = ${a.workspaceId}`,
      (tx: postgres.TransactionSql) => tx`UPDATE workspaces SET created_by = ${a.accountId} WHERE id = ${a.workspaceId}`,
      (tx: postgres.TransactionSql) => tx`UPDATE workspace_settings SET updated_at = now() WHERE workspace_id = ${a.workspaceId}`,
      (tx: postgres.TransactionSql) => tx`DELETE FROM workspaces WHERE id = ${a.workspaceId}`,
      (tx: postgres.TransactionSql) => tx`DELETE FROM workspace_settings WHERE workspace_id = ${a.workspaceId}`,
    ]) {
      expect(await refusedWith(appAs(a, statement))).toBe(ROW_LEVEL_SECURITY);
    }
    expect(await stored(a.workspaceId)).toMatchObject({ name: "Workspace A", version: 1, deletingAt: null });
  });

  it("changes the active workspace's own rows when the statement names them", async () => {
    const a = await tenantWith("Workspace A");

    const renamed = await appAs(a, (tx) => tx`UPDATE workspaces SET name = 'Renamed', version = version + 1 WHERE id = ${a.workspaceId} RETURNING id`);
    const settings = await appAs(a, (tx) => tx`UPDATE workspace_settings SET ai_enabled = false WHERE workspace_id = ${a.workspaceId} RETURNING workspace_id`);

    expect(renamed).toHaveLength(1);
    expect(settings).toHaveLength(1);
  });

  it("does not let a transaction with no active workspace change either table", async () => {
    const a = await tenantWith("Workspace A");
    const before = await everythingOf(a.workspaceId);

    const renamed = await appAs({ accountId: a.accountId }, (tx) => tx`UPDATE workspaces SET name = 'Elsewhere' WHERE id = ${a.workspaceId} RETURNING id`);
    const settings = await appAs({ accountId: a.accountId }, (tx) => tx`UPDATE workspace_settings SET ai_enabled = false WHERE workspace_id = ${a.workspaceId} RETURNING workspace_id`);

    expect(renamed).toHaveLength(0);
    expect(settings).toHaveLength(0);
    expect(await everythingOf(a.workspaceId)).toBe(before);
  });
});
