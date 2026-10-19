import { workspacePurgeOrder } from "../purge-registry.ts";
import { requireDatabase, type CheckRule, type Finding } from "./types.ts";

// Doc 05 section 7.2 and doc 10 T1: the workspace deletion job empties the tenant tables in the order of the
// registry in src/purge-registry.ts, so a table with a `workspace_id` column that the registry does not name
// would keep a deleted workspace's rows (until the final cascade, which only a foreign key to `workspaces`
// guarantees), and an entry that is no such table, or whose table `sys_workspace_purge_batch` has no statement
// for, would make the job fail on a workspace nobody can then delete. The function is asked about each entry
// with the nil workspace, which is never being deleted, so the call deletes nothing and fails only for a table
// the function does not know.

const ID = "purge-registry";
const NIL_WORKSPACE = "00000000-0000-0000-0000-000000000000";

interface TenantTable {
  name: string;
}

/** The rule over a given registry; `purgeRegistryRule` is the one over the shipped registry. */
export function createPurgeRegistryRule(registry: readonly string[]): CheckRule {
  return {
    id: ID,
    description: "every table with a workspace_id column is in the workspace purge registry, and every entry is such a table that sys_workspace_purge_batch deletes from",
    async run(context) {
      const sql = requireDatabase(context);
      const tables = await sql<TenantTable[]>`
        SELECT n.nspname || '.' || c.relname AS name
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
      const present = new Set(tables.map((table) => table.name));
      const listed = new Set(registry.map((entry) => `public.${entry}`));
      for (const table of present) {
        if (!listed.has(table)) {
          findings.push({
            rule: ID,
            object: `table ${table}`,
            message: "has a workspace_id column but is not in the workspace purge registry (packages/db/src/purge-registry.ts)",
          });
        }
      }
      for (const entry of registry) {
        const object = `purge registry entry ${entry}`;
        if (!present.has(`public.${entry}`)) {
          findings.push({ rule: ID, object, message: "names no table of the public schema with a workspace_id column" });
          continue;
        }
        try {
          await sql`SELECT public.sys_workspace_purge_batch(${NIL_WORKSPACE}::uuid, ${entry}::text, 1)`;
        } catch (error) {
          findings.push({
            rule: ID,
            object,
            message: `is not a table sys_workspace_purge_batch deletes from: ${error instanceof Error ? error.message : "unknown error"}`,
          });
        }
      }
      return findings;
    },
  };
}

export const purgeRegistryRule: CheckRule = createPurgeRegistryRule(workspacePurgeOrder);
