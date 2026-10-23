import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { expandContractRule } from "../../src/check/expand-contract.ts";
import { analyseSql, identifierForm, mentionOfAny, type Operation } from "../../src/check/migration-statements.ts";
import type { Finding } from "../../src/check/types.ts";
import { GitPackage, releasedRepository, SECOND } from "./git-package.ts";

// The system-function forms of doc 05 section 3.3 in the expand/contract rule: what an unmarked
// migration may use to add a system operation, and what stays rejected without the contract
// header.

const THIRD = "20260301000000_add_more";
const BOOKMARKS = [{ name: "bookmarks", columns: ["id", "title", "legacy_title"] }];
const NOT_ACCEPTED = "it is not accepted";
const CREATE = "CREATE FUNCTION public.take(p_key text, p_cost double precision) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN INSERT INTO t VALUES (p_key) ON CONFLICT (key) DO NOTHING; RETURN true; END $$;";
const OWNER = "ALTER FUNCTION public.take(text, double precision) OWNER TO slugbase_system;";
const GRANT_CREATE = "GRANT CREATE ON SCHEMA public TO slugbase_system;";
const REVOKE_CREATE = "REVOKE CREATE ON SCHEMA public FROM slugbase_system;";
const REVOKE_PUBLIC = "REVOKE ALL ON FUNCTION public.take(text, double precision) FROM PUBLIC;";
const GRANT_EXECUTE = "GRANT EXECUTE ON FUNCTION public.take(text, double precision) TO slugbase_app;";
const SYSTEM_OPERATION = [GRANT_CREATE, CREATE, OWNER, REVOKE_CREATE, REVOKE_PUBLIC, GRANT_EXECUTE].join("\n");

const repositories: GitPackage[] = [];

afterAll(() => {
  for (const repository of repositories) {
    repository.remove();
  }
});

function released(): GitPackage {
  const repository = releasedRepository();
  repositories.push(repository);
  return repository;
}

function inspect(repository: GitPackage): Promise<readonly Finding[]> {
  return Promise.resolve(expandContractRule.run({ packageDir: repository.dir, sql: undefined, hashSqlFiles }));
}

/** What the rule says about one migration added after the release. */
function added(sql: string): Promise<readonly Finding[]> {
  const repository = released();
  repository.migration(SECOND, sql, BOOKMARKS);
  return inspect(repository);
}

/** What the rule says about the last of two migrations added after the release. */
function addedAfter(first: string, second: string): Promise<readonly Finding[]> {
  const repository = released();
  repository.migration(SECOND, first, BOOKMARKS);
  repository.migration(THIRD, second);
  return inspect(repository).then((findings) => findings.filter(({ object }) => object === `migrations/${THIRD}.sql`));
}

function operationsOf(sql: string): Operation[] {
  return analyseSql(sql).flatMap((statement) => statement.operations);
}

describe("what an unmarked migration may use to add a system operation", () => {
  it.each([
    ["a SECURITY DEFINER plpgsql function with a pinned search_path and INSERT ... ON CONFLICT", CREATE],
    ["a plpgsql function without SECURITY DEFINER", "CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$;"],
    ["a SQL function with a data-changing body", "CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ DELETE FROM bookmarks $$;"],
    ["a function in a language the check does not list", "CREATE FUNCTION public.f() RETURNS int LANGUAGE plperl AS $$ return 1; $$;"],
    ["a function with named, defaulted and OUT arguments", "CREATE FUNCTION f(IN a integer DEFAULT 1, OUT b text, c varchar(10) = 'x') RETURNS record LANGUAGE sql AS 'SELECT 1';"],
    ["a function that returns a table", "CREATE FUNCTION f(k text) RETURNS TABLE (language text, n int) LANGUAGE sql AS 'SELECT 1, 2';"],
    ["a new function, OR REPLACE", "CREATE OR REPLACE FUNCTION public.take(p_key text, p_cost double precision) RETURNS boolean LANGUAGE sql AS 'SELECT true';"],
    ["the owner handed to slugbase_system", `${CREATE}\n${OWNER}`],
    ["the owner handed to slugbase_system, by arguments written with names", `${CREATE}\nALTER FUNCTION public.take(p_key text, p_cost double precision) OWNER TO slugbase_system;`],
    ["PUBLIC revoked and slugbase_app granted EXECUTE on a new function", `${CREATE}\n${REVOKE_PUBLIC}\n${GRANT_EXECUTE}`],
    ["PUBLIC revoked with RESTRICT, in lower case", `${CREATE}\nrevoke all privileges on function public.take(text, double precision) from public restrict;`],
    ["EXECUTE granted to slugbase_app on a function of an earlier migration", "GRANT EXECUTE ON FUNCTION public.other(int) TO slugbase_app;"],
    ["CREATE on a schema granted to slugbase_system and revoked, with the function statements between", SYSTEM_OPERATION],
    ["the whole sequence in lower case with comments", SYSTEM_OPERATION.toLowerCase().replaceAll("\n", " -- next\n")],
    ["two functions created and handed over in one window", `${GRANT_CREATE}\n${CREATE}\n${OWNER}\nCREATE FUNCTION public.second() RETURNS int LANGUAGE sql AS 'SELECT 1';\nALTER FUNCTION public.second() OWNER TO slugbase_system;\n${REVOKE_CREATE}`],
  ])("accepts %s", async (_name, sql) => {
    expect(await added(sql)).toEqual([]);
  });

  it("accepts a function replaced with the signature and return type it had in the release", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration("20260101000000_add_take", "CREATE FUNCTION public.take(p_key text, p_cost double precision) RETURNS boolean LANGUAGE sql AS 'SELECT false';", BOOKMARKS);
    repository.commit("release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, `${GRANT_CREATE}\nCREATE OR REPLACE FUNCTION public.take(k text, c double precision) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN true; END $$;\n${OWNER}\n${REVOKE_CREATE}\n${REVOKE_PUBLIC}\n${GRANT_EXECUTE}`);
    expect(await inspect(repository)).toEqual([]);
  });

  it("accepts a function replaced with a different list of argument types as a new function", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration("20260101000000_add_take", "CREATE FUNCTION public.take(p_key text) RETURNS boolean LANGUAGE sql AS 'SELECT false';", BOOKMARKS);
    repository.commit("release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, "CREATE OR REPLACE FUNCTION public.take(p_key text, p_cost integer) RETURNS int LANGUAGE sql AS 'SELECT 1';");
    expect(await inspect(repository)).toEqual([]);
  });
});

describe("what stays rejected without the contract header", () => {
  const RELEASED_TAKE = "CREATE FUNCTION public.take(p_key text, p_cost double precision) RETURNS boolean LANGUAGE sql AS 'SELECT false';";

  function afterRelease(sql: string): Promise<readonly Finding[]> {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration("20260101000000_add_take", RELEASED_TAKE, BOOKMARKS);
    repository.commit("release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, sql);
    return inspect(repository);
  }

  it.each([
    ["a replacement that changes the return type", "CREATE OR REPLACE FUNCTION public.take(p_key text, p_cost double precision) RETURNS integer LANGUAGE sql AS 'SELECT 1';", "changes its return type from boolean to integer"],
    ["a replacement that drops the return type", "CREATE OR REPLACE FUNCTION public.take(p_key text, p_cost double precision, OUT ok boolean) LANGUAGE sql AS 'SELECT true';", "changes its return type"],
    ["dropping the function", "DROP FUNCTION public.take(text, double precision);", "cannot place"],
    ["dropping a function of the file", `${CREATE}\nDROP FUNCTION public.take(text, double precision);`, "cannot place"],
    ["dropping a function if it exists", "DROP FUNCTION IF EXISTS public.take;", "cannot place"],
  ])("rejects %s of a function of the release", async (_name, sql, expected) => {
    const findings = await afterRelease(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(expected);
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("accepts the replacement that changes the return type in the contract half of a pair, and rejects it without the header", async () => {
    const contractHalf = (header: string): GitPackage => {
      const repository = new GitPackage();
      repositories.push(repository);
      repository.migration("20260101000000_add_take", RELEASED_TAKE, BOOKMARKS);
      repository.commit("release");
      repository.tag("v1.0.0");
      repository.migration(SECOND, "ALTER TABLE bookmarks ADD COLUMN extra text;");
      repository.commit("expand");
      repository.tag("v1.1.0");
      repository.migration(
        THIRD,
        `${header}CREATE OR REPLACE FUNCTION public.take(p_key text, p_cost double precision) RETURNS integer LANGUAGE sql AS 'SELECT 1';`,
      );
      return repository;
    };
    expect(await inspect(contractHalf("-- slugbase:contract expand=20260201000000_add_notes release=1.1.0\n"))).toEqual([]);
    const findings = await inspect(contractHalf(""));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it("rejects a replacement of a function it cannot show is new, after a statement it cannot place", async () => {
    const findings = await addedAfter("DO $$ BEGIN NULL; END $$;", "CREATE OR REPLACE FUNCTION public.take(p_key text) RETURNS int LANGUAGE sql AS 'SELECT 1';");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("replaces function take(text), which this check cannot show is not a function of v1.0.0");
  });

  it("rejects a replacement of a function it cannot show is new, after a migration it cannot read", async () => {
    const findings = await addedAfter(
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;",
      "CREATE OR REPLACE FUNCTION public.take(p_key text) RETURNS int LANGUAGE sql AS 'SELECT 1';",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot show is not a function");
  });

  it("accepts the same replacement after statements it can read", async () => {
    expect(await addedAfter("CREATE TABLE notes (id uuid);", "CREATE OR REPLACE FUNCTION public.take(p_key text) RETURNS int LANGUAGE sql AS 'SELECT 1';")).toEqual([]);
  });

  it.each([
    ["any other role", "ALTER FUNCTION public.take(text, double precision) OWNER TO slugbase_app;"],
    ["the owner role", "ALTER FUNCTION public.take(text, double precision) OWNER TO slugbase_owner;"],
    ["CURRENT_USER", "ALTER FUNCTION public.take(text, double precision) OWNER TO CURRENT_USER;"],
    ["a role that only differs by case when quoted", 'ALTER FUNCTION public.take(text, double precision) OWNER TO "Slugbase_System";'],
    ["a role of another schema", "ALTER FUNCTION public.take(text, double precision) OWNER TO a.slugbase_system;"],
    ["PUBLIC", "ALTER FUNCTION public.take(text, double precision) OWNER TO public;"],
  ])("rejects ALTER FUNCTION ... OWNER TO %s", async (_name, owner) => {
    const findings = await added(`${CREATE}\n${owner}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
    expect(findings[0]?.message).toContain("ALTER FUNCTION other than OWNER TO slugbase_system");
  });

  it.each([
    ["a rename", `${CREATE}\nALTER FUNCTION public.take(text, double precision) RENAME TO other;`],
    ["a schema change", `${CREATE}\nALTER FUNCTION public.take(text, double precision) SET SCHEMA archive;`],
    ["a SECURITY change", `${CREATE}\nALTER FUNCTION public.take(text, double precision) SECURITY INVOKER;`],
    ["a name without an argument list", `${CREATE}\nALTER FUNCTION public.take OWNER TO slugbase_system;`],
    ["trailing text", `${CREATE}\n${OWNER.replace(";", " CASCADE;")}`],
  ])("rejects an ALTER FUNCTION that is %s", async (_name, sql) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
  });

  it("rejects the owner of a function the migration does not create being changed", async () => {
    const findings = await afterRelease(OWNER);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("changes the owner of function take(text, double precision), which this migration does not create");
  });

  it("rejects the owner of a function being changed by arguments that do not name the function the migration creates", async () => {
    const findings = await added(`${CREATE}\nALTER FUNCTION public.take(text) OWNER TO slugbase_system;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("which this migration does not create");
  });

  it.each([
    ["not revoked", `${GRANT_CREATE}\n${CREATE}\n${OWNER}`, "grants CREATE on schema public to slugbase_system and does not revoke it in the same file"],
    ["revoked from another schema", `${GRANT_CREATE}\n${CREATE}\n${OWNER}\nREVOKE CREATE ON SCHEMA other FROM slugbase_system;`, "grants CREATE on schema public"],
    ["revoked from another role", `${GRANT_CREATE}\n${CREATE}\n${OWNER}\nREVOKE CREATE ON SCHEMA public FROM slugbase_app;`, "grants CREATE on schema public"],
    ["revoked before it is granted", `${REVOKE_CREATE}\n${GRANT_CREATE}\n${CREATE}\n${OWNER}`, "without granting it in the same file"],
    ["revoked without a grant", REVOKE_CREATE, "revokes CREATE on schema public from slugbase_system without granting it in the same file"],
  ])("rejects a schema CREATE grant that is %s", async (_name, sql, expected) => {
    const findings = await added(sql);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map(({ message }) => message).join("\n")).toContain(expected);
    expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
  });

  it("rejects a schema CREATE grant revoked by another file", async () => {
    const repository = released();
    repository.migration(SECOND, `${GRANT_CREATE}\n${CREATE}\n${OWNER}`, BOOKMARKS);
    repository.migration(THIRD, REVOKE_CREATE);
    const findings = await inspect(repository);
    expect(findings.map(({ object }) => object)).toEqual([`migrations/${SECOND}.sql`, `migrations/${THIRD}.sql`]);
  });

  it.each([
    ["slugbase_app", "GRANT CREATE ON SCHEMA public TO slugbase_app;"],
    ["PUBLIC", "GRANT CREATE ON SCHEMA public TO PUBLIC;"],
    ["slugbase_system and another role", "GRANT CREATE ON SCHEMA public TO slugbase_system, slugbase_app;"],
    ["a role of another case, quoted", 'GRANT CREATE ON SCHEMA public TO "Slugbase_System";'],
    ["slugbase_system with the grant option", "GRANT CREATE ON SCHEMA public TO slugbase_system WITH GRANT OPTION;"],
    ["slugbase_system, with other privileges", "GRANT CREATE, USAGE ON SCHEMA public TO slugbase_system;"],
    ["slugbase_system, through ALL", "GRANT ALL ON SCHEMA public TO slugbase_system;"],
    ["slugbase_system, through ALL PRIVILEGES", "GRANT ALL PRIVILEGES ON SCHEMA public TO slugbase_system;"],
    ["slugbase_system, on two schemas", "GRANT CREATE ON SCHEMA public, other TO slugbase_system;"],
  ])("rejects a schema CREATE grant to %s", async (_name, grant) => {
    const findings = await added(`${grant}\n${CREATE}\n${REVOKE_CREATE}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toContain("cannot place");
    expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
  });

  it.each([
    ["a table", "CREATE TABLE notes (id uuid);"],
    ["a comment", "COMMENT ON TABLE bookmarks IS 'x';"],
    ["a grant", "GRANT SELECT ON bookmarks TO slugbase_app;"],
    ["a policy", "CREATE POLICY p ON bookmarks USING (true);"],
    ["the execute grant", GRANT_EXECUTE],
    ["the revocation from PUBLIC", REVOKE_PUBLIC],
    ["a second CREATE grant", GRANT_CREATE],
  ])("rejects %s between the CREATE grant and its revocation", async (_name, between) => {
    const findings = await added(`${GRANT_CREATE}\n${CREATE}\n${between}\n${OWNER}\n${REVOKE_CREATE}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("between GRANT CREATE ON SCHEMA public and its REVOKE");
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it.each([
    ["PUBLIC", "GRANT EXECUTE ON FUNCTION public.take(text, double precision) TO PUBLIC;"],
    ["PUBLIC and slugbase_app", "GRANT EXECUTE ON FUNCTION public.take(text, double precision) TO slugbase_app, PUBLIC;"],
    ["another role", "GRANT EXECUTE ON FUNCTION public.take(text, double precision) TO slugbase_owner;"],
    ["slugbase_app with the grant option", "GRANT EXECUTE ON FUNCTION public.take(text, double precision) TO slugbase_app WITH GRANT OPTION;"],
    ["slugbase_app, with ALL", "GRANT ALL ON FUNCTION public.take(text, double precision) TO slugbase_app;"],
  ])("rejects GRANT EXECUTE to %s", async (_name, grant) => {
    const findings = await added(`${CREATE}\n${grant}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
    expect(findings[0]?.message).toContain("GRANT on a function other than EXECUTE to slugbase_app");
  });

  it.each([
    ["slugbase_app", "REVOKE ALL ON FUNCTION public.take(text, double precision) FROM slugbase_app;"],
    ["PUBLIC and slugbase_app", "REVOKE ALL ON FUNCTION public.take(text, double precision) FROM PUBLIC, slugbase_app;"],
    ["PUBLIC, for EXECUTE only", "REVOKE EXECUTE ON FUNCTION public.take(text, double precision) FROM PUBLIC;"],
  ])("rejects a revocation of a function from %s", async (_name, revoke) => {
    const findings = await added(`${CREATE}\n${revoke}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
  });

  it("rejects the revocation from PUBLIC of a function the migration does not create", async () => {
    const findings = await afterRelease(REVOKE_PUBLIC);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on function take(text, double precision) from PUBLIC, and this migration does not create it");
  });

  it.each([
    ["a function named like a built-in the check lets a migration call", "CREATE FUNCTION public.lower(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN $1; END $$;"],
    ["a function named like a type the check lets a migration call", "CREATE FUNCTION public.numeric(text) RETURNS text LANGUAGE sql AS 'SELECT 1';"],
    ["a tenant context function in plpgsql", "CREATE OR REPLACE FUNCTION public.app_workspace_id() RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;"],
    ["a tenant context function whose body is not one SELECT", "CREATE OR REPLACE FUNCTION public.app_account_id() RETURNS uuid LANGUAGE sql AS $$ DELETE FROM bookmarks $$;"],
    ["a tenant context function of another schema", "CREATE FUNCTION archive.app_workspace_id() RETURNS uuid LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["a function with no language", "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$;"],
    ["a function with no string body", "CREATE FUNCTION f() RETURNS int LANGUAGE sql RETURN 1;"],
    ["a function without an argument list", "CREATE FUNCTION f RETURNS int LANGUAGE sql AS 'SELECT 1';"],
    ["a function with a variadic argument", "CREATE FUNCTION f(VARIADIC a text[]) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
    ["a function with a default that calls an unknown function", "CREATE FUNCTION f(a int DEFAULT g()) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
    ["a procedure", "CREATE PROCEDURE p() LANGUAGE sql AS 'SELECT 1';"],
  ])("rejects %s", async (_name, sql) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/cannot place|calls g\(\)/);
    expect(findings[0]?.message).toContain(NOT_ACCEPTED);
  });

  it("rejects a call of a function the migration creates, in the same file", async () => {
    const findings = await added(`${CREATE}\nCREATE POLICY p ON bookmarks USING (public.take(title, 1));\nALTER TABLE bookmarks ADD COLUMN x text DEFAULT public.take('a', 1);`);
    expect(findings.map(({ message }) => message.match(/(?:mentions|calls) (\w+)/)?.[1])).toEqual(["take", "take"]);
  });

  describe("a call of a function the migration creates, in a position the reader skips as grammar", () => {
    const DELETING = (name: string): string => `CREATE FUNCTION public.${name}(int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM bookmarks; RETURN 1; END $$;`;
    const DECLARED = "a function the migration chain declares";

    it.each([
      ["an ADD COLUMN DEFAULT", "hash", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT hash(1);"],
      ["a SET DEFAULT", "key", "ALTER TABLE bookmarks ALTER COLUMN title SET DEFAULT key(1);"],
      ["a CONCURRENTLY index expression", "btree", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks ((btree(1)));"],
      ["a policy condition", "hash", "CREATE POLICY p ON bookmarks USING (hash(1) = 1);"],
    ])("rejects the creation of a function named like the word that hides %s", async (_name, name, statement) => {
      const findings = await added(`${DELETING(name)}\n${statement}`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("like a word this check reads as grammar before a parenthesis");
      expect(findings[0]?.message).toContain(NOT_ACCEPTED);
    });

    it.each([
      ["a join condition after ON", "CREATE POLICY p ON bookmarks USING (EXISTS (SELECT 1 FROM bookmarks a JOIN bookmarks b ON f(1) = 1));"],
      ["a table after FROM ONLY", "CREATE POLICY p ON bookmarks USING (EXISTS (SELECT 1 FROM ONLY f(1)));"],
    ])("rejects, as a call of a declared function, the call in %s", async (_name, statement) => {
      const findings = await added(`${DELETING("f")}\n${statement}`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(`mentions f, ${DECLARED}`);
      expect(findings[0]?.message).toContain(NOT_ACCEPTED);
    });

    it.each([
      ["an ADD COLUMN DEFAULT", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT f(1);"],
      ["a SET DEFAULT", "ALTER TABLE bookmarks ALTER COLUMN title SET DEFAULT f(1);"],
      ["a CONCURRENTLY index expression", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks ((f(1)));"],
      ["a policy condition", "CREATE POLICY p ON bookmarks USING (f(1) = 1);"],
      ["a join condition after ON", "CREATE POLICY p ON bookmarks USING (EXISTS (SELECT 1 FROM bookmarks a JOIN bookmarks b ON f(1) = 1));"],
      ["a table after FROM ONLY", "CREATE POLICY p ON bookmarks USING (EXISTS (SELECT 1 FROM ONLY f(1)));"],
      ["a name in another letter case", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT F(1);"],
      ["a quoted name", 'ALTER TABLE bookmarks ADD COLUMN x int DEFAULT "f"(1);'],
      ["a schema-qualified quoted name", 'ALTER TABLE bookmarks ADD COLUMN x int DEFAULT "public"."f" (1);'],
      ["a name written with a comment before the parenthesis", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT f /* x */ (1);"],
    ])("rejects a call of the function in %s", async (_name, statement) => {
      const findings = await added(`${DELETING("f")}\n${statement}`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toMatch(/mentions f, |calls f\(\)/);
      expect(findings[0]?.message).toContain(NOT_ACCEPTED);
    });

    it("rejects the call in a later migration of a function an earlier one creates", async () => {
      const findings = await addedAfter(DELETING("f"), "CREATE POLICY p ON bookmarks USING (EXISTS (SELECT 1 FROM bookmarks a JOIN bookmarks b ON f(1) = 1));");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(`mentions f, ${DECLARED}`);
    });

    it("rejects the call of a function a released migration creates", async () => {
      const repository = new GitPackage();
      repositories.push(repository);
      repository.migration("20260101000000_add_f", DELETING("f"), BOOKMARKS);
      repository.commit("release");
      repository.tag("v1.0.0");
      repository.migration(SECOND, "CREATE POLICY p ON bookmarks USING (EXISTS (SELECT 1 FROM bookmarks a JOIN bookmarks b ON f(1) = 1));");
      const findings = await inspect(repository);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(`mentions f, ${DECLARED}`);
    });

    it("looks for a name wherever it stands, with or without a parenthesis after it", () => {
      const names = new Set(["hash", "key", "f"]);
      expect(mentionOfAny("ALTER TABLE t ADD COLUMN x int DEFAULT hash(1)", names)).toBe("hash");
      expect(mentionOfAny("ALTER TABLE t ALTER COLUMN x SET DEFAULT public.KEY (1)", names)).toBe("key");
      expect(mentionOfAny("SELECT 1 FROM ONLY f(1)", names)).toBe("f");
      expect(mentionOfAny("ALTER TABLE t ADD COLUMN x int DEFAULT (NULL::t).f", names)).toBe("f");
      expect(mentionOfAny('CREATE INDEX i ON t ((t."F"))', names)).toBe("F");
      expect(mentionOfAny("CREATE INDEX i ON t USING btree (x)", names)).toBeUndefined();
      expect(mentionOfAny("CREATE INDEX i ON t USING hash (x)", names)).toBe("hash");
    });

    describe("a call in field-selection notation, which has no parenthesis after the name", () => {
      it.each([
        ["an ADD COLUMN DEFAULT", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT (NULL::bookmarks).f;"],
        ["an ADD COLUMN DEFAULT of a schema-qualified row type", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT (NULL::public.bookmarks).f;"],
        ["a CONCURRENTLY index expression", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks ((bookmarks.f));"],
        ["an index predicate", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks (title) WHERE (bookmarks.f) = 1;"],
        ["a name in another letter case", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT (NULL::bookmarks).F;"],
        ["a quoted name", 'ALTER TABLE bookmarks ADD COLUMN x int DEFAULT (NULL::bookmarks)."f";'],
      ])("rejects the call in %s", async (_name, statement) => {
        const findings = await added(`CREATE FUNCTION public.f(bookmarks) RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM bookmarks; RETURN 1; END $$;\n${statement}`);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
      });

      it.each([
        ["an ADD COLUMN DEFAULT", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT (NULL::bookmarks).f;"],
        ["an ADD COLUMN DEFAULT of a schema-qualified row type", "ALTER TABLE bookmarks ADD COLUMN x int DEFAULT (NULL::public.bookmarks).f;"],
        ["a CONCURRENTLY index expression", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks ((bookmarks.f));"],
        ["an index predicate", "CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks (title) WHERE (bookmarks.f) = 1;"],
      ])("rejects the call in %s of a function with a built-in argument", async (_name, statement) => {
        const findings = await added(`${DELETING("f")}\n${statement}`);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(`mentions f, ${DECLARED}`);
        expect(findings[0]?.message).toContain(NOT_ACCEPTED);
      });

      it("rejects a column named like a function of the chain", async () => {
        const findings = await added(`${DELETING("f")}\nALTER TABLE bookmarks ADD COLUMN f int;`);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(`mentions f, ${DECLARED}`);
      });

      it.each([
        ["a table row type", "CREATE FUNCTION public.f(bookmarks) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a schema-qualified table row type", "CREATE FUNCTION public.f(IN b public.bookmarks) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a type with a default", "CREATE FUNCTION public.f(b bookmarks DEFAULT NULL) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a row type beside an OUT argument", "CREATE FUNCTION public.f(b bookmarks, OUT n int) LANGUAGE sql AS 'SELECT 1';"],
        ["record", "CREATE FUNCTION public.f(r record) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a row type and a defaulted second argument", "CREATE FUNCTION public.f(b bookmarks, n int DEFAULT 1) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a row type and a second argument with a default written as =", "CREATE FUNCTION public.f(b bookmarks, n int = 1, m text DEFAULT 'a') RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a row type, a defaulted argument and an OUT argument", "CREATE FUNCTION public.f(b bookmarks, n int DEFAULT 1, OUT o int) LANGUAGE sql AS 'SELECT 1';"],
      ])("refuses to read a function with one input argument of %s", async (_name, sql) => {
        const findings = await added(sql);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain("called with one argument of a type that is not a built-in scalar");
        expect(findings[0]?.message).toContain(NOT_ACCEPTED);
      });

      it.each([
        ["a lone VARIADIC argument of a row type", "CREATE FUNCTION public.f(VARIADIC b bookmarks[]) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a row type and a VARIADIC argument", "CREATE FUNCTION public.f(b bookmarks, VARIADIC n int[]) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
      ])("refuses to read a function with %s", async (_name, sql) => {
        const findings = await added(sql);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(NOT_ACCEPTED);
      });

      it.each([
        ["no argument", "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a built-in argument", "CREATE FUNCTION public.f(x numeric(10, 2)) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["an array argument", "CREATE FUNCTION public.f(x bookmarks[]) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["two arguments", "CREATE FUNCTION public.f(a bookmarks, b int) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a row type and a second argument without a default beside a defaulted one", "CREATE FUNCTION public.f(a bookmarks, b int DEFAULT 1, c int) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["a built-in first argument and a row type with a default", "CREATE FUNCTION public.f(a int, b bookmarks DEFAULT NULL) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
        ["one input argument and an OUT argument of a built-in type", "CREATE FUNCTION public.f(a int, OUT b bookmarks) LANGUAGE sql AS 'SELECT 1';"],
      ])("reads a function with %s", async (_name, sql) => {
        expect(await added(sql)).toEqual([]);
      });
    });

    describe("a name that PostgreSQL cuts to 63 bytes", () => {
      const LONG_B = "b".repeat(63);
      const LONG_A = "a".repeat(63);
      const DELETING_ROW = (name: string, extra: string): string => `CREATE FUNCTION public.${name}(b bookmarks${extra}) RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM bookmarks; RETURN 1; END $$;`;

      it.each([
        ["a 63-byte name with a defaulted second argument, called as a field of a longer spelling", `${DELETING_ROW(LONG_B, ", n int DEFAULT 1")}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (NULL::bookmarks).${LONG_B}zzz;`],
        ["a 64-byte name, called as a field of its 63-byte cut", `${DELETING_ROW(`${LONG_A}b`, ", n int DEFAULT 1")}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (NULL::bookmarks).${LONG_A};`],
        ["a 63-byte name, in an index predicate of a longer spelling", `${DELETING_ROW(LONG_B, ", n int DEFAULT 1")}\nCREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks (title) WHERE (bookmarks.${LONG_B}zzz) = 1;`],
      ])("rejects the call of %s", async (_name, sql) => {
        const findings = await added(sql);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
      });

      it("refuses to read a function named with more than 63 bytes", async () => {
        const findings = await added(`CREATE FUNCTION public.${LONG_A}b(int) RETURNS int LANGUAGE sql AS 'SELECT 1';`);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain("longer than PostgreSQL's 63-byte identifier limit");
      });

      it.each([
        ["a longer unquoted spelling as a field", `ALTER TABLE bookmarks ADD COLUMN y int DEFAULT (NULL::bookmarks).${LONG_B}zzz;`],
        ["a longer quoted spelling as a field", `ALTER TABLE bookmarks ADD COLUMN y int DEFAULT (NULL::bookmarks)."${LONG_B}zzz";`],
        ["a longer spelling in capitals as a field", `ALTER TABLE bookmarks ADD COLUMN y int DEFAULT (NULL::bookmarks).${LONG_B.toUpperCase()}ZZZ;`],
        ["a longer spelling in an index predicate", `CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks (title) WHERE (bookmarks.${LONG_B}zzz) = 1;`],
      ])("rejects a call of a function named with 63 bytes written as %s", async (_name, statement) => {
        const findings = await added(`CREATE FUNCTION public.${LONG_B}(int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM bookmarks; RETURN 1; END $$;\n${statement}`);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.message).toContain(`mentions ${LONG_B}`);
        expect(findings[0]?.message).toContain(NOT_ACCEPTED);
      });

      it("compares a name as PostgreSQL does", () => {
        const names = new Set([identifierForm("Take")]);
        expect(mentionOfAny("SELECT TAKE(1)", names)).toBe("take");
        expect(mentionOfAny('SELECT "Take"(1)', names)).toBe("Take");
        expect(mentionOfAny("SELECT takes(1)", names)).toBeUndefined();
        const long = new Set([identifierForm(LONG_B)]);
        expect(mentionOfAny(`SELECT ${LONG_B}zzz(1)`, long)).toBe(`${LONG_B}zzz`);
        expect(mentionOfAny(`SELECT ${"b".repeat(62)}(1)`, long)).toBeUndefined();
        const cut = new Set([identifierForm(`${LONG_A}b`)]);
        expect(mentionOfAny(`SELECT ${LONG_A}(1)`, cut)).toBe(LONG_A);
      });
    });

    describe("a name with a character outside printable ASCII", () => {
      // U+212A (Kelvin sign, 3 bytes) is `k` to JavaScript's case mapping and a different character to PostgreSQL,
      // which folds only A to Z; U+2126 (Ohm sign, 3 bytes) maps to U+03C9 (2 bytes).
      const KELVIN = "\u212a";
      const OHM = "\u2126";
      const BODY = "RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM bookmarks; RETURN 1; END $$;";
      const REFUSED = "a character outside printable ASCII";

      it.each([
        ["a Kelvin sign spelled as K", `CREATE FUNCTION public.${KELVIN.repeat(21)}zzz(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1).${KELVIN.repeat(21)};`],
        ["a quoted Kelvin sign", `CREATE FUNCTION public.${KELVIN.repeat(21)}zzz(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1)."${KELVIN.repeat(21)}";`],
        ["an unquoted Kelvin name called by its 63-byte cut", `CREATE FUNCTION public.${KELVIN.repeat(21)}(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1).${KELVIN.repeat(21)}zzz;`],
        ["a quoted Kelvin name called by its 63-byte cut", `CREATE FUNCTION public."${KELVIN.repeat(21)}"(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1).${KELVIN.repeat(21)}zzz;`],
        ["an unquoted Ohm name", `CREATE FUNCTION public.${OHM.repeat(21)}zzz(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1).${OHM.repeat(21)};`],
        ["a quoted Ohm name called by its 63-byte cut", `CREATE FUNCTION public."${OHM.repeat(21)}"(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1).${OHM.repeat(21)}zzz;`],
        ["a quoted accented name", `CREATE FUNCTION public."caf\u00e9"(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1)."caf\u00e9";`],
        ["a schema-qualified Kelvin name", `CREATE FUNCTION public.${KELVIN}(x int) ${BODY}`],
      ])("refuses to read a function named with %s", async (_name, sql) => {
        const findings = await added(sql);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every(({ message }) => message.includes(NOT_ACCEPTED))).toBe(true);
        expect(findings.some(({ message }) => message.includes(REFUSED))).toBe(true);
      });

      it("reads a function whose argument is named with a character outside printable ASCII", async () => {
        expect(await added(`CREATE FUNCTION public.f(\u00e9 int) ${BODY}`)).toEqual([]);
      });

      it("does not read a mention spelled with a look-alike as a mention of an ASCII name", async () => {
        const findings = await added(`CREATE FUNCTION public.k(x int) ${BODY}\nALTER TABLE bookmarks ADD COLUMN y int DEFAULT (1).${KELVIN};`);
        expect(findings.some(({ message }) => message.includes("mentions"))).toBe(false);
      });

      it("compares a mention on the text as written, folding only A to Z", () => {
        const names = new Set([identifierForm("k")]);
        expect(mentionOfAny(`SELECT ${KELVIN}(1)`, names)).toBeUndefined();
        expect(mentionOfAny(`SELECT "${KELVIN}"(1)`, names)).toBeUndefined();
        expect(mentionOfAny("SELECT K(1)", names)).toBe("k");
        expect(identifierForm(`${KELVIN}K`)).toBe(`${KELVIN}k`);
      });
    });

    it("accepts the statements that name the function without calling it, and a word that no function of the chain has", async () => {
      expect(await added(`${DELETING("f")}\nALTER FUNCTION public.f(int) OWNER TO slugbase_system;\nREVOKE ALL ON FUNCTION public.f(int) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public.f(int) TO slugbase_app;`)).toEqual([]);
      expect(await added("CREATE INDEX CONCURRENTLY bookmarks_x ON bookmarks USING hash (title);")).toEqual([]);
    });

    it.each([
      ["a word the reader skips as grammar", "CREATE FUNCTION public.hash(int) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
      ["a word that introduces a name", "CREATE FUNCTION public.only(int) RETURNS int LANGUAGE sql AS 'SELECT 1';"],
      ["a quoted, capitalised grammar word", 'CREATE FUNCTION public."Key"(int) RETURNS int LANGUAGE sql AS \'SELECT 1\';'],
    ])("refuses to read a function named like %s", async (_name, sql) => {
      const findings = await added(sql);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("like a word this check reads as grammar before a parenthesis");
    });

    it.each([
      ["an operator", "CREATE OPERATOR === (LEFTARG = int, RIGHTARG = int, FUNCTION = f);"],
      ["a cast", "CREATE CAST (text AS int) WITH FUNCTION f(text);"],
      ["a trigger", "CREATE TRIGGER t BEFORE INSERT ON bookmarks FOR EACH ROW EXECUTE FUNCTION f();"],
    ])("rejects %s that names the function", async (_name, statement) => {
      const findings = await added(`${DELETING("f")}\n${statement}`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(NOT_ACCEPTED);
    });
  });

  it("keeps the tenant context functions to one SELECT of built-ins, which the rule accepts", async () => {
    expect(
      await added("CREATE OR REPLACE FUNCTION public.app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;"),
    ).toEqual([]);
  });

  describe("app_member_workspace_ids, the tenant context function that reads the memberships", () => {
    const MEMBER_IDS = (body: string, language = "sql"): string =>
      `CREATE OR REPLACE FUNCTION public.app_member_workspace_ids() RETURNS SETOF uuid LANGUAGE ${language} STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ ${body} $$;`;
    const READ = "SELECT m.workspace_id FROM public.workspace_members m JOIN public.workspaces w ON w.id = m.workspace_id WHERE m.account_id = public.app_account_id() AND w.deleting_at IS NULL";

    it("is accepted as one SELECT over tables that calls the other tenant context functions, and a policy may name it", async () => {
      expect(await added(MEMBER_IDS(READ))).toEqual([]);
      expect(
        await added(`${MEMBER_IDS(READ)}\nCREATE POLICY workspaces_tenant ON workspaces FOR SELECT USING (id = public.app_workspace_id() OR id IN (SELECT public.app_member_workspace_ids()));`),
      ).toEqual([]);
    });

    it.each([
      ["in plpgsql", MEMBER_IDS("BEGIN RETURN QUERY SELECT 1; END", "plpgsql")],
      ["with a body that is not one SELECT", MEMBER_IDS("DELETE FROM public.workspace_members")],
      ["with a body of two statements", MEMBER_IDS(`${READ}; ${READ}`)],
      ["with a body that calls a function outside the safe list", MEMBER_IDS("SELECT pg_sleep(1)::text::uuid")],
    ])("is not accepted %s", async (_name, sql) => {
      const findings = await added(sql);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toMatch(/cannot place/);
    });

    it("is not accepted from another schema", async () => {
      const findings = await added(MEMBER_IDS(READ).replace("public.app_member_workspace_ids", "archive.app_member_workspace_ids"));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toMatch(/cannot place/);
    });
  });
});

describe("how the statement reader places the system-function forms", () => {
  it("names a function by its schema, its name and the types of its input arguments", () => {
    const [created] = operationsOf(
      "CREATE FUNCTION s.f(IN a integer, b double precision DEFAULT 1, OUT c text, d public.citext, e timestamp (3) with time zone, f numeric(10, 2), g text[], h interval day to second, \"I\" \"My Type\") RETURNS TABLE (x int) LANGUAGE sql AS 'SELECT 1';",
    );
    expect(created).toMatchObject({
      kind: "declares-function",
      fn: { name: { schema: "s", name: "f" }, args: 'integer, double precision, public . citext, timestamp ( 3 ) with time zone, numeric ( 10 , 2 ), text [ ], interval day to second, "My Type"' },
      returns: "table ( x int )",
      replace: false,
    });
  });

  it("reads the arguments of ALTER FUNCTION, GRANT and REVOKE as it does those of CREATE FUNCTION", () => {
    const kinds = operationsOf([OWNER, REVOKE_PUBLIC, GRANT_EXECUTE].join("\n")).map((operation) => (operation.kind === "safe" || !("fn" in operation) ? operation.kind : `${operation.kind} ${operation.fn.name.name}(${operation.fn.args})`));
    expect(kinds).toEqual(["alters-function-owner take(text, double precision)", "revokes-function-public take(text, double precision)", "grants-function-execute take(text, double precision)"]);
  });

  it("reads a schema CREATE grant and its revocation", () => {
    expect(operationsOf(`${GRANT_CREATE}\n${REVOKE_CREATE}`)).toEqual([
      { kind: "grants-schema-create", schema: "public" },
      { kind: "revokes-schema-create", schema: "public" },
    ]);
  });

  it("leaves the other revocations on a schema to the general reading", () => {
    expect(operationsOf("REVOKE CREATE ON SCHEMA public FROM slugbase_app;")).toEqual([{ kind: "revoke", tables: undefined }]);
    expect(operationsOf("REVOKE CREATE, USAGE ON SCHEMA public FROM slugbase_system;")).toEqual([{ kind: "revoke", tables: undefined }]);
  });
});

describe("the migration of the rate-limit operation (#58)", () => {
  // The migration that ships, read from the migrations folder as `migrate` applies it.
  const RATE_LIMIT_TAG = "20261012224854_add_rate_limit_buckets";
  const rateLimit = readFileSync(new URL(`../../migrations/${RATE_LIMIT_TAG}.sql`, import.meta.url), "utf8");
  const shipped = ["20261011134302_add_extensions_and_tenant_functions", "20261012103429_add_sql_definitions"] as const;

  // A mutation of the shipped SQL; one whose search text is not in the file fails here instead of testing nothing.
  function mutated(search: string, replacement: string): string {
    const sql = rateLimit.replace(search, replacement);
    expect(sql).not.toBe(rateLimit);
    return sql;
  }

  function chain(releaseAfter: number): GitPackage {
    const repository = new GitPackage();
    repositories.push(repository);
    for (const [index, tag] of shipped.entries()) {
      repository.migration(tag, readFileSync(new URL(`../../migrations/${tag}.sql`, import.meta.url), "utf8"), []);
      if (index === releaseAfter) {
        repository.commit("release");
        repository.tag("v1.0.0");
      }
    }
    return repository;
  }

  it("passes the rule as a migration added after the two released ones", async () => {
    const repository = chain(1);
    repository.migration(RATE_LIMIT_TAG, rateLimit, []);
    expect(await inspect(repository)).toEqual([]);
  });

  it("passes the rule when no migration is released yet", async () => {
    const repository = chain(-1);
    repository.migration(RATE_LIMIT_TAG, rateLimit, []);
    expect(await inspect(repository)).toEqual([]);
  });

  it("passes the rule when it is added with the migration that created the tenant functions already released only", async () => {
    const repository = chain(0);
    repository.migration(RATE_LIMIT_TAG, rateLimit, []);
    expect(await inspect(repository)).toEqual([]);
  });

  it("passes the rule when a later migration re-emits it with the function released", async () => {
    const repository = chain(1);
    repository.migration(RATE_LIMIT_TAG, rateLimit, []);
    repository.commit("rate limit");
    repository.tag("v1.1.0");
    repository.migration("20261101000000_add_more_sql", rateLimit, []);
    expect(await inspect(repository)).toEqual([]);
  });

  it("rejects a later re-emission that changes the return type of the released function", async () => {
    const repository = chain(1);
    repository.migration(RATE_LIMIT_TAG, rateLimit, []);
    repository.commit("rate limit");
    repository.tag("v1.1.0");
    repository.migration("20261101000000_change_take", mutated("RETURNS TABLE (allowed boolean, remaining double precision, retry_after_seconds double precision)", "RETURNS TABLE (allowed boolean, remaining double precision)"), []);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe("migrations/20261101000000_change_take.sql");
    expect(findings[0]?.message).toContain("replaces function sys_rate_limit_take(text, double precision, double precision, double precision) and changes its return type");
  });

  it("rejects the migration when the ownership is handed to another role", async () => {
    const repository = chain(1);
    repository.migration(RATE_LIMIT_TAG, mutated("OWNER TO slugbase_system;", "OWNER TO slugbase_app;"), []);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("ALTER FUNCTION other than OWNER TO slugbase_system");
  });

  it("rejects the migration when the schema CREATE grant is not revoked", async () => {
    const repository = chain(1);
    repository.migration(RATE_LIMIT_TAG, mutated("REVOKE CREATE ON SCHEMA public FROM slugbase_system;", ""), []);
    const findings = await inspect(repository);
    expect(findings.map(({ message }) => message)).toEqual([
      expect.stringContaining("between GRANT CREATE ON SCHEMA public and its REVOKE"),
      expect.stringContaining("between GRANT CREATE ON SCHEMA public and its REVOKE"),
      expect.stringContaining("grants CREATE on schema public to slugbase_system and does not revoke it in the same file"),
    ]);
  });
});
