import { internalSystemOperations, systemOperations } from "../system/registry.ts";
import { requireDatabase, type CheckRule, type Finding } from "./types.ts";

// Doc 05 section 3.3 and doc 10 T1: a function that runs with the privileges
// of its owner can read across tenants, so every SECURITY DEFINER function is
// named in the reviewed registry (src/system/registry.ts) and every registered
// function follows the rules of the section: owned by slugbase_system, a
// pinned search_path, no dynamic SQL, EXECUTE revoked from PUBLIC and granted
// to slugbase_app. An internal operation (src/system/registry.ts), one that only
// other system operations call, follows the same rules except the last: neither
// slugbase_app nor PUBLIC may execute it, so a limit or a guard its callers
// apply cannot be got round by calling it directly.
//
// The pinned search_path is exactly `pg_catalog, public, pg_temp`. PostgreSQL
// searches the session's temporary schema first, for table and type names,
// unless pg_temp is listed in search_path, and slugbase_app may create
// temporary tables; so an app session could shadow an unqualified table name
// inside the function. Listing pg_temp last puts it after the schemas that own
// the real objects (see the SECURITY DEFINER section of CREATE FUNCTION).
//
// The check for dynamic SQL is a lint over the source text of the body (the
// SQL-standard body of a `BEGIN ATOMIC` function, otherwise `prosrc`), not a
// proof. It flags the word EXECUTE in any case, also inside a comment or a
// string literal, which fails closed. It cannot see dynamic SQL that does not
// use the word: a call to a function that runs a query from a string
// (`query_to_xml`, `ts_stat`, `dblink`) or to another function that itself
// uses EXECUTE; the review of the registry entry covers those. Only `sql` and
// `plpgsql` bodies are inspected; a function in any other language is
// reported, because its body is not text this rule can read.
//
// Functions that belong to an extension are not ours to register and are not
// examined.

const SYSTEM_ROLE = "slugbase_system";
const APP_ROLE = "slugbase_app";
const SEARCH_PATH_VALUE = "pg_catalog, public, pg_temp";
const SEARCH_PATH = `search_path=${SEARCH_PATH_VALUE}`;
const INSPECTABLE_LANGUAGES = new Set(["sql", "plpgsql"]);
const DYNAMIC_SQL = /\bexecute\b/i;

interface FunctionRow {
  schema: string;
  name: string;
  arguments: string;
  definer: boolean;
  owner: string;
  language: string;
  config: string[] | null;
  body: string;
  publicExecute: boolean;
  appExecute: boolean;
}

const ID = "system-operations";

function qualified(entry: string): string {
  return entry.includes(".") ? entry : `public.${entry}`;
}

/**
 * The rule over a given registry and the internal operations among its entries;
 * `systemOperationsRule` is the one over the shipped registry.
 */
export function createSystemOperationsRule(registry: readonly string[], internal: readonly string[] = []): CheckRule {
  return {
    id: ID,
    description: `every SECURITY DEFINER function is registered, and every registered function is owned by ${SYSTEM_ROLE} with search_path ${SEARCH_PATH_VALUE}, no dynamic SQL, EXECUTE revoked from PUBLIC and EXECUTE granted to ${APP_ROLE}, except an internal operation, which ${APP_ROLE} cannot execute`,
    async run(context) {
      const sql = requireDatabase(context);
      const registered = new Set(registry.map(qualified));
      const internalEntries = new Set(internal.map(qualified));
      const functions = await sql<FunctionRow[]>`
        SELECT n.nspname AS schema,
               p.proname AS name,
               pg_get_function_identity_arguments(p.oid) AS arguments,
               p.prosecdef AS definer,
               pg_get_userbyid(p.proowner) AS owner,
               l.lanname AS language,
               p.proconfig AS config,
               coalesce(pg_get_function_sqlbody(p.oid), p.prosrc, '') AS body,
               EXISTS (
                 SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS "publicExecute",
               has_function_privilege(${APP_ROLE}, p.oid, 'EXECUTE') AS "appExecute"
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname <> 'information_schema'
          AND n.nspname !~ '^pg_'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY n.nspname, p.proname, p.oid`;

      const findings: Finding[] = [];
      const present = new Set<string>();
      for (const fn of functions) {
        const key = `${fn.schema}.${fn.name}`;
        const object = `function ${key}(${fn.arguments})`;
        const isRegistered = registered.has(key);
        if (isRegistered) {
          present.add(key);
        }
        if (fn.definer && !isRegistered) {
          findings.push({ rule: ID, object, message: "is SECURITY DEFINER but is not in the system operation registry (packages/db/src/system/registry.ts)" });
        }
        if (!isRegistered) {
          continue;
        }
        if (!fn.definer) {
          findings.push({ rule: ID, object, message: "is in the system operation registry but is not SECURITY DEFINER" });
        }
        if (fn.owner !== SYSTEM_ROLE) {
          findings.push({ rule: ID, object, message: `is owned by ${fn.owner}, not ${SYSTEM_ROLE}` });
        }
        const searchPaths = (fn.config ?? []).filter((setting) => setting.startsWith("search_path="));
        if (searchPaths.length !== 1 || searchPaths[0] !== SEARCH_PATH) {
          findings.push({ rule: ID, object, message: `does not pin SET search_path = ${SEARCH_PATH_VALUE}` });
        }
        if (!INSPECTABLE_LANGUAGES.has(fn.language)) {
          findings.push({ rule: ID, object, message: `is written in language ${fn.language}, whose body this rule cannot inspect for dynamic SQL (only sql and plpgsql)` });
        } else if (DYNAMIC_SQL.test(fn.body)) {
          findings.push({ rule: ID, object, message: "contains EXECUTE: a system operation takes no dynamic SQL" });
        }
        if (fn.publicExecute) {
          findings.push({ rule: ID, object, message: "has EXECUTE granted to PUBLIC" });
        }
        if (internalEntries.has(key)) {
          // PUBLIC already has its finding above; an app role that can execute through PUBLIC alone is not reported twice.
          if (fn.appExecute && !fn.publicExecute) {
            findings.push({ rule: ID, object, message: `is an internal system operation but ${APP_ROLE} can execute it` });
          }
        } else if (!fn.appExecute) {
          findings.push({ rule: ID, object, message: `does not grant EXECUTE to ${APP_ROLE}` });
        }
      }
      for (const entry of registered) {
        if (!present.has(entry)) {
          findings.push({ rule: ID, object: `function ${entry}`, message: "is in the system operation registry but no such function exists" });
        }
      }
      for (const entry of internalEntries) {
        if (!registered.has(entry)) {
          findings.push({ rule: ID, object: `function ${entry}`, message: "is marked internal but is not in the system operation registry" });
        }
      }
      return findings;
    },
  };
}

export const systemOperationsRule: CheckRule = createSystemOperationsRule(systemOperations, internalSystemOperations);
