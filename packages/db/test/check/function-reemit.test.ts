import { afterAll, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { expandContractRule } from "../../src/check/expand-contract.ts";
import { analyseSql, functionStatementOf, type FunctionStatement } from "../../src/check/migration-statements.ts";
import type { Finding } from "../../src/check/types.ts";
import { FIRST, GitPackage, releasedRepository, SECOND } from "./git-package.ts";

// A custom-SQL step re-emits all of src/sql/ (doc 05 section 5.1), so the DROP FUNCTION and the function
// REVOKE that a contract migration ran come back in every later migration that changes src/sql/. The rule
// accepts such a statement in an unmarked migration only when an earlier migration of the journal, with a
// valid contract header, ran the same statement in its custom step (doc 05 section 5.2).

const THIRD = "20260301000000_change_sql";
const FOURTH = "20260401000000_change_sql_again";
const BREAKPOINT = "\n--> statement-breakpoint\n";
const HASH = "a".repeat(64);
const HEADER = `-- slugbase:contract expand=${FIRST} release=1.0.0`;
const BOOKMARKS = [{ name: "bookmarks", columns: ["id", "title", "legacy_title"] }];
const DROP_OLD = "DROP FUNCTION IF EXISTS public.sys_old(uuid, text);";
const DROP_OTHER = "DROP FUNCTION IF EXISTS public.sys_other(uuid);";
const GRANT_NEW = "GRANT EXECUTE ON FUNCTION public.sys_new(uuid) TO slugbase_app;";
const REVOKE_NEW = "REVOKE EXECUTE ON FUNCTION public.sys_new(uuid) FROM slugbase_app;";
const CANNOT_PLACE = "cannot place";
const NOT_ACCEPTED = "it is not accepted";

const repositories: GitPackage[] = [];

afterAll(() => {
  for (const repository of repositories) {
    repository.remove();
  }
});

/** The statements a migration carries from src/sql/: the first file starts with the marker, then one file per body. */
function customStep(...files: string[]): string {
  return files
    .map((body, index) => `${index === 0 ? `-- slugbase:custom-sql sha256=${HASH}\n` : ""}-- src/sql/${String(index * 10 + 10).padStart(3, "0")}-file.sql\n${body}`)
    .join(BREAKPOINT);
}

/** A custom step whose migration carries the contract header, in its leading comment block as the generator writes it. */
function marked(...files: string[]): string {
  const [first = "", ...rest] = customStep(...files).split("\n");
  return [first, HEADER, ...rest].join("\n");
}

/** A repository whose release v1.0.0 holds FIRST. */
function released(): GitPackage {
  const repository = releasedRepository("v1.0.0");
  repositories.push(repository);
  return repository;
}

function inspect(repository: GitPackage): Promise<readonly Finding[]> {
  return Promise.resolve(expandContractRule.run({ packageDir: repository.dir, sql: undefined, hashSqlFiles }));
}

/** What the rule says about one migration of a chain. */
async function about(tag: string, repository: GitPackage): Promise<readonly Finding[]> {
  return (await inspect(repository)).filter(({ object }) => object === `migrations/${tag}.sql`);
}

/** The chain SECOND, THIRD after the release; the findings about THIRD. */
async function reEmitted(contract: string, reEmit: string): Promise<readonly Finding[]> {
  const repository = released();
  repository.migration(SECOND, contract, BOOKMARKS);
  repository.migration(THIRD, reEmit);
  return about(THIRD, repository);
}

describe("a DROP FUNCTION that an earlier marked contract migration ran", () => {
  it("passes in a later unmarked migration, and the same re-emit with one more DROP FUNCTION fails", async () => {
    expect(await reEmitted(marked(DROP_OLD), customStep(DROP_OLD))).toEqual([]);
    const findings = await reEmitted(marked(DROP_OLD), customStep(`${DROP_OLD}\n${DROP_OTHER}`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("is judged without a header: the later migration does not need one", async () => {
    expect(await reEmitted(marked(DROP_OLD), customStep(DROP_OLD))).toEqual([]);
  });

  it("is still reported in the migration that first drops it, unless that migration carries a header", async () => {
    const repository = released();
    repository.migration(SECOND, marked(DROP_OLD), BOOKMARKS);
    expect(await about(SECOND, repository)).toEqual([]);
    const bare = released();
    bare.migration(SECOND, customStep(DROP_OLD), BOOKMARKS);
    const findings = await about(SECOND, bare);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it("passes in a chain of several re-emits, one after the other", async () => {
    const repository = released();
    repository.migration(SECOND, marked(DROP_OLD), BOOKMARKS);
    repository.migration(THIRD, customStep(DROP_OLD));
    repository.migration(FOURTH, customStep(DROP_OLD));
    expect(await about(THIRD, repository)).toEqual([]);
    expect(await about(FOURTH, repository)).toEqual([]);
  });

  it("compares the statement as the privilege statements are compared, with the whitespace runs collapsed", async () => {
    expect(await reEmitted(marked(DROP_OLD), customStep("DROP   FUNCTION IF EXISTS\n  public.sys_old(uuid,\n  text);"))).toEqual([]);
  });

  it.each([
    ["other argument types", "DROP FUNCTION IF EXISTS public.sys_old(uuid, text, text);"],
    ["another schema", "DROP FUNCTION IF EXISTS archive.sys_old(uuid, text);"],
    ["another name", "DROP FUNCTION IF EXISTS public.sys_older(uuid, text);"],
    ["no IF EXISTS", "DROP FUNCTION public.sys_old(uuid, text);"],
    ["a different letter case", "drop function if exists public.sys_old(uuid, text);"],
    ["CASCADE", "DROP FUNCTION IF EXISTS public.sys_old(uuid, text) CASCADE;"],
    ["a second function in the list", "DROP FUNCTION IF EXISTS public.sys_old(uuid, text), public.sys_other(uuid);"],
  ])("rejects a drop with %s, which is not the statement the contract migration ran", async (_name, statement) => {
    const findings = await reEmitted(marked(DROP_OLD), customStep(statement));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("rejects a drop that a CASCADE contract migration ran: a CASCADE drop is never read as a drop", async () => {
    const cascade = "DROP FUNCTION IF EXISTS public.sys_old(uuid, text) CASCADE;";
    const findings = await reEmitted(marked(cascade), customStep(cascade));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the drop when the earlier migration has no contract header", async () => {
    const findings = await reEmitted(customStep(DROP_OLD), customStep(DROP_OLD));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the drop when the earlier migration's header is not valid", async () => {
    const bad = marked(DROP_OLD).replace("release=1.0.0", "release=9.9.9");
    const findings = await reEmitted(bad, customStep(DROP_OLD));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the drop when the earlier migration ran it outside its custom step", async () => {
    const outside = `${HEADER}\n${DROP_OLD}${BREAKPOINT}${customStep("SELECT 1;")}`;
    expect((await reEmitted(outside, customStep(DROP_OLD))).filter((found) => found.message.includes(CANNOT_PLACE))).toHaveLength(1);
  });

  it("rejects the drop when the later migration has it outside its custom step", async () => {
    const findings = await reEmitted(marked(DROP_OLD), `${DROP_OLD}${BREAKPOINT}${customStep("COMMENT ON TABLE bookmarks IS 'x';")}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the drop after the later migration creates the function again", async () => {
    const create = "CREATE FUNCTION public.sys_old(p_a uuid, p_b text) RETURNS int LANGUAGE sql AS 'SELECT 1';";
    const findings = await reEmitted(marked(DROP_OLD), customStep(create, DROP_OLD));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("keeps the drop when a function of the same name with another number of arguments is declared, as the nine-argument function is beside the dropped eight-argument one", async () => {
    const overload = "CREATE FUNCTION public.sys_old(p_a uuid, p_b text, p_c text) RETURNS int LANGUAGE sql AS 'SELECT 1';";
    expect(await reEmitted(marked(DROP_OLD), customStep(overload, DROP_OLD))).toEqual([]);
  });

  it("rejects the drop after a function of the same name and number of arguments is declared, however its types are spelled", async () => {
    const spelled = "CREATE FUNCTION public.sys_old(p_a uuid, p_b varchar) RETURNS int LANGUAGE sql AS 'SELECT 1';";
    const findings = await reEmitted(marked(DROP_OLD), customStep(spelled, DROP_OLD));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the drop after a migration the rule cannot read, which may have created the function again", async () => {
    const repository = released();
    repository.migration(SECOND, marked(DROP_OLD), BOOKMARKS);
    repository.migration(THIRD, "DO $$ BEGIN NULL; END $$;");
    repository.migration(FOURTH, customStep(DROP_OLD));
    const findings = await about(FOURTH, repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the drop after a statement of its own file that the rule cannot place", async () => {
    const findings = await reEmitted(marked(DROP_OLD), customStep("DO $$ BEGIN NULL; END $$;", DROP_OLD));
    expect(findings.filter((found) => found.message.includes("DO"))).toHaveLength(0);
    expect(findings.filter((found) => found.message.includes(CANNOT_PLACE)).length).toBeGreaterThanOrEqual(2);
  });

  it("does not let the drop hide a CASCADE-free second statement in the same file", async () => {
    const findings = await reEmitted(marked(DROP_OLD), customStep(`${DROP_OLD}\nALTER TABLE bookmarks DROP COLUMN legacy_title;`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("drops column bookmarks.legacy_title");
  });

  it("accepts the drop when the migration that ran it shipped in a release", async () => {
    const repository = released();
    repository.migration(SECOND, marked(DROP_OLD), BOOKMARKS);
    repository.commit("contract");
    repository.tag("v1.1.0");
    repository.migration(THIRD, customStep(DROP_OLD));
    expect(await about(THIRD, repository)).toEqual([]);
  });

  it("rejects the drop when the migration that ran it shipped without a header", async () => {
    const repository = released();
    repository.migration(SECOND, customStep(DROP_OLD), BOOKMARKS);
    repository.commit("unmarked");
    repository.tag("v1.1.0");
    repository.migration(THIRD, customStep(DROP_OLD));
    const findings = await about(THIRD, repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });
});

// A re-emitted drop is a statement the rule reads and finds to do nothing (the function is already gone), so it does not
// make the statements after it unreadable. Before this, DROP FUNCTION was a statement the rule could not place, and
// every trigger statement of every later migration was rejected because "an earlier statement could not be read".
describe("what a read DROP FUNCTION means for the statements after it", () => {
  const DECLARE = "CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;";
  const REPLACE = "CREATE OR REPLACE TRIGGER bookmarks_set_updated_at BEFORE UPDATE ON public.bookmarks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();";

  it("accepts a trigger replacement after a re-emitted drop, as a re-emit of src/sql/ carries it", async () => {
    expect(await reEmitted(marked(DROP_OLD), customStep(DROP_OLD, DECLARE, REPLACE))).toEqual([]);
  });

  it("accepts a trigger replacement in the migration that first drops the function, with its header", async () => {
    const repository = released();
    repository.migration(SECOND, marked(DROP_OLD, DECLARE, REPLACE), BOOKMARKS);
    expect(await about(SECOND, repository)).toEqual([]);
    expect(await about(THIRD, repository)).toEqual([]);
  });

  it("still rejects a trigger replacement after a statement the rule cannot place", async () => {
    const findings = await reEmitted(marked(DROP_OLD), customStep(DROP_OLD, "DO $$ BEGIN NULL; END $$;", DECLARE, REPLACE));
    expect(findings.some((found) => found.message.includes("replaces trigger bookmarks_set_updated_at"))).toBe(true);
  });

  it("still rejects a trigger replacement after a migration the rule cannot place", async () => {
    const repository = released();
    repository.migration(SECOND, marked(DROP_OLD), BOOKMARKS);
    repository.migration(THIRD, "DO $$ BEGIN NULL; END $$;");
    repository.migration(FOURTH, customStep(DROP_OLD, DECLARE, REPLACE));
    expect((await about(FOURTH, repository)).some((found) => found.message.includes("replaces trigger bookmarks_set_updated_at"))).toBe(true);
  });

  it("forgets a trigger function that the drop removes", async () => {
    const trigger = "CREATE TRIGGER bookmarks_touch BEFORE UPDATE ON public.bookmarks FOR EACH ROW EXECUTE FUNCTION public.touch();";
    const declare = "CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
    const findings = await reEmitted(marked(DROP_OLD), customStep(declare, "DROP FUNCTION IF EXISTS public.touch();", trigger));
    expect(findings.some((found) => found.message.includes("no earlier statement of the migration chain declares as a trigger function"))).toBe(true);
  });
});

// REVOKE ... ON FUNCTION is the other form a contract migration leaves in src/sql/ (the registered function stays but loses the
// access of a role). It counts as already run only when the migration leaves the function the grants and revokes the latest
// custom step left it.
describe("a REVOKE on a function that an earlier marked contract migration ran", () => {
  const SEQUENCE = `${GRANT_NEW}\n${REVOKE_NEW}`;

  it("passes in a later unmarked migration, and the same re-emit with one more function REVOKE fails", async () => {
    expect(await reEmitted(marked(SEQUENCE), customStep(SEQUENCE))).toEqual([]);
    const findings = await reEmitted(marked(SEQUENCE), customStep(`${SEQUENCE}\nREVOKE EXECUTE ON FUNCTION public.sys_other(uuid) FROM slugbase_app;`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("is judged without a header", async () => {
    expect(await reEmitted(marked(SEQUENCE), customStep(SEQUENCE))).toEqual([]);
  });

  it("rejects the REVOKE when the later migration grants the function back", async () => {
    const findings = await reEmitted(marked(SEQUENCE), customStep(`${SEQUENCE}\n${GRANT_NEW}`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the REVOKE when the later migration grants the function before it, differently from the contract migration", async () => {
    const findings = await reEmitted(marked(REVOKE_NEW), customStep(`${GRANT_NEW}\n${REVOKE_NEW}`));
    expect(findings).toHaveLength(1);
  });

  it("rejects the REVOKE when a wider GRANT on the functions of a schema is added", async () => {
    const findings = await reEmitted(marked(SEQUENCE), customStep(`${SEQUENCE}\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO slugbase_app;`));
    expect(findings).toHaveLength(1);
  });

  it("is not moved by a GRANT on a table or on another function", async () => {
    const other = "GRANT EXECUTE ON FUNCTION public.sys_other(uuid) TO slugbase_app;\nGRANT SELECT ON TABLE public.bookmarks TO slugbase_app;";
    expect(await reEmitted(marked(SEQUENCE), customStep(`${other}\n${SEQUENCE}`))).toEqual([]);
  });

  it.each([
    ["another role", "REVOKE EXECUTE ON FUNCTION public.sys_new(uuid) FROM slugbase_system;"],
    ["another privilege", "REVOKE ALL ON FUNCTION public.sys_new(uuid) FROM slugbase_app;"],
    ["another function", "REVOKE EXECUTE ON FUNCTION public.sys_new(uuid, text) FROM slugbase_app;"],
    ["CASCADE", "REVOKE EXECUTE ON FUNCTION public.sys_new(uuid) FROM slugbase_app CASCADE;"],
  ])("rejects a REVOKE with %s, which is not the statement the contract migration ran", async (_name, statement) => {
    const findings = await reEmitted(marked(SEQUENCE), customStep(`${GRANT_NEW}\n${statement}`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("rejects the REVOKE when the earlier migration has no contract header", async () => {
    const findings = await reEmitted(customStep(SEQUENCE), customStep(SEQUENCE));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the REVOKE when a migration between them left the function another set of grants", async () => {
    const repository = released();
    repository.migration(SECOND, marked(SEQUENCE), BOOKMARKS);
    repository.migration(THIRD, customStep(GRANT_NEW));
    repository.migration(FOURTH, customStep(SEQUENCE));
    expect(await about(THIRD, repository)).toEqual([]);
    const findings = await about(FOURTH, repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(CANNOT_PLACE);
  });

  it("rejects the REVOKE when the steps hold a GRANT the rule does not place, which may have changed who runs the function", async () => {
    const unread = "GRANT USAGE ON TYPE public.some_type TO slugbase_app;";
    const findings = await reEmitted(marked(`${SEQUENCE}\n${unread}`), customStep(`${SEQUENCE}\n${unread}`));
    expect(findings.filter((found) => found.message.includes("REVOKE on a function"))).toHaveLength(1);
  });

  it("accepts the REVOKE when the migration that ran it shipped in a release and no step came after it", async () => {
    const repository = released();
    repository.migration(SECOND, marked(SEQUENCE), BOOKMARKS);
    repository.commit("contract");
    repository.tag("v1.1.0");
    repository.migration(THIRD, customStep(SEQUENCE));
    expect(await about(THIRD, repository)).toEqual([]);
  });

  it("rejects the REVOKE after a migration the rule cannot read, which may have granted the function back", async () => {
    const repository = released();
    repository.migration(SECOND, marked(SEQUENCE), BOOKMARKS);
    repository.migration(THIRD, "DO $$ BEGIN NULL; END $$;");
    repository.migration(FOURTH, customStep(SEQUENCE));
    const findings = await about(FOURTH, repository);
    expect(findings).toHaveLength(1);
  });
});

describe("the reader of DROP FUNCTION and function REVOKE statements", () => {
  function statementOf(sql: string): FunctionStatement | undefined {
    const [statement] = analyseSql(sql);
    return statement === undefined ? undefined : functionStatementOf(statement);
  }

  it("places a DROP FUNCTION of one named function with an argument list, and a REVOKE on one", () => {
    expect(statementOf(DROP_OLD)).toEqual({ action: "drop", fn: { name: { schema: "public", name: "sys_old" }, args: "uuid, text" } });
    expect(statementOf("DROP FUNCTION public.sys_old(uuid, text) RESTRICT;")?.action).toBe("drop");
    expect(statementOf(REVOKE_NEW)).toEqual({ action: "revoke", fn: { name: { schema: "public", name: "sys_new" }, args: "uuid" } });
  });

  it.each([
    ["a CASCADE drop", "DROP FUNCTION IF EXISTS public.sys_old(uuid, text) CASCADE;"],
    ["a drop without an argument list", "DROP FUNCTION IF EXISTS public.sys_old;"],
    ["a drop of two functions", "DROP FUNCTION public.a(uuid), public.b(uuid);"],
    ["a drop of a procedure", "DROP PROCEDURE public.p(uuid);"],
    ["a drop of a routine", "DROP ROUTINE public.p(uuid);"],
    ["a drop with text after it", "DROP FUNCTION public.a(uuid) extra;"],
    ["a drop of a name outside printable ASCII", 'DROP FUNCTION public."café"(uuid);'],
    ["a drop of a name longer than 63 bytes", `DROP FUNCTION public.${"a".repeat(64)}(uuid);`],
    ["a CASCADE revoke", "REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM r CASCADE;"],
    ["a revoke of the grant option", "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.f(uuid) FROM r;"],
    ["a revoke without an argument list", "REVOKE EXECUTE ON FUNCTION public.f FROM r;"],
    ["a revoke of a name outside printable ASCII", 'REVOKE EXECUTE ON FUNCTION public."café"(uuid) FROM r;'],
    ["a revoke with text after it", "REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM r extra;"],
    ["a revoke on a table", "REVOKE ALL ON TABLE public.bookmarks FROM r;"],
    ["a GRANT on a function", GRANT_NEW],
  ])("does not place %s", (_name, sql) => {
    expect(statementOf(sql)).toBeUndefined();
  });

  it("reads both forms as statements the rule cannot place when nothing licenses them", () => {
    for (const sql of [DROP_OLD, REVOKE_NEW]) {
      expect(analyseSql(sql)[0]?.operations[0]?.kind).toBe("unknown");
    }
  });
});

// The shape of a contract migration that takes the application role's EXECUTE on a registered system function away: the function is
// created, handed to slugbase_system and revoked from PUBLIC in its own src/sql/ file, which no longer grants EXECUTE to slugbase_app, and a
// later file of the step holds the REVOKE EXECUTE ... FROM slugbase_app (beside an earlier contract migration's DROP FUNCTION).
describe("a step that revokes EXECUTE on a registered system function from slugbase_app", () => {
  const CREATE = "CREATE OR REPLACE FUNCTION public.sys_make(p_a uuid, p_b uuid, p_c text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN p_a; END $$;";
  const FUNCTION_FILE = [
    CREATE,
    "ALTER FUNCTION public.sys_make(uuid, uuid, text) OWNER TO slugbase_system;",
    "REVOKE ALL ON FUNCTION public.sys_make(uuid, uuid, text) FROM PUBLIC;",
  ].join("\n");
  const TABLE_FILE = "GRANT SELECT ON TABLE public.bookmarks TO slugbase_app;";
  const CONTRACT_FILE = "REVOKE EXECUTE ON FUNCTION public.sys_make(uuid, uuid, text) FROM slugbase_app;";
  const step = [TABLE_FILE, FUNCTION_FILE, DROP_OLD, CONTRACT_FILE];

  it("accepts the later unmarked re-emit of the whole step, and rejects it when the file grants EXECUTE to slugbase_app again", async () => {
    expect(await reEmitted(marked(...step), customStep(...step))).toEqual([]);
    const granted = [TABLE_FILE, `${FUNCTION_FILE}\nGRANT EXECUTE ON FUNCTION public.sys_make(uuid, uuid, text) TO slugbase_app;`, DROP_OLD, CONTRACT_FILE];
    const findings = await reEmitted(marked(...step), customStep(...granted));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("REVOKE on a function");
  });

  it("accepts a re-emit in which a comment of a file changed", async () => {
    const edited = step.map((file) => `-- a comment that changed\n${file}`);
    expect(await reEmitted(marked(...step), customStep(...edited))).toEqual([]);
  });

  it("holds the migration that first revokes EXECUTE to its header, and judges the drop beside it as before", async () => {
    const repository = released();
    repository.migration(SECOND, marked(TABLE_FILE, FUNCTION_FILE, DROP_OLD), BOOKMARKS);
    repository.migration(THIRD, marked(...step));
    expect(await about(THIRD, repository)).toEqual([]);
    const bare = released();
    bare.migration(SECOND, marked(TABLE_FILE, FUNCTION_FILE, DROP_OLD), BOOKMARKS);
    bare.migration(THIRD, customStep(...step));
    const findings = await about(THIRD, bare);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("has no contract header");
  });
});
