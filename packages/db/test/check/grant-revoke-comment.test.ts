import { describe, expect, it } from "vitest";
import { analyseSql, type Operation } from "../../src/check/migration-statements.ts";

// GRANT and COMMENT are read by their whole shape and are safe; REVOKE takes
// privileges away from a role a running replica may use, so it is a contract step
// (doc 05 section 5.2, Q52). Whatever is not read to its end stays unknown.

function operationsOf(sql: string): Operation[] {
  return analyseSql(sql).flatMap((statement) => statement.operations);
}

function kindsOf(sql: string): string[] {
  return operationsOf(sql).map((operation) => operation.kind);
}

describe("GRANT", () => {
  it.each([
    ["a table without the TABLE keyword", "GRANT SELECT ON bookmarks TO slugbase_app;"],
    ["a table with the TABLE keyword", "GRANT SELECT ON TABLE bookmarks TO slugbase_app;"],
    ["a quoted, schema-qualified table", 'GRANT SELECT ON "public"."bookmarks" TO "slugbase_app";'],
    ["several tables", "GRANT SELECT ON TABLE a, public.b, c TO r;"],
    ["several privileges", "GRANT SELECT, INSERT, UPDATE, DELETE ON bookmarks TO r;"],
    ["every table privilege", "GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON bookmarks TO r;"],
    ["ALL", "GRANT ALL ON bookmarks TO r;"],
    ["ALL PRIVILEGES", "GRANT ALL PRIVILEGES ON bookmarks TO r;"],
    ["a column list", "GRANT SELECT (id, title), UPDATE (title) ON bookmarks TO r;"],
    ["several roles", "GRANT SELECT ON bookmarks TO a, b, c;"],
    ["PUBLIC", "GRANT SELECT ON bookmarks TO PUBLIC;"],
    ["CURRENT_USER", "GRANT SELECT ON bookmarks TO CURRENT_USER;"],
    ["WITH GRANT OPTION", "GRANT SELECT ON bookmarks TO r WITH GRANT OPTION;"],
    ["a sequence", "GRANT USAGE, SELECT ON SEQUENCE s TO r;"],
    ["a schema", "GRANT USAGE ON SCHEMA pgboss TO r;"],
    ["a database", "GRANT CONNECT, TEMPORARY ON DATABASE d TO r;"],
    ["all tables in a schema", "GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO r;"],
    ["all sequences in several schemas", "GRANT USAGE ON ALL SEQUENCES IN SCHEMA a, b TO r;"],
    ["all functions in a schema", "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA a TO r;"],
    ["lower case", "grant select on table bookmarks to r with grant option;"],
    ["a statement without a semicolon", "GRANT SELECT ON bookmarks TO r"],
    ["comments and line breaks", "GRANT -- why\n  SELECT /* x */ ON bookmarks\n  TO r;"],
  ])("reads %s as safe", (_name, sql) => {
    expect(kindsOf(sql)).toEqual(["safe"]);
  });

  it.each([
    ["no privilege", "GRANT ON bookmarks TO r;"],
    ["a dangling privilege comma", "GRANT SELECT, ON bookmarks TO r;"],
    ["an unknown privilege", "GRANT SUPERUSER ON bookmarks TO r;"],
    ["no ON", "GRANT SELECT TO r;"],
    ["no object", "GRANT SELECT ON TO r;"],
    ["no TO", "GRANT SELECT ON bookmarks;"],
    ["no grantee", "GRANT SELECT ON bookmarks TO;"],
    ["a dangling grantee comma", "GRANT SELECT ON bookmarks TO a,;"],
    ["a dangling table comma", "GRANT SELECT ON a, TO r;"],
    ["a role membership", "GRANT admins TO r;"],
    ["a function, which has an argument list", "GRANT EXECUTE ON FUNCTION f(int) TO r;"],
    ["a language", "GRANT USAGE ON LANGUAGE sql TO r;"],
    ["ALL TABLES without a schema", "GRANT SELECT ON ALL TABLES TO r;"],
    ["ALL TABLES IN SCHEMA without a name", "GRANT SELECT ON ALL TABLES IN SCHEMA TO r;"],
    ["a column list that is not closed", "GRANT SELECT (id ON bookmarks TO r;"],
    ["an empty column list", "GRANT SELECT () ON bookmarks TO r;"],
    ["a string as a grantee", "GRANT SELECT ON bookmarks TO 'r';"],
    ["a Unicode-escaped name", 'GRANT SELECT ON U&"b\\006Fokmarks" TO r;'],
    ["trailing text", "GRANT SELECT ON bookmarks TO r extra;"],
    ["GRANTED BY", "GRANT SELECT ON bookmarks TO r GRANTED BY o;"],
    ["trailing text after WITH GRANT OPTION", "GRANT SELECT ON bookmarks TO r WITH GRANT OPTION CASCADE;"],
    ["WITH ADMIN OPTION", "GRANT SELECT ON bookmarks TO r WITH ADMIN OPTION;"],
    ["WITH without GRANT OPTION", "GRANT SELECT ON bookmarks TO r WITH;"],
    ["a statement chained on the same line", "GRANT SELECT ON bookmarks TO r SELECT 1;"],
    ["a call in a name position", "GRANT SELECT ON f(x) TO r;"],
  ])("leaves %s unknown, so the rule fails closed", (_name, sql) => {
    const kinds = kindsOf(sql);
    expect(kinds[0]).toBe("unknown");
    expect(kinds).not.toContain("safe");
  });

  it("does not hide a statement that follows", () => {
    expect(kindsOf("GRANT SELECT ON bookmarks TO r; DROP TABLE bookmarks;")).toEqual(["safe", "drop-table"]);
  });
});

describe("COMMENT", () => {
  it.each([
    ["a table", "COMMENT ON TABLE bookmarks IS 'x';"],
    ["a schema-qualified table", "COMMENT ON TABLE public.bookmarks IS 'x';"],
    ["a quoted table", 'COMMENT ON TABLE "public"."bookmarks" IS \'x\';'],
    ["a column", "COMMENT ON COLUMN public.bookmarks.title IS 'x';"],
    ["a column without a schema", "COMMENT ON COLUMN bookmarks.title IS 'x';"],
    ["an index", "COMMENT ON INDEX bookmarks_title_idx IS 'x';"],
    ["a schema", "COMMENT ON SCHEMA pgboss IS 'x';"],
    ["a sequence", "COMMENT ON SEQUENCE s IS 'x';"],
    ["a view", "COMMENT ON VIEW v IS 'x';"],
    ["a materialized view", "COMMENT ON MATERIALIZED VIEW v IS 'x';"],
    ["a type", "COMMENT ON TYPE kind IS 'x';"],
    ["an extension", "COMMENT ON EXTENSION citext IS 'x';"],
    ["a policy", "COMMENT ON POLICY p ON bookmarks IS 'x';"],
    ["a constraint", "COMMENT ON CONSTRAINT c ON public.bookmarks IS 'x';"],
    ["NULL, which removes the comment", "COMMENT ON TABLE bookmarks IS NULL;"],
    ["lower case", "comment on table bookmarks is null;"],
    ["an escape string", "COMMENT ON TABLE bookmarks IS E'it\\'s';"],
    ["a dollar-quoted string", "COMMENT ON TABLE bookmarks IS $$ x $$;"],
    ["a string that holds a statement", "COMMENT ON TABLE bookmarks IS 'DROP TABLE bookmarks';"],
    ["a statement without a semicolon", "COMMENT ON TABLE bookmarks IS 'x'"],
    ["comments and line breaks", "COMMENT -- why\n  ON TABLE bookmarks /* x */\n  IS 'x';"],
  ])("reads %s as safe", (_name, sql) => {
    expect(kindsOf(sql)).toEqual(["safe"]);
  });

  it.each([
    ["no object type", "COMMENT ON bookmarks IS 'x';"],
    ["an object type it does not read", "COMMENT ON FUNCTION f(int) IS 'x';"],
    ["no name", "COMMENT ON TABLE IS 'x';"],
    ["a dangling name dot", "COMMENT ON TABLE a. IS 'x';"],
    ["a name of too many parts", "COMMENT ON TABLE a.b.c.d IS 'x';"],
    ["a policy without a table", "COMMENT ON POLICY p IS 'x';"],
    ["no IS", "COMMENT ON TABLE bookmarks 'x';"],
    ["no text", "COMMENT ON TABLE bookmarks IS;"],
    ["a name where the text goes", "COMMENT ON TABLE bookmarks IS other;"],
    ["a number as the text", "COMMENT ON TABLE bookmarks IS 1;"],
    ["a Unicode-escaped string", "COMMENT ON TABLE bookmarks IS U&'\\0027';"],
    ["a call as the text", "COMMENT ON TABLE bookmarks IS lower('X');"],
    ["a concatenation", "COMMENT ON TABLE bookmarks IS 'a' || 'b';"],
    ["two strings", "COMMENT ON TABLE bookmarks IS 'a' 'b';"],
    ["trailing text", "COMMENT ON TABLE bookmarks IS 'x' extra;"],
    ["a statement chained on the same line", "COMMENT ON TABLE bookmarks IS 'x' DROP TABLE bookmarks;"],
  ])("leaves %s unknown, so the rule fails closed", (_name, sql) => {
    const kinds = kindsOf(sql);
    expect(kinds[0]).toBe("unknown");
    expect(kinds).not.toContain("safe");
  });

  it("does not hide a statement that follows", () => {
    expect(kindsOf("COMMENT ON TABLE bookmarks IS 'x'; DROP TABLE bookmarks;")).toEqual(["safe", "drop-table"]);
  });
});

describe("REVOKE", () => {
  it.each([
    ["a table without the TABLE keyword", "REVOKE SELECT ON bookmarks FROM slugbase_app;", ["public.bookmarks"]],
    ["a table with the TABLE keyword", "REVOKE SELECT ON TABLE bookmarks FROM slugbase_app;", ["public.bookmarks"]],
    ["a quoted, schema-qualified table", 'REVOKE SELECT ON "archive"."bookmarks" FROM "slugbase_app";', ["archive.bookmarks"]],
    ["several tables", "REVOKE SELECT ON a, s.b FROM r;", ["public.a", "s.b"]],
    ["several privileges", "REVOKE SELECT, INSERT, UPDATE, DELETE ON bookmarks FROM r;", ["public.bookmarks"]],
    ["ALL PRIVILEGES", "REVOKE ALL PRIVILEGES ON bookmarks FROM r;", ["public.bookmarks"]],
    ["a column list", "REVOKE SELECT (title) ON bookmarks FROM r;", ["public.bookmarks"]],
    ["several roles", "REVOKE SELECT ON bookmarks FROM a, b;", ["public.bookmarks"]],
    ["PUBLIC", "REVOKE ALL ON bookmarks FROM PUBLIC;", ["public.bookmarks"]],
    ["GRANT OPTION FOR", "REVOKE GRANT OPTION FOR SELECT ON bookmarks FROM r;", ["public.bookmarks"]],
    ["CASCADE", "REVOKE SELECT ON bookmarks FROM r CASCADE;", ["public.bookmarks"]],
    ["RESTRICT", "REVOKE SELECT ON bookmarks FROM r RESTRICT;", ["public.bookmarks"]],
    ["lower case", "revoke select on table bookmarks from r cascade;", ["public.bookmarks"]],
    ["a statement without a semicolon", "REVOKE SELECT ON bookmarks FROM r", ["public.bookmarks"]],
    ["comments and line breaks", "REVOKE -- why\n  SELECT /* x */ ON bookmarks\n  FROM r;", ["public.bookmarks"]],
  ])("reads %s as a revocation on the tables it names", (_name, sql, tables) => {
    const operations = operationsOf(sql);
    expect(operations).toHaveLength(1);
    const [operation] = operations;
    expect(operation?.kind).toBe("revoke");
    expect(operation?.kind === "revoke" ? operation.tables?.map(({ schema, name }) => `${schema}.${name}`) : undefined).toEqual(tables);
  });

  it.each([
    ["a sequence", "REVOKE USAGE ON SEQUENCE s FROM r;"],
    ["a schema", "REVOKE USAGE ON SCHEMA pgboss FROM r;"],
    ["a database", "REVOKE CONNECT ON DATABASE d FROM r;"],
    ["all tables in a schema", "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM r;"],
    ["all sequences in a schema", "REVOKE USAGE ON ALL SEQUENCES IN SCHEMA public FROM r;"],
  ])("reads %s as a revocation on objects that are not named tables", (_name, sql) => {
    const operations = operationsOf(sql);
    expect(operations).toHaveLength(1);
    const [operation] = operations;
    expect(operation?.kind).toBe("revoke");
    expect(operation?.kind === "revoke" ? operation.tables : "not a revocation").toBeUndefined();
  });

  it.each([
    ["no privilege", "REVOKE ON bookmarks FROM r;"],
    ["a dangling privilege comma", "REVOKE SELECT, ON bookmarks FROM r;"],
    ["an unknown privilege", "REVOKE SUPERUSER ON bookmarks FROM r;"],
    ["GRANT OPTION FOR without a privilege", "REVOKE GRANT OPTION FOR ON bookmarks FROM r;"],
    ["no ON", "REVOKE SELECT FROM r;"],
    ["no object", "REVOKE SELECT ON FROM r;"],
    ["no FROM", "REVOKE SELECT ON bookmarks;"],
    ["TO in place of FROM", "REVOKE SELECT ON bookmarks TO r;"],
    ["no role", "REVOKE SELECT ON bookmarks FROM;"],
    ["a dangling role comma", "REVOKE SELECT ON bookmarks FROM a,;"],
    ["a role membership", "REVOKE admins FROM r;"],
    ["a function, which has an argument list", "REVOKE EXECUTE ON FUNCTION f(int) FROM r;"],
    ["ALL TABLES without a schema", "REVOKE SELECT ON ALL TABLES FROM r;"],
    ["a column list that is not closed", "REVOKE SELECT (id ON bookmarks FROM r;"],
    ["a string as a role", "REVOKE SELECT ON bookmarks FROM 'r';"],
    ["a Unicode-escaped name", 'REVOKE SELECT ON U&"b\\006Fokmarks" FROM r;'],
    ["trailing text", "REVOKE SELECT ON bookmarks FROM r extra;"],
    ["text after CASCADE", "REVOKE SELECT ON bookmarks FROM r CASCADE extra;"],
    ["GRANTED BY", "REVOKE SELECT ON bookmarks FROM r GRANTED BY o;"],
    ["CASCADE and RESTRICT together", "REVOKE SELECT ON bookmarks FROM r CASCADE RESTRICT;"],
    ["a statement chained on the same line", "REVOKE SELECT ON bookmarks FROM r SELECT 1;"],
  ])("leaves %s unknown, so the rule fails closed", (_name, sql) => {
    const kinds = kindsOf(sql);
    expect(kinds[0]).toBe("unknown");
    expect(kinds).not.toContain("safe");
    expect(kinds).not.toContain("revoke");
  });

  it("does not hide a statement that follows", () => {
    expect(kindsOf("REVOKE SELECT ON bookmarks FROM r; DROP TABLE bookmarks;")).toEqual(["revoke", "drop-table"]);
  });
});
