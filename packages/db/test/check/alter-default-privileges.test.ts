import { describe, expect, it } from "vitest";
import { analyseSql } from "../../src/check/migration-statements.ts";

// ALTER DEFAULT PRIVILEGES ... GRANT changes only what is created later, so the
// expand/contract reader accepts it, but only by its full shape (doc 05 section 5.2).

function kindsOf(sql: string): string[] {
  return analyseSql(sql).flatMap((statement) => statement.operations.map((operation) => operation.kind));
}

describe("ALTER DEFAULT PRIVILEGES ... GRANT", () => {
  it.each([
    ["no role and no schema", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO slugbase_app;"],
    ["FOR ROLE", "ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner GRANT SELECT ON TABLES TO slugbase_app;"],
    ["FOR USER", "ALTER DEFAULT PRIVILEGES FOR USER slugbase_owner GRANT SELECT ON TABLES TO slugbase_app;"],
    ["IN SCHEMA", "ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT ON TABLES TO slugbase_app;"],
    ["FOR ROLE and IN SCHEMA", "ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner IN SCHEMA pgboss GRANT SELECT ON TABLES TO slugbase_app;"],
    ["IN SCHEMA before FOR ROLE", "ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss FOR ROLE slugbase_owner GRANT SELECT ON TABLES TO slugbase_app;"],
    ["several roles and schemas", "ALTER DEFAULT PRIVILEGES FOR ROLE a, b IN SCHEMA s1, s2 GRANT SELECT ON TABLES TO r1, r2;"],
    ["quoted names", 'ALTER DEFAULT PRIVILEGES FOR ROLE "Owner" IN SCHEMA "PgBoss" GRANT SELECT ON TABLES TO "App";'],
    ["lower case", "alter default privileges for role o in schema s grant select on tables to r;"],
    ["several privileges", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO r;"],
    ["ALL", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT ALL ON TABLES TO r;"],
    ["ALL PRIVILEGES", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT ALL PRIVILEGES ON TABLES TO r;"],
    ["SEQUENCES", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT USAGE, SELECT ON SEQUENCES TO r;"],
    ["FUNCTIONS", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT EXECUTE ON FUNCTIONS TO r;"],
    ["ROUTINES", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT EXECUTE ON ROUTINES TO r;"],
    ["TYPES", "ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO r;"],
    ["SCHEMAS", "ALTER DEFAULT PRIVILEGES GRANT USAGE, CREATE ON SCHEMAS TO r;"],
    ["PUBLIC", "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;"],
    ["WITH GRANT OPTION", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT SELECT ON TABLES TO r WITH GRANT OPTION;"],
    ["a trailing semicolon-free statement", "ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT SELECT ON TABLES TO r"],
    ["comments and line breaks", "ALTER DEFAULT PRIVILEGES -- why\n  FOR ROLE /* x */ o\n  GRANT SELECT\n  ON TABLES TO r;"],
  ])("reads %s as safe", (_name, sql) => {
    expect(kindsOf(sql)).toEqual(["safe"]);
  });

  it.each([
    ["no clause", "ALTER DEFAULT PRIVILEGES;"],
    ["only FOR ROLE", "ALTER DEFAULT PRIVILEGES FOR ROLE o;"],
    ["only IN SCHEMA", "ALTER DEFAULT PRIVILEGES IN SCHEMA s;"],
    ["a REVOKE clause", "ALTER DEFAULT PRIVILEGES IN SCHEMA s REVOKE SELECT ON TABLES FROM r;"],
    ["a REVOKE clause with FOR ROLE", "ALTER DEFAULT PRIVILEGES FOR ROLE o REVOKE ALL ON TABLES FROM r;"],
    ["a REVOKE after a GRANT", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r REVOKE SELECT ON TABLES FROM r;"],
    ["a GRANT without privileges", "ALTER DEFAULT PRIVILEGES GRANT ON TABLES TO r;"],
    ["a GRANT without ON", "ALTER DEFAULT PRIVILEGES GRANT SELECT TO r;"],
    ["a GRANT without an object kind", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TO r;"],
    ["a GRANT without TO", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES;"],
    ["a GRANT without a grantee", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO;"],
    ["a GRANT to a dangling comma", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r,;"],
    ["a GRANT with a dangling privilege comma", "ALTER DEFAULT PRIVILEGES GRANT SELECT, ON TABLES TO r;"],
    ["a GRANT of an unknown privilege", "ALTER DEFAULT PRIVILEGES GRANT SUPERUSER ON TABLES TO r;"],
    ["an object kind it does not read", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON LARGE OBJECTS TO r;"],
    ["a named object instead of a kind", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON bookmarks TO r;"],
    ["a column list", "ALTER DEFAULT PRIVILEGES GRANT SELECT (id) ON TABLES TO r;"],
    ["trailing text", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r extra;"],
    ["trailing text after WITH GRANT OPTION", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r WITH GRANT OPTION CASCADE;"],
    ["WITH without GRANT OPTION", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r WITH;"],
    ["WITH ADMIN OPTION", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r WITH ADMIN OPTION;"],
    ["a statement chained after the GRANT", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r SELECT 1;"],
    ["FOR ROLE without a name", "ALTER DEFAULT PRIVILEGES FOR ROLE GRANT SELECT ON TABLES TO r;"],
    ["FOR without ROLE or USER", "ALTER DEFAULT PRIVILEGES FOR o GRANT SELECT ON TABLES TO r;"],
    ["IN without SCHEMA", "ALTER DEFAULT PRIVILEGES IN s GRANT SELECT ON TABLES TO r;"],
    ["a dangling role comma", "ALTER DEFAULT PRIVILEGES FOR ROLE a, GRANT SELECT ON TABLES TO r;"],
    ["a schema-qualified schema name", "ALTER DEFAULT PRIVILEGES IN SCHEMA a.b GRANT SELECT ON TABLES TO r;"],
    ["FOR ROLE given twice", "ALTER DEFAULT PRIVILEGES FOR ROLE a FOR ROLE b GRANT SELECT ON TABLES TO r;"],
    ["IN SCHEMA given twice", "ALTER DEFAULT PRIVILEGES IN SCHEMA a IN SCHEMA b GRANT SELECT ON TABLES TO r;"],
    ["a call in a name position", "ALTER DEFAULT PRIVILEGES FOR ROLE f(x) GRANT SELECT ON TABLES TO r;"],
    ["a string as a grantee", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO 'r';"],
    ["a Unicode-escaped name", 'ALTER DEFAULT PRIVILEGES FOR ROLE U&"o\\0041" GRANT SELECT ON TABLES TO r;'],
    ["a statement in the role position that DROPs", "ALTER DEFAULT PRIVILEGES FOR ROLE o; DROP TABLE bookmarks;"],
  ])("leaves %s unknown, so the rule fails closed", (_name, sql) => {
    const kinds = kindsOf(sql);
    expect(kinds[0]).toBe("unknown");
    expect(kinds).not.toContain("safe");
  });

  it("does not hide a statement that follows", () => {
    expect(kindsOf("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r; DROP TABLE bookmarks;")).toEqual(["safe", "drop-table"]);
  });
});
