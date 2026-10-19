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
const REPLACE = TRIGGER.replace("CREATE", "CREATE OR REPLACE");
const DEFERRED = "CREATE CONSTRAINT TRIGGER bookmarks_keep_one AFTER DELETE OR UPDATE ON public.bookmarks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();";
const PLAIN_KEEP = "CREATE TRIGGER bookmarks_keep_one BEFORE UPDATE ON public.bookmarks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();";
const DEFERRED_SET_UPDATED_AT = DEFERRED.replace("bookmarks_keep_one", "bookmarks_set_updated_at");
const DROP_PLAIN = "DROP TRIGGER IF EXISTS bookmarks_set_updated_at ON public.bookmarks;";
const DROP_DEFERRED = "DROP TRIGGER IF EXISTS bookmarks_keep_one ON public.bookmarks;";
const DECLARE_OTHER = DECLARE.replace("set_updated_at", "set_other");
const REPLACE_OTHER = REPLACE.replace("set_updated_at()", "set_other()");
const UNREADABLE = "DO $$ BEGIN NULL; END $$;";
const REPLACES = "replaces trigger";
const BOOKMARKS_TABLE = { schema: "public", name: "bookmarks" };
const SET_UPDATED_AT = { name: { schema: "public", name: "set_updated_at" }, args: "" };

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
      { kind: "creates-trigger", table: BOOKMARKS_TABLE, name: "bookmarks_set_updated_at", fn: SET_UPDATED_AT, form: "plain", replace: false },
    ]);
  });

  it("reads the same trigger written in lower case, quoted, unqualified and OR REPLACE", () => {
    expect(operationsOf('create or replace trigger "t" before update on "bookmarks" for each row execute function "set_updated_at"();')).toEqual([
      { kind: "creates-trigger", table: BOOKMARKS_TABLE, name: "t", fn: SET_UPDATED_AT, form: "plain", replace: true },
    ]);
  });

  it.each([
    ["an unquoted name is folded to lower case", "T", "t"],
    ["an unquoted name is read as the quoted lower case name", "t", "t"],
    ["a quoted name keeps its case", '"T"', "T"],
    ["a doubled quote is one quote", '"a""b"', 'a"b'],
    ["a name is cut to 63 bytes", "a".repeat(70), "a".repeat(63)],
  ])("reads the name of a trigger as PostgreSQL does: %s", (_name, written, name) => {
    const [operation] = operationsOf(`CREATE TRIGGER ${written} BEFORE UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();`);
    expect(operation).toMatchObject({ kind: "creates-trigger", name });
  });

  it.each([
    ["an unquoted schema and table", "S.T", { schema: "s", name: "t" }],
    ["a quoted schema and table", '"S"."T"', { schema: "S", name: "T" }],
    ["a table without a schema", "T", { schema: "public", name: "t" }],
    ["a table name cut to 63 bytes", "a".repeat(64), { schema: "public", name: "a".repeat(63) }],
    ["a schema and a table name cut to 63 bytes", `${"b".repeat(64)}.${"a".repeat(64)}`, { schema: "b".repeat(63), name: "a".repeat(63) }],
  ])("reads the table of a trigger as PostgreSQL does: %s", (_name, written, table) => {
    const [operation] = operationsOf(`CREATE TRIGGER t BEFORE UPDATE ON ${written} FOR EACH ROW EXECUTE FUNCTION f();`);
    expect(operation).toMatchObject({ kind: "creates-trigger", table });
  });

  it.each([
    ["a trigger name", 'CREATE OR REPLACE TRIGGER "t\u00e9" BEFORE UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();'],
    ["a table name", 'CREATE OR REPLACE TRIGGER t BEFORE UPDATE ON "bookmarks\u212a" FOR EACH ROW EXECUTE FUNCTION f();'],
    ["an unquoted table name", "CREATE OR REPLACE TRIGGER t BEFORE UPDATE ON bookmarks\u212a FOR EACH ROW EXECUTE FUNCTION f();"],
  ])("does not read an OR REPLACE with a character outside printable ASCII in %s", (_name, sql) => {
    expect(operationsOf(sql).map(({ kind }) => kind)).toEqual(["unknown"]);
  });

  it("reads a plain CREATE TRIGGER with a name outside printable ASCII", () => {
    expect(operationsOf('CREATE TRIGGER "t\u00e9" BEFORE UPDATE ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();').map(({ kind }) => kind)).toEqual(["creates-trigger"]);
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

describe("how the statement reader places CREATE CONSTRAINT TRIGGER", () => {
  it("reads an AFTER DELETE OR UPDATE deferred row trigger by its table and the function it executes", () => {
    expect(operationsOf(DEFERRED)).toEqual([{ kind: "creates-trigger", table: BOOKMARKS_TABLE, name: "bookmarks_keep_one", fn: SET_UPDATED_AT, form: "constraint", replace: false }]);
  });

  it("reads the same trigger written in lower case, quoted and unqualified", () => {
    expect(
      operationsOf('create constraint trigger "t" after delete or update on "bookmarks" deferrable initially deferred for each row execute function "set_updated_at"();'),
    ).toEqual([{ kind: "creates-trigger", table: BOOKMARKS_TABLE, name: "t", fn: SET_UPDATED_AT, form: "constraint", replace: false }]);
  });

  it("does not read CREATE OR REPLACE CONSTRAINT TRIGGER, which PostgreSQL does not have", () => {
    expect(operationsOf(DEFERRED.replace("CREATE", "CREATE OR REPLACE")).map(({ kind }) => kind)).toEqual(["unknown"]);
  });

  it("reads the name and the table of a constraint trigger as PostgreSQL does", () => {
    const [operation] = operationsOf(DEFERRED.replace("bookmarks_keep_one", "Keep_One").replace("public.bookmarks", "a".repeat(64)));
    expect(operation).toMatchObject({ kind: "creates-trigger", name: "keep_one", table: { schema: "public", name: "a".repeat(63) } });
  });

  it("reads a plain constraint trigger with a name outside printable ASCII", () => {
    expect(operationsOf(DEFERRED.replace("bookmarks_keep_one", '"t\u00e9"')).map(({ kind }) => kind)).toEqual(["creates-trigger"]);
  });

  it.each([
    ["an AFTER UPDATE trigger", DEFERRED.replace("DELETE OR ", "")],
    ["an AFTER DELETE trigger", DEFERRED.replace(" OR UPDATE", "")],
    ["an AFTER INSERT OR UPDATE trigger", DEFERRED.replace("DELETE", "INSERT")],
    ["a trigger on UPDATE OF columns", DEFERRED.replace("UPDATE ON", "UPDATE OF title ON")],
    ["a BEFORE trigger", DEFERRED.replace("AFTER", "BEFORE")],
    ["a trigger that is deferrable and initially immediate", DEFERRED.replace("INITIALLY DEFERRED", "INITIALLY IMMEDIATE")],
    ["a trigger that is not deferrable", DEFERRED.replace("DEFERRABLE INITIALLY DEFERRED ", "")],
    ["a trigger that is deferrable and states no initial mode", DEFERRED.replace("INITIALLY DEFERRED ", "")],
    ["a trigger that names a referenced table", DEFERRED.replace("DEFERRABLE", "FROM public.folders DEFERRABLE")],
    ["a statement trigger", DEFERRED.replace("FOR EACH ROW", "FOR EACH STATEMENT")],
    ["a trigger with a WHEN condition", DEFERRED.replace("FOR EACH ROW", "FOR EACH ROW WHEN (old.title IS DISTINCT FROM new.title)")],
    ["a trigger with an argument", DEFERRED.replace("set_updated_at()", "set_updated_at('x')")],
    ["a trigger that executes a procedure", DEFERRED.replace("FUNCTION", "PROCEDURE")],
    ["a constraint trigger without a function", "CREATE CONSTRAINT TRIGGER t AFTER DELETE OR UPDATE ON bookmarks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW;"],
  ])("does not read %s", (_name, sql) => {
    expect(operationsOf(sql).map(({ kind }) => kind)).not.toContain("creates-trigger");
    expect(operationsOf(sql).map(({ kind }) => kind)).toContain("unknown");
  });
});

describe("how the statement reader places DROP TRIGGER", () => {
  it("reads the trigger and the table it names as PostgreSQL does", () => {
    expect(operationsOf(DROP_DEFERRED)).toEqual([{ kind: "drops-trigger", table: BOOKMARKS_TABLE, name: "bookmarks_keep_one" }]);
    expect(operationsOf('drop trigger "T" on S."T"')).toEqual([{ kind: "drops-trigger", table: { schema: "s", name: "T" }, name: "T" }]);
    expect(operationsOf(`DROP TRIGGER ${"a".repeat(70)} ON ${"b".repeat(70)}`)).toEqual([
      { kind: "drops-trigger", table: { schema: "public", name: "b".repeat(63) }, name: "a".repeat(63) },
    ]);
  });

  it.each([
    ["a DROP TRIGGER with CASCADE", "DROP TRIGGER t ON bookmarks CASCADE;"],
    ["a DROP TRIGGER with RESTRICT", "DROP TRIGGER t ON bookmarks RESTRICT;"],
    ["a DROP TRIGGER without a table", "DROP TRIGGER t;"],
    ["a DROP TRIGGER of two triggers", "DROP TRIGGER t, u ON bookmarks;"],
    ["a DROP TRIGGER named with a character outside printable ASCII", 'DROP TRIGGER "t\u00e9" ON bookmarks;'],
    ["a DROP EVENT TRIGGER", "DROP EVENT TRIGGER t;"],
  ])("does not read %s", (_name, sql) => {
    expect(operationsOf(sql).map(({ kind }) => kind)).toEqual(["unknown"]);
  });
});

describe("what the expand/contract rule says about CREATE CONSTRAINT TRIGGER", () => {
  it.each([
    ["in the migration that declares the trigger function", `${DECLARE}\n${DEFERRED}`],
    ["after the drop that makes it replayable", `${DECLARE}\n${DROP_DEFERRED}\n${DEFERRED}`],
    ["twice, as the migrations of this repository replay it", `${DECLARE}\n${DROP_DEFERRED}\n${DEFERRED}\n${DROP_DEFERRED}\n${DEFERRED}`],
  ])("accepts a constraint trigger %s", async (_name, sql) => {
    expect(await added(sql)).toEqual([]);
  });

  it("accepts a constraint trigger in a later migration than the one that declares its function, and its replay in another", async () => {
    expect(await addedAfter(DECLARE, DEFERRED)).toEqual([]);
    expect(await addedAfter(`${DECLARE}\n${DEFERRED}`, `${DROP_DEFERRED}\n${DEFERRED}`)).toEqual([]);
  });

  it("accepts the replay of a constraint trigger of the release", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration("20260101000000_add_function", `${DECLARE}\n${DEFERRED}`, BOOKMARKS);
    repository.commit("release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, `${DROP_DEFERRED}\n${DEFERRED}`);
    expect(await inspect(repository)).toEqual([]);
  });

  it.each([
    ["a function no migration declares", DEFERRED],
    ["a function that returns something other than trigger", `${DECLARE.replace("RETURNS trigger", "RETURNS integer")}\n${DEFERRED}`],
    ["a function with an argument", `${DECLARE.replace("set_updated_at()", "set_updated_at(a integer)")}\n${DEFERRED}`],
  ])("rejects a constraint trigger that executes %s", async (_name, sql) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("trigger function");
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("rejects a drop that the file does not follow with the trigger again, for a trigger the chain created", async () => {
    const findings = await addedAfter(`${DECLARE}\n${DEFERRED}`, DROP_DEFERRED);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("drops trigger bookmarks_keep_one on bookmarks, which executes set_updated_at() now, and does not create it again in the same file");
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("rejects a drop that is followed by the trigger with another function", async () => {
    const findings = await addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${DEFERRED}`, `${DROP_DEFERRED}\n${DEFERRED.replace("set_updated_at()", "set_other()")}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("replaces trigger bookmarks_keep_one on bookmarks, which executes set_updated_at() now, with one that executes set_other()");
  });

  it("accepts the drop of a trigger the chain never created, as the no-op it is with IF EXISTS", async () => {
    expect(await added(DROP_DEFERRED)).toEqual([]);
  });

  it("rejects a drop after a statement this check cannot read, which may have changed the trigger", async () => {
    const findings = await addedAfter(`${DECLARE}\n${UNREADABLE}`, `${DROP_DEFERRED}\n${DEFERRED}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("drops trigger bookmarks_keep_one on bookmarks, which this check cannot show is not a trigger of");
  });

  it("still rejects a call of the function a constraint trigger names", async () => {
    const findings = await added(`${DECLARE}\n${DEFERRED}\nSELECT public.set_updated_at();`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
  });

  describe("when the trigger is made again in the other form", () => {
    const released = (shipped: string, sql: string): Promise<readonly Finding[]> => {
      const repository = new GitPackage();
      repositories.push(repository);
      repository.migration("20260101000000_add_function", shipped, BOOKMARKS);
      repository.commit("release");
      repository.tag("v1.0.0");
      repository.migration(SECOND, sql);
      return inspect(repository);
    };
    const AS_PLAIN = "which is a deferred constraint trigger AFTER DELETE OR UPDATE now, with a BEFORE UPDATE row trigger";
    const AS_CONSTRAINT = "which is a BEFORE UPDATE row trigger now, with a deferred constraint trigger AFTER DELETE OR UPDATE";

    it.each([
      ["in the migration that creates it", () => added(`${DECLARE}\n${DEFERRED}\n${DROP_DEFERRED}\n${PLAIN_KEEP}`)],
      ["in a later migration", () => addedAfter(`${DECLARE}\n${DEFERRED}`, `${DROP_DEFERRED}\n${PLAIN_KEEP}`)],
      ["in a migration after the release", () => released(`${DECLARE}\n${DEFERRED}`, `${DROP_DEFERRED}\n${PLAIN_KEEP}`)],
      ["by CREATE OR REPLACE TRIGGER, with no drop", () => released(`${DECLARE}\n${DEFERRED}`, PLAIN_KEEP.replace("CREATE", "CREATE OR REPLACE"))],
    ])("rejects a constraint trigger made a plain BEFORE UPDATE trigger %s", async (_name, run) => {
      const findings = await run();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(`replaces trigger bookmarks_keep_one on bookmarks, ${AS_PLAIN}`);
      expect(findings[0]?.message).toContain("the previous release still relies on the trigger");
      expect(findings[0]?.message).toContain(NOT_ACCEPTED);
    });

    it.each([
      ["in the migration that creates it", () => added(`${DECLARE}\n${TRIGGER}\n${DROP_PLAIN}\n${DEFERRED_SET_UPDATED_AT}`)],
      ["in a later migration", () => addedAfter(`${DECLARE}\n${TRIGGER}`, `${DROP_PLAIN}\n${DEFERRED_SET_UPDATED_AT}`)],
      ["in a migration after the release", () => released(`${DECLARE}\n${TRIGGER}`, `${DROP_PLAIN}\n${DEFERRED_SET_UPDATED_AT}`)],
    ])("rejects a plain BEFORE UPDATE trigger made a constraint trigger %s", async (_name, run) => {
      const findings = await run();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(`replaces trigger bookmarks_set_updated_at on bookmarks, ${AS_CONSTRAINT}`);
      expect(findings[0]?.message).toContain(NOT_ACCEPTED);
    });

    it("accepts the trigger made again in the form it has, whichever form that is", async () => {
      expect(await released(`${DECLARE}\n${DEFERRED}`, `${DROP_DEFERRED}\n${DEFERRED}`)).toEqual([]);
      expect(await released(`${DECLARE}\n${TRIGGER}`, `${DROP_PLAIN}\n${TRIGGER}`)).toEqual([]);
      expect(await released(`${DECLARE}\n${TRIGGER}`, REPLACE)).toEqual([]);
    });
  });
});

describe("what the expand/contract rule says about CREATE TRIGGER", () => {
  it.each([
    ["in the migration that declares the trigger function", `${DECLARE}\n${TRIGGER}`],
    ["as OR REPLACE", `${DECLARE}\n${REPLACE}`],
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

describe("what the expand/contract rule says about CREATE OR REPLACE TRIGGER", () => {
  const after = (shipped: string, sql: string): Promise<readonly Finding[]> => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration("20260101000000_add_function", shipped, BOOKMARKS);
    repository.commit("release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, sql);
    return inspect(repository);
  };

  it.each([
    ["in a later migration, as the migrations of this repository replay it", () => addedAfter(`${DECLARE}\n${TRIGGER}`, REPLACE)],
    ["twice in one migration", () => added(`${DECLARE}\n${REPLACE}\n${REPLACE}`)],
    ["over a trigger of the release that executes the same function", () => after(`${DECLARE}\n${TRIGGER}`, REPLACE)],
    ["under a quoted name that is the unquoted name", () => addedAfter(`${DECLARE}\n${TRIGGER}`, REPLACE.replace("bookmarks_set_updated_at", '"bookmarks_set_updated_at"'))],
    ["under an unquoted name in another letter case", () => addedAfter(`${DECLARE}\n${TRIGGER}`, REPLACE.replace("bookmarks_set_updated_at", "Bookmarks_Set_Updated_At"))],
    ["under a quoted name in another letter case, which is another trigger", () => addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER.replace("bookmarks_set_updated_at", '"Bookmarks_Set_Updated_At"'))],
    ["under the name of a trigger of another table", () => addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER.replace("public.bookmarks", "public.folders"))],
    ["after a CREATE DOMAIN, which creates no trigger", () => addedAfter("CREATE DOMAIN slug AS text;", `${DECLARE}\n${REPLACE}`)],
    ["after an ALTER TYPE, which creates no trigger", () => addedAfter("ALTER TYPE colour ADD VALUE 'red';", `${DECLARE}\n${REPLACE}`)],
  ])("accepts the trigger %s", async (_name, run) => {
    expect(await run()).toEqual([]);
  });

  it.each([
    ["in the same migration", () => added(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}\n${REPLACE_OTHER}`)],
    ["in a later migration", () => addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER)],
    ["of the release", () => after(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER)],
    ["whose name is another spelling of the same unquoted name", () => addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER.replace("bookmarks_set_updated_at", "BOOKMARKS_SET_UPDATED_AT"))],
    ["whose name is the quoted lower case name", () => addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER.replace("bookmarks_set_updated_at", '"bookmarks_set_updated_at"'))],
    ["whose table is spelled another way", () => addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${TRIGGER}`, REPLACE_OTHER.replace("public.bookmarks", "BOOKMARKS"))],
  ])("rejects a replacement that gives a trigger another function %s", async (_name, run) => {
    const findings = await run();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(REPLACES);
    expect(findings[0]?.message).toContain("replaces trigger bookmarks_set_updated_at on bookmarks, which executes set_updated_at() now, with one that executes set_other()");
    expect(findings[0]?.message).toContain("the previous release still relies on the trigger");
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it.each([
    ["a statement it cannot read", () => addedAfter(`${DECLARE}\n${UNREADABLE}`, REPLACE)],
    ["a trigger of another shape", () => addedAfter(`${DECLARE}\n${TRIGGER.replace("BEFORE UPDATE", "BEFORE INSERT")}`, REPLACE)],
    ["a rename of a table", () => addedAfter(`${DECLARE}\n${TRIGGER}\nALTER TABLE bookmarks RENAME TO links;`, REPLACE.replace("public.bookmarks", "links"))],
    ["a move of a table to another schema", () => addedAfter(`${DECLARE}\n${TRIGGER}\nALTER TABLE bookmarks SET SCHEMA archive;`, REPLACE.replace("public.bookmarks", "archive.bookmarks"))],
    ["a statement it cannot read in a migration of the release", () => after(`${DECLARE}\n${UNREADABLE}`, REPLACE)],
    ["a migration of the release it cannot read", () => after(`${DECLARE}\n${TRIGGER}\nSELECT 'unclosed;`, REPLACE)],
  ])("rejects a replacement of a trigger name after %s", async (_name, run) => {
    const findings = (await run()).filter(({ message }) => message.includes(REPLACES));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("this check cannot show is not a trigger of");
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  const LONG = "a".repeat(64);
  const CUT = "a".repeat(63);
  const onTable = (sql: string, table: string): string => sql.replace("public.bookmarks", table);

  it.each([
    ["a table of 64 bytes, then of 63", `public.${LONG}`, `public.${CUT}`],
    ["a table of 63 bytes, then of 64", `public.${CUT}`, `public.${LONG}`],
    ["a schema of 64 bytes, then of 63", `${LONG}.bookmarks`, `${CUT}.bookmarks`],
    ["a schema of 63 bytes, then of 64", `${CUT}.bookmarks`, `${LONG}.bookmarks`],
  ])("rejects a replacement that gives a trigger another function on the same table written longer or shorter: %s", async (_name, first, second) => {
    const findings = await addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${onTable(TRIGGER, first)}`, onTable(REPLACE_OTHER, second));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("replaces trigger bookmarks_set_updated_at on ");
    expect(findings[0]?.message).toContain("which executes set_updated_at() now, with one that executes set_other()");
  });

  it("accepts a replacement of a trigger of the same name on a table whose name differs within 63 bytes", async () => {
    expect(await addedAfter(`${DECLARE}\n${DECLARE_OTHER}\n${onTable(TRIGGER, `public.${CUT}`)}`, onTable(REPLACE_OTHER, `public.${CUT.slice(1)}b`))).toEqual([]);
  });

  it("rejects a replacement that is not of a trigger function, whether or not the name is known", async () => {
    const findings = await added(REPLACE);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("trigger function");
  });

  it("reports the trigger function and the replacement of a chain trigger apart", async () => {
    const findings = await addedAfter(`${DECLARE}\n${TRIGGER}`, REPLACE_OTHER);
    expect(findings).toHaveLength(2);
    expect(findings.map(({ message }) => message).join("\n")).toContain("trigger function");
    expect(findings.map(({ message }) => message).join("\n")).toContain(REPLACES);
  });
});
