import { afterAll, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { expandContractRule } from "../../src/check/expand-contract.ts";
import { analyseSql, type Operation } from "../../src/check/migration-statements.ts";
import type { Finding } from "../../src/check/types.ts";
import { GitPackage, releasedRepository, SECOND } from "./git-package.ts";

// CREATE TRIGGER ... EXECUTE FUNCTION in the expand/contract rule (doc 05 sections 1 and 5.2): a
// trigger that runs a trigger function the migration chain declares is accepted in an unmarked
// migration, as the statement that declares the function is, and a call of a declared function in any
// other statement stays rejected.

const THIRD = "20260301000000_add_more";
const BOOKMARKS = [{ name: "bookmarks", columns: ["id", "title", "legacy_title"] }];
const NOT_ACCEPTED = "it is not accepted";
const DECLARE = "CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;";
const TRIGGER = "CREATE TRIGGER bookmarks_set_updated_at BEFORE UPDATE ON public.bookmarks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();";

const repositories: GitPackage[] = [];

afterAll(() => {
  for (const repository of repositories) {
    repository.remove();
  }
});

function inspect(repository: GitPackage): Promise<readonly Finding[]> {
  return Promise.resolve(expandContractRule.run({ packageDir: repository.dir, sql: undefined, hashSqlFiles }));
}

/** What the rule says about one migration added after the release. */
function added(sql: string): Promise<readonly Finding[]> {
  const repository = releasedRepository();
  repositories.push(repository);
  repository.migration(SECOND, sql, BOOKMARKS);
  return inspect(repository);
}

/** What the rule says about the second of two migrations added after the release. */
function addedAfter(first: string, second: string): Promise<readonly Finding[]> {
  const repository = releasedRepository();
  repositories.push(repository);
  repository.migration(SECOND, first, BOOKMARKS);
  repository.migration(THIRD, second);
  return inspect(repository).then((findings) => findings.filter(({ object }) => object === `migrations/${THIRD}.sql`));
}

function operationsOf(sql: string): Operation[] {
  return analyseSql(sql).flatMap((statement) => statement.operations);
}

describe("how the statement reader places CREATE TRIGGER", () => {
  it("reads a BEFORE UPDATE row trigger by its table and the function it executes", () => {
    expect(operationsOf(TRIGGER)).toEqual([
      { kind: "creates-trigger", table: { schema: "public", name: "bookmarks" }, fn: { name: { schema: "public", name: "set_updated_at" }, args: "" } },
    ]);
  });

  it("reads the same trigger written in lower case, quoted, unqualified and OR REPLACE", () => {
    expect(operationsOf('create or replace trigger "t" before update on "bookmarks" for each row execute function "set_updated_at"();')).toEqual([
      { kind: "creates-trigger", table: { schema: "public", name: "bookmarks" }, fn: { name: { schema: "public", name: "set_updated_at" }, args: "" } },
    ]);
  });

  it.each([
    ["an AFTER trigger", "CREATE TRIGGER t AFTER UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ["an INSTEAD OF trigger", "CREATE TRIGGER t INSTEAD OF UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ["a trigger on INSERT", "CREATE TRIGGER t BEFORE INSERT ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ["a trigger on INSERT OR UPDATE", "CREATE TRIGGER t BEFORE INSERT OR UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ["a trigger on DELETE", "CREATE TRIGGER t BEFORE DELETE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ["a trigger on TRUNCATE", "CREATE TRIGGER t BEFORE TRUNCATE ON bookmarks FOR EACH STATEMENT EXECUTE FUNCTION f();"],
    ["a trigger on UPDATE OF columns", "CREATE TRIGGER t BEFORE UPDATE OF title ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ["a statement trigger", "CREATE TRIGGER t BEFORE UPDATE ON bookmarks FOR EACH STATEMENT EXECUTE FUNCTION f();"],
    ["a trigger without FOR EACH", "CREATE TRIGGER t BEFORE UPDATE ON bookmarks EXECUTE FUNCTION f();"],
    ["a trigger with a WHEN condition", "CREATE TRIGGER t BEFORE UPDATE ON bookmarks FOR EACH ROW WHEN (old.title IS DISTINCT FROM new.title) EXECUTE FUNCTION f();"],
    ["a trigger with an argument", "CREATE TRIGGER t BEFORE UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f('x');"],
    ["a trigger that executes a procedure", "CREATE TRIGGER t BEFORE UPDATE ON bookmarks FOR EACH ROW EXECUTE PROCEDURE f();"],
    ["a constraint trigger", "CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON bookmarks DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();"],
    ["an event trigger", "CREATE EVENT TRIGGER t ON ddl_command_start EXECUTE FUNCTION f();"],
    ["a trigger without a function", "CREATE TRIGGER t BEFORE UPDATE ON bookmarks FOR EACH ROW;"],
  ])("does not read %s", (_name, sql) => {
    expect(operationsOf(sql).map(({ kind }) => kind)).not.toContain("creates-trigger");
    expect(operationsOf(sql).map(({ kind }) => kind)).toContain("unknown");
  });
});

describe("what the expand/contract rule says about CREATE TRIGGER", () => {
  it.each([
    ["in the migration that declares the trigger function", `${DECLARE}\n${TRIGGER}`],
    ["as OR REPLACE", `${DECLARE}\n${TRIGGER.replace("CREATE", "CREATE OR REPLACE")}`],
    ["on a table in another schema", `${DECLARE}\n${TRIGGER.replace("public.bookmarks", "archive.bookmarks")}`],
    ["in lower case with a quoted function name", `${DECLARE}\n${TRIGGER.toLowerCase().replace("public.set_updated_at", 'public."set_updated_at"')}`],
  ])("accepts a trigger %s", async (_name, sql) => {
    expect(await added(sql)).toEqual([]);
  });

  it("accepts a trigger in a later migration than the one that declares its function", async () => {
    expect(await addedAfter(DECLARE, TRIGGER)).toEqual([]);
  });

  it("accepts a trigger of a function the release declares", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration("20260101000000_add_function", DECLARE, BOOKMARKS);
    repository.commit("release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, TRIGGER);
    expect(await inspect(repository)).toEqual([]);
  });

  it.each([
    ["a function no migration declares", TRIGGER],
    ["a function declared in the same schema under another name", `${DECLARE}\n${TRIGGER.replace("set_updated_at()", "set_other()")}`],
    ["a function declared in another schema", `${DECLARE}\n${TRIGGER.replace("public.set_updated_at", "archive.set_updated_at")}`],
    ["a function declared after the trigger", `${TRIGGER}\n${DECLARE}`],
    ["a function that returns something other than trigger", `${DECLARE.replace("RETURNS trigger", "RETURNS integer")}\n${TRIGGER}`],
    ["a function with an argument", `${DECLARE.replace("set_updated_at()", "set_updated_at(a integer)")}\n${TRIGGER}`],
  ])("rejects a trigger that executes %s", async (_name, sql) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("trigger function");
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("rejects a trigger between GRANT CREATE ON SCHEMA and its REVOKE", async () => {
    const findings = await added(`GRANT CREATE ON SCHEMA public TO slugbase_system;\n${DECLARE}\n${TRIGGER}\nREVOKE CREATE ON SCHEMA public FROM slugbase_system;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("between GRANT CREATE ON SCHEMA public and its REVOKE");
  });

  it.each([
    ["a column default", "ALTER TABLE bookmarks ADD COLUMN x timestamptz DEFAULT public.set_updated_at();"],
    ["a policy condition", "CREATE POLICY p ON bookmarks USING (set_updated_at() IS NULL);"],
    ["an index expression", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks ((set_updated_at()));"],
    ["a select", "SELECT public.set_updated_at();"],
  ])("still rejects a call of the declared function in %s", async (_name, statement) => {
    const findings = await added(`${DECLARE}\n${TRIGGER}\n${statement}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
  });

  it("still rejects a call of a function that only a trigger of an earlier migration names", async () => {
    const findings = await addedAfter(`${DECLARE}\n${TRIGGER}`, "ALTER TABLE bookmarks ADD COLUMN x timestamptz DEFAULT set_updated_at();");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/mentions set_updated_at, |calls set_updated_at\(\)/);
  });
});
