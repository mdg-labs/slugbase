import { requireDatabase, type CheckRule, type Finding } from "./types.ts";

// Doc 05 section 2 (the RLS column legend) and doc 10 T1: every table with a
// `workspace_id` column has row-level security enabled and forced and at least
// one policy. Without FORCE the table owner bypasses the policies, without
// ENABLE the policies do not apply, and without a policy RLS is default-deny,
// so the table is not isolated by the tenant policy doc 05 section 2 requires.

interface TenantTable {
  schema: string;
  name: string;
  enabled: boolean;
  forced: boolean;
  policies: number;
}

const ID = "rls-forced";

export const rlsRule: CheckRule = {
  id: ID,
  description: "every table with a workspace_id column has RLS enabled and forced and at least one policy",
  async run(context) {
    const sql = requireDatabase(context);
    const tables = await sql<TenantTable[]>`
      SELECT n.nspname AS schema,
             c.relname AS name,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema'
        AND n.nspname !~ '^pg_'
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY n.nspname, c.relname`;
    const findings: Finding[] = [];
    for (const table of tables) {
      const object = `table ${table.schema}.${table.name}`;
      if (!table.enabled) {
        findings.push({ rule: ID, object, message: "has a workspace_id column but ROW LEVEL SECURITY is not enabled" });
      }
      if (!table.forced) {
        findings.push({ rule: ID, object, message: "has a workspace_id column but FORCE ROW LEVEL SECURITY is not set" });
      }
      if (table.policies === 0) {
        findings.push({ rule: ID, object, message: "has a workspace_id column but no row-level security policy" });
      }
    }
    return findings;
  },
};
