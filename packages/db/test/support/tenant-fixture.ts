import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { TestDatabase } from "../../src/testing.ts";

// A test-only tenant table, created by the owner in the scratch database and
// not part of the shipped chain: forced row-level security with the policy
// shape of doc 05 section 3.2, and the grants of slugbase_app. `probe_open` is
// the same table without row-level security, the control that shows the
// RLS-only checks can fail.

export const probe = pgTable("tenant_probe", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  label: text("label").notNull(),
});

export const probeOpen = pgTable("tenant_probe_open", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  label: text("label").notNull(),
});

export const ACCOUNT_A = "0192f3a0-0000-7000-8000-00000000000a";
export const ACCOUNT_B = "0192f3a0-0000-7000-8000-00000000000b";
export const WORKSPACE_A = "0192f3a0-1111-7000-8000-00000000000a";
export const WORKSPACE_B = "0192f3a0-1111-7000-8000-00000000000b";
export const ROW_A = "0192f3a0-2222-7000-8000-00000000000a";
export const ROW_B = "0192f3a0-2222-7000-8000-00000000000b";

export async function createProbeTables(database: TestDatabase): Promise<void> {
  const owner = database.owner;
  await owner.unsafe(`
    CREATE TABLE tenant_probe (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      label text NOT NULL
    );
    ALTER TABLE tenant_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_probe_tenant ON tenant_probe
      USING (workspace_id = public.app_workspace_id())
      WITH CHECK (workspace_id = public.app_workspace_id());
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_probe TO slugbase_app;

    CREATE TABLE tenant_probe_open (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      label text NOT NULL
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_probe_open TO slugbase_app;
  `);
}

export type ProbeRow = {
  id: string;
  workspace_id: string;
  label: string;
};

/**
 * Runs `statement` as the owner inside workspace `workspaceId`. Row-level
 * security is forced on the owner of tenant_probe as well, so a fixture reaches
 * a workspace's rows the way the application does: through the setting.
 */
export async function ownerIn<T extends Record<string, unknown>>(
  database: TestDatabase,
  workspaceId: string,
  statement: string,
  params: string[] = [],
): Promise<T[]> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.unsafe<T[]>(statement, params);
  });
  return rows as unknown as T[];
}

/** Every row of a probe table, read workspace by workspace as the owner, once each, ordered by label. */
export async function ownerRows(database: TestDatabase, table: string): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    rows.push(...(await ownerIn<ProbeRow>(database, workspaceId, `SELECT id, workspace_id, label FROM ${table}`)));
  }
  const once = new Map(rows.map((row) => [row.id, row]));
  return [...once.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** One row per workspace in each table. */
export async function seedProbeRows(database: TestDatabase): Promise<void> {
  for (const table of ["tenant_probe", "tenant_probe_open"]) {
    await ownerIn(database, WORKSPACE_A, `INSERT INTO ${table} (id, workspace_id, label) VALUES ($1, $2, 'a')`, [ROW_A, WORKSPACE_A]);
    await ownerIn(database, WORKSPACE_B, `INSERT INTO ${table} (id, workspace_id, label) VALUES ($1, $2, 'b')`, [ROW_B, WORKSPACE_B]);
  }
}
