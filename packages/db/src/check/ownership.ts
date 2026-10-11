import { requireDatabase, type CheckRule, type Finding } from "./types.ts";

// Doc 05 section 3.1: `slugbase_app` is what the server connects as. It owns
// no object, because an owner can change the object's policies and, without
// FORCE, reads around them. slugbase_owner owns the schema.

const APP_ROLE = "slugbase_app";

interface OwnedObject {
  kind: string;
  object: string;
}

const ID = "app-owns-nothing";

export const ownershipRule: CheckRule = {
  id: ID,
  description: `${APP_ROLE} owns no table, function, schema, sequence or type`,
  async run(context) {
    const sql = requireDatabase(context);
    const owned = await sql<OwnedObject[]>`
      SELECT CASE c.relkind
               WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
               WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table' WHEN 'i' THEN 'index' WHEN 'I' THEN 'index'
               WHEN 'c' THEN 'composite type' ELSE 'relation' END AS kind,
             n.nspname || '.' || c.relname AS object
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE pg_get_userbyid(c.relowner) = ${APP_ROLE} AND c.relkind <> 't'
      UNION ALL
      SELECT CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END,
             n.nspname || '.' || p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE pg_get_userbyid(p.proowner) = ${APP_ROLE}
      UNION ALL
      SELECT 'schema', nspname FROM pg_namespace WHERE pg_get_userbyid(nspowner) = ${APP_ROLE}
      UNION ALL
      SELECT 'type', n.nspname || '.' || t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE pg_get_userbyid(t.typowner) = ${APP_ROLE} AND t.typtype IN ('e', 'd', 'r', 'm')
      ORDER BY 1, 2`;
    return owned.map((entry): Finding => ({
      rule: ID,
      object: `${entry.kind} ${entry.object}`,
      message: `is owned by ${APP_ROLE}`,
    }));
  },
};
