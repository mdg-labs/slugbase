import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { checkRules, contractMarkerFromEnv, runChecks } from "../../src/check/index.ts";
import { expandContractRule } from "../../src/check/expand-contract.ts";
import { analyseSql, setsSessionTimeout } from "../../src/check/migration-statements.ts";
import type { ContractMarker, Finding } from "../../src/check/types.ts";
import { FIRST, GitPackage, releasedRepository, SECOND } from "./git-package.ts";

// The expand/contract rule (doc 05 section 5.2, Q52) against temporary git
// repositories with release tags. `pnpm db:check` itself, with the marker
// taken from the environment, is driven in expand-contract.integration.test.ts.

const THIRD = "20260301000000_drop_legacy_title";
const BOOKMARKS = ["id", "title", "legacy_title"];
const REWRITES = "rewrites the table under an ACCESS EXCLUSIVE lock";
const MARKER_HINT = "contract marker is not set";

const repositories: GitPackage[] = [];
const scratch: string[] = [];

afterAll(() => {
  for (const repository of repositories) {
    repository.remove();
  }
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function released(tag = "v1.0.0"): GitPackage {
  const repository = releasedRepository(tag);
  repositories.push(repository);
  return repository;
}

/** `true` is the marker of a labelled pull request, `pending` that of a push. */
function inspect(repository: GitPackage, marker?: boolean | "pending"): Promise<readonly Finding[]> {
  const contractMarker: ContractMarker | undefined = marker === true ? "set" : marker === "pending" ? "pending" : marker === false ? "unset" : undefined;
  return Promise.resolve(
    expandContractRule.run({
      packageDir: repository.dir,
      sql: undefined,
      hashSqlFiles,
      ...(contractMarker === undefined ? {} : { contractMarker }),
    }),
  );
}

/** Adds one migration after the release and returns what the rule says about it. */
async function added(sql: string, options: { marker?: boolean | "pending"; tables?: { name: string; columns: string[] }[] } = {}): Promise<readonly Finding[]> {
  const repository = released();
  repository.migration(SECOND, sql, options.tables ?? [{ name: "bookmarks", columns: BOOKMARKS }]);
  return inspect(repository, options.marker);
}

describe("the failure scenario of a rolling deploy", () => {
  it("rejects dropping a column the previous release reads, naming the column, the migration and the release", async () => {
    const findings = await added('ALTER TABLE "bookmarks" DROP COLUMN "legacy_title";');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("expand-contract");
    expect(findings[0]?.object).toBe(`migrations/${SECOND}.sql`);
    expect(findings[0]?.message).toContain("drops column bookmarks.legacy_title, which exists at v1.0.0");
    expect(findings[0]?.message).toContain("the previous release still reads it");
  });

  it("is part of the rules that pnpm db:check runs", () => {
    expect(checkRules).toContain(expandContractRule);
  });
});

describe("what is rejected in a migration added since the latest release tag", () => {
  it.each([
    ["dropping a column", 'ALTER TABLE "bookmarks" DROP COLUMN "title";', "drops column bookmarks.title"],
    ["dropping a column without the COLUMN keyword", 'ALTER TABLE bookmarks DROP title;', "drops column bookmarks.title"],
    ["dropping a column in a multi-action ALTER", 'ALTER TABLE "bookmarks" ADD COLUMN "x" text, DROP COLUMN "title";', "drops column bookmarks.title"],
    ["dropping a column of a schema-qualified table", 'ALTER TABLE ONLY "public"."bookmarks" DROP COLUMN IF EXISTS "title" CASCADE;', "drops column bookmarks.title"],
    ["dropping a table", 'DROP TABLE "bookmarks" CASCADE;', "drops table bookmarks"],
    ["dropping a table in a list", 'DROP TABLE IF EXISTS "other", "bookmarks";', "drops table bookmarks"],
    ["dropping the schema of a table", "DROP SCHEMA public CASCADE;", "drops schema public"],
    ["renaming a column", 'ALTER TABLE "bookmarks" RENAME COLUMN "title" TO "name";', "renames column bookmarks.title to name"],
    ["renaming a table", 'ALTER TABLE "bookmarks" RENAME TO "links";', "renames table bookmarks to links"],
    ["moving a table to another schema", 'ALTER TABLE "bookmarks" SET SCHEMA archive;', "moves table bookmarks to archive.bookmarks"],
    ["adding a NOT NULL column without a default", 'ALTER TABLE "bookmarks" ADD COLUMN "slug" text NOT NULL;', "adds column bookmarks.slug as NOT NULL without a default"],
    ["adding a NOT NULL column with COMPRESSION default before NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "b" text COMPRESSION default NOT NULL;', "adds column bookmarks.b as NOT NULL without a default"],
    ["adding a NOT NULL column with COMPRESSION default after NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "b" text NOT NULL COMPRESSION default;', "adds column bookmarks.b as NOT NULL without a default"],
    ["adding a NOT NULL column with STORAGE default before NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "b" text STORAGE default NOT NULL;', "adds column bookmarks.b as NOT NULL without a default"],
    ["adding a NOT NULL column with STORAGE default after NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "b" text NOT NULL STORAGE default;', "adds column bookmarks.b as NOT NULL without a default"],
    ["adding a NOT NULL column in lower case without COLUMN", 'alter table bookmarks add slug varchar(10) not null;', "adds column bookmarks.slug as NOT NULL without a default"],
    ["adding a NOT NULL serial column", 'ALTER TABLE "bookmarks" ADD COLUMN "n" bigserial NOT NULL;', REWRITES],
    ["adding a serial column", 'ALTER TABLE "bookmarks" ADD COLUMN "n" serial;', REWRITES],
    ["adding a smallserial column in lower case without COLUMN", 'alter table bookmarks add n smallserial;', REWRITES],
    ["adding a serial8 column IF NOT EXISTS", 'ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS n SERIAL8;', REWRITES],
    ["adding a quoted serial type", 'ALTER TABLE "bookmarks" ADD COLUMN "n" "serial";', REWRITES],
    ["adding a NOT NULL column of a quoted bigserial type", 'ALTER TABLE "bookmarks" ADD COLUMN "n" "bigserial" NOT NULL;', REWRITES],
    ["adding a serial4 column", 'ALTER TABLE bookmarks ADD n serial4 NOT NULL;', REWRITES],
    ["adding a serial2 column", 'ALTER TABLE bookmarks ADD n serial2;', REWRITES],
    ["adding an identity column", 'ALTER TABLE "bookmarks" ADD COLUMN "n" integer GENERATED ALWAYS AS IDENTITY;', REWRITES],
    ["adding an identity column BY DEFAULT in lower case", 'alter table bookmarks add n bigint generated by default as identity;', REWRITES],
    ["adding an identity column with sequence options", 'ALTER TABLE "bookmarks" ADD COLUMN "n" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (START WITH 10 INCREMENT BY 2);', REWRITES],
    ["adding a stored generated column", 'ALTER TABLE "bookmarks" ADD COLUMN "t" tsvector GENERATED ALWAYS AS (to_tsvector(\'simple\', title)) STORED;', REWRITES],
    ["adding a stored generated column in lower case without COLUMN", 'alter table bookmarks add t text generated always as (lower(title)) stored;', REWRITES],
    ["adding a generated column that does not say STORED", 'ALTER TABLE "bookmarks" ADD COLUMN "t" text GENERATED ALWAYS AS (lower(title));', REWRITES],
    ["adding a stored generated column with a nested expression", 'ALTER TABLE "bookmarks" ADD COLUMN "t" text GENERATED ALWAYS AS (lower((title))) STORED NOT NULL;', REWRITES],
    ["changing a column type", 'ALTER TABLE "bookmarks" ALTER COLUMN "title" SET DATA TYPE integer USING title::integer;', "changes the type of column bookmarks.title"],
    ["changing a column type without SET DATA", 'ALTER TABLE "bookmarks" ALTER "title" TYPE varchar(10);', "changes the type of column bookmarks.title"],
    ["setting a column NOT NULL", 'ALTER TABLE "bookmarks" ALTER COLUMN "title" SET NOT NULL;', "sets column bookmarks.title NOT NULL"],
    ["setting a column NOT NULL in lower case without COLUMN", 'alter table bookmarks alter title set not null;', "sets column bookmarks.title NOT NULL"],
    ["setting a column NOT NULL beside the ADD COLUMN of an unreleased column", 'ALTER TABLE "bookmarks" ADD COLUMN "slug" text, ALTER COLUMN "slug" SET NOT NULL;', "sets column bookmarks.slug NOT NULL"],
    ["dropping the default of a column", 'ALTER TABLE "bookmarks" ALTER COLUMN "title" DROP DEFAULT;', "drops the default of column bookmarks.title"],
    ["dropping the default of a column in lower case without COLUMN", 'alter table bookmarks alter title drop default;', "drops the default of column bookmarks.title"],
    ["setting the default of a column to NULL", 'ALTER TABLE "bookmarks" ALTER COLUMN "title" SET DEFAULT NULL;', "drops the default of column bookmarks.title"],
    ["setting the default of a column to NULL in lower case", 'alter table bookmarks alter title set default null;', "drops the default of column bookmarks.title"],
    ["setting the default of a column to a parenthesised NULL", 'ALTER TABLE bookmarks ALTER COLUMN title SET DEFAULT (NULL);', "drops the default of column bookmarks.title"],
    ["setting the default of a column to a cast NULL", 'ALTER TABLE bookmarks ALTER COLUMN title SET DEFAULT NULL::text;', "drops the default of column bookmarks.title"],
    ["setting the default of a column to a deeply parenthesised, cast NULL", 'alter table bookmarks alter title set default (((null)))::varchar(10);', "drops the default of column bookmarks.title"],
    ["adding a named UNIQUE constraint", 'ALTER TABLE "bookmarks" ADD CONSTRAINT u UNIQUE (title);', "without CONCURRENTLY"],
    ["adding a UNIQUE constraint without a name in lower case", 'alter table bookmarks add unique (title);', "without CONCURRENTLY"],
    ["adding a UNIQUE constraint that treats NULLs as equal", 'ALTER TABLE "bookmarks" ADD CONSTRAINT "u" UNIQUE NULLS NOT DISTINCT ("title");', "without CONCURRENTLY"],
    ["adding a PRIMARY KEY", 'ALTER TABLE "bookmarks" ADD PRIMARY KEY (id);', "without CONCURRENTLY"],
    ["adding a named PRIMARY KEY in lower case", 'alter table only public.bookmarks add constraint pk primary key (id);', "without CONCURRENTLY"],
    ["adding an EXCLUDE constraint", 'ALTER TABLE "bookmarks" ADD CONSTRAINT x EXCLUDE USING gist (title WITH =);', "without CONCURRENTLY"],
    ["adding an EXCLUDE constraint in lower case", 'alter table bookmarks add exclude using gist (title with =);', "without CONCURRENTLY"],
    ["adding a UNIQUE constraint beside another action", 'ALTER TABLE "bookmarks" ADD COLUMN "x" text, ADD CONSTRAINT u UNIQUE (x);', "without CONCURRENTLY"],
    ["adding a CHECK constraint that is validated", 'ALTER TABLE "bookmarks" ADD CONSTRAINT c CHECK (title <> \'\');', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a CHECK constraint without a name in lower case", 'alter table bookmarks add check (title is not null);', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a CHECK constraint whose expression mentions NOT VALID", 'ALTER TABLE "bookmarks" ADD CONSTRAINT c CHECK (title IS NOT DISTINCT FROM \'not valid\');', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a FOREIGN KEY that is validated", 'ALTER TABLE "bookmarks" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a FOREIGN KEY in lower case", 'alter table bookmarks add foreign key (id) references notes (id);', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a constraint with nothing after its name", 'ALTER TABLE "bookmarks" ADD CONSTRAINT c;', "cannot place"],
    ["adding a constraint without a name", 'ALTER TABLE "bookmarks" ADD CONSTRAINT;', "cannot place"],
    ["adding a LIKE clause", 'ALTER TABLE "bookmarks" ADD LIKE other;', "cannot place"],
    ["adding a NOT NULL table constraint", 'ALTER TABLE "bookmarks" ADD NOT NULL title;', "sets column bookmarks.title NOT NULL"],
    ["adding a NOT NULL table constraint NOT VALID in lower case", 'alter table bookmarks add not null title not valid;', "sets column bookmarks.title NOT NULL"],
    ["adding a named NOT NULL table constraint on a quoted column", 'ALTER TABLE "bookmarks" ADD CONSTRAINT nn NOT NULL "title";', "sets column bookmarks.title NOT NULL"],
    ["adding a NOT NULL table constraint without a column", 'ALTER TABLE "bookmarks" ADD NOT NULL;', "cannot place"],
    ["adding a PRIMARY KEY from an existing index", 'ALTER TABLE "bookmarks" ADD CONSTRAINT p PRIMARY KEY USING INDEX ix;', "attaches an index as the primary key of table bookmarks"],
    ["adding a PRIMARY KEY from an existing index in lower case without a name", 'alter table bookmarks add primary key using index "ix";', "attaches an index as the primary key of table bookmarks"],
    ["adding a column with an inline UNIQUE", 'ALTER TABLE "bookmarks" ADD COLUMN "slug" text UNIQUE;', "without CONCURRENTLY"],
    ["adding a column with a named inline UNIQUE and no COLUMN keyword", 'alter table bookmarks add "slug" text constraint s unique;', "without CONCURRENTLY"],
    ["adding a column IF NOT EXISTS with an inline UNIQUE", 'ALTER TABLE "bookmarks" ADD COLUMN IF NOT EXISTS u text UNIQUE;', "without CONCURRENTLY"],
    ["adding a column with an inline PRIMARY KEY", 'ALTER TABLE "bookmarks" ADD COLUMN pid uuid PRIMARY KEY;', "without CONCURRENTLY"],
    ["adding a column with an inline CHECK that mentions NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "n" text CHECK (n IS NOT NULL);', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a column with a named inline CHECK in lower case", 'alter table bookmarks add column n int constraint c check (n > 0);', "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["adding a column with an inline REFERENCES and a default", "ALTER TABLE \"bookmarks\" ADD COLUMN \"p\" uuid DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES \"workspaces\"(\"id\");", "adds a CHECK or FOREIGN KEY constraint without NOT VALID to table bookmarks"],
    ["creating an index without CONCURRENTLY", 'CREATE INDEX "bookmarks_title_idx" ON "bookmarks" USING btree ("title");', "without CONCURRENTLY"],
    ["creating a unique index without CONCURRENTLY", 'CREATE UNIQUE INDEX IF NOT EXISTS ix ON ONLY public.bookmarks (title);', "without CONCURRENTLY"],
    ["a statement that cannot be placed", "DO $$ BEGIN EXECUTE 'ALTER TABLE bookmarks DROP COLUMN title'; END $$;", "cannot place"],
    ["a statement hidden behind a lone carriage return", '-- note\rALTER TABLE "bookmarks" DROP COLUMN "title";', "drops column bookmarks.title"],
    ["a column renamed through ALTER VIEW", "ALTER VIEW bookmarks RENAME COLUMN title TO name;", "cannot place"],
    ["a table renamed through ALTER INDEX", "ALTER INDEX bookmarks RENAME TO links;", "cannot place"],
    ["default privileges revoked", "ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE SELECT ON TABLES FROM slugbase_app;", "cannot place"],
    ["default privileges without a GRANT clause", "ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner IN SCHEMA pgboss;", "cannot place"],
    ["default privileges granted with text the reader does not read", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO slugbase_app CASCADE;", "cannot place"],
    ["revoking privileges on a table of the release", "REVOKE SELECT ON bookmarks FROM slugbase_app;", "revokes privileges on table bookmarks, which exists at v1.0.0"],
    ["revoking privileges on a quoted, schema-qualified table of the release", 'REVOKE ALL PRIVILEGES ON TABLE "public"."bookmarks" FROM "slugbase_app" CASCADE;', "revokes privileges on table bookmarks, which exists at v1.0.0"],
    ["revoking privileges on one table of a list", "REVOKE SELECT ON notes, bookmarks FROM slugbase_app;", "revokes privileges on table bookmarks, which exists at v1.0.0"],
    ["revoking privileges on a column of a table of the release", "REVOKE SELECT (title) ON bookmarks FROM slugbase_app;", "revokes privileges on table bookmarks, which exists at v1.0.0"],
    ["revoking privileges on a schema", "REVOKE USAGE ON SCHEMA public FROM slugbase_app;", "revokes privileges on a schema, sequence, database or every object of a kind"],
    ["revoking privileges on all tables in a schema", "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM slugbase_app;", "revokes privileges on a schema, sequence, database or every object of a kind"],
    ["a revocation with text the reader does not read", "REVOKE SELECT ON notes FROM slugbase_app GRANTED BY o;", "cannot place"],
    ["a grant with text the reader does not read", "GRANT SELECT ON bookmarks TO slugbase_app GRANTED BY o;", "cannot place"],
    ["a comment on a function", "COMMENT ON FUNCTION f(int) IS 'x';", "cannot place"],
    ["a comment with text the reader does not read", "COMMENT ON TABLE bookmarks IS 'x' || 'y';", "cannot place"],
    ["a type dropped with its columns", "DROP TYPE kind CASCADE;", "cannot place"],
    ["a SELECT", "SELECT 1;", "cannot place"],
    ["a SELECT of a function", "SELECT public.f();", "cannot place"],
    ["a session setting", "SET search_path = archive;", "cannot place"],
    ["a table created from a query", "CREATE TABLE notes AS SELECT 1;", "cannot place"],
    ["a table with a column list created from a query", "CREATE TABLE gone (id) AS SELECT id FROM bookmarks;", "cannot place"],
    ["a table with a column list created by EXECUTE", "CREATE TABLE gone (id) AS EXECUTE prepared;", "cannot place"],
    ["a table with a clause after its column list", "CREATE TABLE notes (id uuid) INHERITS (bookmarks);", "cannot place"],
    ["a table with an unclosed column list", "CREATE TABLE notes (id uuid;", "cannot place"],
    ["an enum type with text after its values", "CREATE TYPE kind AS ENUM ('a') AS SELECT 1;", "cannot place"],
    ["a view", "CREATE VIEW v AS SELECT 1;", "cannot place"],
    ["a trigger", "CREATE TRIGGER t BEFORE INSERT ON bookmarks EXECUTE FUNCTION f();", "cannot place"],
    ["an extension dropped with its columns", "DROP EXTENSION citext CASCADE;", "cannot place"],
    ["a table action it does not read", "ALTER TABLE bookmarks ALTER COLUMN title SET STORAGE external;", "cannot place"],
    ["a policy that calls a function", "CREATE POLICY p ON bookmarks USING (helper(id));", "calls helper()"],
    ["a table action it does not read, with no column", "ALTER TABLE bookmarks SET LOGGED;", "cannot place"],
    ["a table action over a whole tablespace", "ALTER TABLE ALL IN TABLESPACE ts SET TABLESPACE other;", "cannot place"],
    ["a name spelled with Unicode escapes", 'ALTER TABLE U&"b\\006Fokmarks" DROP COLUMN title;', "cannot place"],
  ])("rejects %s", async (_name, sql, expected) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(expected);
    expect(findings[0]?.message).toContain("it is not accepted");
  });

  it.each([
    ["a function body that alters a table, then a call", "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ ALTER TABLE bookmarks DROP COLUMN title $$;\nSELECT f();"],
    ["a plpgsql function that alters a table, then a call", "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ALTER TABLE bookmarks DROP COLUMN title; END $$;\nSELECT f();"],
    ["a SQL function body that calls another function, then a call", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT g() $$;\nSELECT f();"],
  ])("rejects the call of the helper function, whatever its body: %s", async (_name, sql) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
  });

  it("rejects the inline CHECK of an added column, not a NOT NULL column", async () => {
    const findings = await added('ALTER TABLE "bookmarks" ADD COLUMN "n" text CHECK (n IS NOT NULL);');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).not.toContain("NOT NULL without a default");
  });

  it("rejects each rejected statement of one file", async () => {
    const findings = await added(
      'ALTER TABLE "bookmarks" DROP COLUMN "title";\n--> statement-breakpoint\nALTER TABLE "bookmarks" RENAME COLUMN "legacy_title" TO "old";',
    );
    expect(findings.map((finding) => finding.message.split(",")[0])).toEqual([
      "drops column bookmarks.title",
      "renames column bookmarks.legacy_title to old",
    ].map((start) => expect.stringContaining(start) as string));
  });

  it("follows a table through a rename in the same release", async () => {
    const findings = await added(
      'ALTER TABLE "bookmarks" RENAME TO "links";\n--> statement-breakpoint\nALTER TABLE "links" DROP COLUMN "title";',
      { marker: true },
    );
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("renames table bookmarks to links"),
      expect.stringContaining("drops column links.title"),
    ]);
  });

  it("reads a migration that the journal lists after another added one against the state the first leaves", async () => {
    const repository = released();
    repository.migration(SECOND, 'ALTER TABLE "bookmarks" ADD COLUMN "extra" text;', [{ name: "bookmarks", columns: [...BOOKMARKS, "extra"] }]);
    repository.migration(THIRD, 'ALTER TABLE "bookmarks" DROP COLUMN "extra";', [{ name: "bookmarks", columns: BOOKMARKS }]);
    expect(await inspect(repository)).toEqual([]);
  });
});

describe("what is accepted without a contract", () => {
  it.each([
    ["adding a nullable column", 'ALTER TABLE "bookmarks" ADD COLUMN "slug" text;'],
    ["adding a NOT NULL column with a default", 'ALTER TABLE "bookmarks" ADD COLUMN "slug" text DEFAULT \'\' NOT NULL;'],
    ["adding a column with a constant default", 'ALTER TABLE "bookmarks" ADD COLUMN "n" integer DEFAULT 0;'],
    ["adding a column with a now() default", 'ALTER TABLE "bookmarks" ADD COLUMN "at" timestamp with time zone DEFAULT now() NOT NULL;'],
    ["adding a virtual generated column", 'ALTER TABLE "bookmarks" ADD COLUMN "t" text GENERATED ALWAYS AS (lower(title)) VIRTUAL;'],
    ["adding a virtual generated column in lower case", 'alter table bookmarks add t text generated always as (lower(title)) virtual;'],
    ["adding a column whose default and type arguments read like constraints", "ALTER TABLE \"bookmarks\" ADD COLUMN \"t\" varchar(10) DEFAULT 'primary key references check unique';"],
    ["adding a column with an inline REFERENCES and no default", 'ALTER TABLE "bookmarks" ADD COLUMN "p" uuid REFERENCES "workspaces"("id");'],
    ["adding a constraint", 'ALTER TABLE "bookmarks" ADD CONSTRAINT "t" CHECK (title IS NOT NULL) NOT VALID;'],
    ["adding a CHECK constraint NOT VALID in lower case without a name", 'alter table bookmarks add check (title is not null) not valid;'],
    ["adding a FOREIGN KEY NOT VALID", 'ALTER TABLE "bookmarks" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "public"."notes"("id") ON DELETE cascade NOT VALID;'],
    ["adding a FOREIGN KEY NOT VALID in lower case", 'alter table bookmarks add foreign key (id) references notes (id) not valid;'],
    ["adding a UNIQUE constraint from an existing index", 'ALTER TABLE "bookmarks" ADD CONSTRAINT u UNIQUE USING INDEX ix;'],
    ["adding a UNIQUE constraint from an existing index in lower case without a name", 'alter table bookmarks add unique using index "ix";'],
    ["validating a constraint", 'ALTER TABLE "bookmarks" VALIDATE CONSTRAINT "t";'],
    ["dropping a constraint", 'ALTER TABLE "bookmarks" DROP CONSTRAINT "t";'],
    ["dropping NOT NULL from a column", 'ALTER TABLE "bookmarks" ALTER COLUMN "title" DROP NOT NULL;'],
    ["setting the default of a column", 'alter table bookmarks alter title set default \'\';'],
    ["setting the default of a column to a string that reads null", 'ALTER TABLE "bookmarks" ALTER COLUMN "title" SET DEFAULT \'null\'::text;'],
    ["creating a table", 'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "body" text NOT NULL);'],
    ["dropping a table that is not in the release", 'DROP TABLE "drafts";'],
    ["dropping a column that is not in the release", 'ALTER TABLE "bookmarks" DROP COLUMN "scratch";'],
    ["dropping a column of a table in another schema", 'ALTER TABLE "archive"."bookmarks" DROP COLUMN "title";'],
    ["dropping an index", 'DROP INDEX "bookmarks_title_idx";'],
    ["creating an index of a table the release does not hold", 'CREATE INDEX ix ON "notes" ("body");'],
    ["a statement in a comment or a string", "-- ALTER TABLE bookmarks DROP COLUMN title;\n/* DROP TABLE bookmarks; */\nCOMMENT ON TABLE bookmarks IS 'ALTER TABLE bookmarks DROP COLUMN title';"],
    ["a statement inside nested block comments", "/* a /* b */ ALTER TABLE bookmarks DROP COLUMN title; */\nCOMMENT ON TABLE bookmarks IS 'x';"],
    ["a statement in an escape string that holds a quote", "COMMENT ON TABLE bookmarks IS E'it\\'s; ALTER TABLE bookmarks DROP COLUMN title; --';"],
    ["a statement in a dollar-quoted string with a tag", "COMMENT ON TABLE bookmarks IS $a$ x; ALTER TABLE bookmarks DROP COLUMN title; $$ y $a$;"],
    ["an enum, a table with built-in defaults and a policy on the tenant context", "CREATE TYPE \"public\".\"kind\" AS ENUM('a', 'b');\nCREATE TABLE \"notes\" (\"id\" uuid PRIMARY KEY, \"at\" timestamp (3) with time zone DEFAULT now() NOT NULL, \"t\" varchar(10), CONSTRAINT \"fk\" FOREIGN KEY (\"id\") REFERENCES \"public\".\"bookmarks\"(\"id\"));\nCREATE POLICY p ON notes USING (id = (select public.app_workspace_id()));"],
    ["a SQL function of one SELECT of built-ins", "CREATE OR REPLACE FUNCTION public.f() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;"],
    ["a function body that mentions a drop", "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 -- DROP TABLE bookmarks;\n$$;"],
    ["default privileges granted to a role", "ALTER DEFAULT PRIVILEGES FOR ROLE slugbase_owner IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slugbase_app;"],
    ["revoking privileges on a table the release does not hold", "REVOKE ALL ON notes FROM PUBLIC;"],
    ["comments on a table, a column and a policy", "COMMENT ON TABLE bookmarks IS 'x';\nCOMMENT ON COLUMN bookmarks.title IS NULL;\nCOMMENT ON POLICY p ON bookmarks IS 'x';"],
    ["a column-level grant of INSERT", "GRANT INSERT (id, title) ON TABLE bookmarks TO slugbase_app;"],
    ["a table-level revoke and a column-level grant of INSERT on a table the release does not hold", "REVOKE ALL ON TABLE notes FROM PUBLIC, slugbase_app;\nGRANT INSERT (id, body) ON TABLE notes TO slugbase_app;"],
    ["policies and grants", 'ALTER TABLE "bookmarks" ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON bookmarks USING (true);\nGRANT SELECT ON bookmarks TO slugbase_app;'],
  ])("accepts %s", async (_name, sql) => {
    expect(await added(sql)).toEqual([]);
  });

  it("accepts an index of the release built CONCURRENTLY in a non-transactional file", async () => {
    expect(
      await added('-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "bookmarks_title_idx" ON "bookmarks" USING btree ("title");\n'),
    ).toEqual([]);
  });

  it("accepts the constraints drizzle-kit writes after the CREATE TABLE of the same migration", async () => {
    expect(
      await added(
        'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "bookmark_id" uuid NOT NULL);\n--> statement-breakpoint\nALTER TABLE "notes" ADD CONSTRAINT "notes_bookmark_fk" FOREIGN KEY ("bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;\n--> statement-breakpoint\nALTER TABLE "notes" ADD CONSTRAINT "notes_bookmark_key" UNIQUE("bookmark_id");',
      ),
    ).toEqual([]);
  });

  it("accepts constraints that build an index or validate on a table created in the same release", async () => {
    const repository = released();
    repository.migration(SECOND, 'CREATE TABLE "notes" ("id" uuid, "body" text);', [
      { name: "bookmarks", columns: BOOKMARKS },
      { name: "notes", columns: ["id", "body"] },
    ]);
    repository.migration(
      THIRD,
      [
        'ALTER TABLE "notes" ADD PRIMARY KEY (id);',
        'ALTER TABLE "notes" ADD CONSTRAINT u UNIQUE (body);',
        'ALTER TABLE "notes" ADD CONSTRAINT x EXCLUDE USING gist (body WITH =);',
        'ALTER TABLE "notes" ADD CONSTRAINT c CHECK (body <> \'\');',
        'ALTER TABLE "notes" ADD CONSTRAINT f FOREIGN KEY (id) REFERENCES bookmarks (id);',
        'ALTER TABLE "notes" ADD NOT NULL body;',
        'ALTER TABLE "notes" ADD PRIMARY KEY USING INDEX ix;',
        'ALTER TABLE "notes" ADD COLUMN "slug" text UNIQUE;',
        'ALTER TABLE "notes" ADD COLUMN "pid" uuid PRIMARY KEY;',
        'ALTER TABLE "notes" ADD COLUMN "n" text CHECK (n IS NOT NULL);',
        "ALTER TABLE \"notes\" ADD COLUMN \"p\" uuid DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES \"bookmarks\"(\"id\");",
      ].join("\n"),
    );
    expect(await inspect(repository)).toEqual([]);
  });

  it("accepts every table-rewriting ADD COLUMN form on a table created in the same release", async () => {
    const repository = released();
    repository.migration(SECOND, 'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "body" text);', [
      { name: "bookmarks", columns: BOOKMARKS },
      { name: "notes", columns: ["id", "body"] },
    ]);
    repository.migration(
      THIRD,
      [
        'ALTER TABLE "notes" ADD COLUMN "a" bigserial NOT NULL;',
        'ALTER TABLE "notes" ADD COLUMN "b" integer GENERATED ALWAYS AS IDENTITY;',
        'ALTER TABLE "notes" ADD COLUMN "c" text GENERATED ALWAYS AS (lower(body)) STORED;',
      ].join("\n"),
    );
    expect(await inspect(repository)).toEqual([]);
  });

  it("accepts a NOT NULL column and an index on a table created in the same release", async () => {
    const repository = released();
    repository.migration(SECOND, 'CREATE TABLE "notes" ("id" uuid PRIMARY KEY);', [
      { name: "bookmarks", columns: BOOKMARKS },
      { name: "notes", columns: ["id"] },
    ]);
    repository.migration(
      THIRD,
      'ALTER TABLE "notes" ADD COLUMN "body" text NOT NULL;\nCREATE INDEX ix ON "notes" ("body");\nALTER TABLE "notes" ALTER COLUMN "body" SET DATA TYPE varchar(20);\nALTER TABLE "notes" ALTER COLUMN "body" SET NOT NULL;\nALTER TABLE "notes" ALTER COLUMN "body" DROP DEFAULT;\nALTER TABLE "notes" ALTER COLUMN "body" SET DEFAULT NULL;\nALTER TABLE "notes" DROP COLUMN "body";',
    );
    expect(await inspect(repository)).toEqual([]);
  });
});

const VALIDATES = "validates every row of the table";
const CONTRACT = `-- slugbase:contract expand=${FIRST} release=1.0.0\n`;
const POSITIVE = "CREATE DOMAIN d AS integer CHECK (VALUE > 0);";

/** The findings for an unmarked migration that runs `sql`, after a contract migration that runs `declaration`. */
async function afterContract(declaration: string, sql: string): Promise<readonly Finding[]> {
  const repository = released();
  repository.migration(SECOND, `${CONTRACT}${declaration}`, [{ name: "bookmarks", columns: BOOKMARKS }]);
  repository.migration(THIRD, sql);
  return inspect(repository, true);
}

describe("a column of a domain type on a table of the release", () => {
  it("rejects the failure scenario: a domain with a CHECK created by a contract migration, then added unmarked", async () => {
    const findings = await afterContract(POSITIVE, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
    expect(findings[0]?.message).toContain("adds column bookmarks.a of type d");
    expect(findings[0]?.message).toContain(VALIDATES);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it.each([
    ["a domain with a CHECK and a default", POSITIVE, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d DEFAULT 5;'],
    ["a domain with a CHECK, nullable, without COLUMN", POSITIVE, "alter table bookmarks add a d;"],
    ["a domain with a CHECK, IF NOT EXISTS", POSITIVE, 'ALTER TABLE "bookmarks" ADD COLUMN IF NOT EXISTS "a" d;'],
    ["a domain with a CHECK named by its schema", POSITIVE, 'ALTER TABLE "bookmarks" ADD COLUMN "a" "public"."d";'],
    ["a domain with a CHECK, named in a multi-action ALTER", POSITIVE, 'ALTER TABLE "bookmarks" ADD COLUMN "x" text, ADD COLUMN "a" d;'],
    ["a domain with a named CHECK constraint", "CREATE DOMAIN d AS text CONSTRAINT positive CHECK (VALUE <> '');", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain that is NOT NULL", "CREATE DOMAIN d AS integer NOT NULL DEFAULT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d DEFAULT 5;'],
    ["a quoted domain", 'CREATE DOMAIN "Positive" AS integer CHECK (VALUE > 0);', 'ALTER TABLE "bookmarks" ADD COLUMN "a" "Positive";'],
    ["a domain in another schema", "CREATE DOMAIN archive.d AS integer CHECK (VALUE > 0);", 'ALTER TABLE "bookmarks" ADD COLUMN "a" archive.d;'],
    ["a domain over a domain with a CHECK", `${POSITIVE}\nCREATE DOMAIN e AS d;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a type this check cannot place", "CREATE DOMAIN d AS archive.t;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain given a constraint later", "CREATE DOMAIN d AS integer;\nALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0);", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain made NOT NULL later", "CREATE DOMAIN d AS integer;\nALTER DOMAIN d SET NOT NULL;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain renamed to the name of an enum", "CREATE TYPE e AS ENUM ('a');\nALTER TYPE e RENAME TO old_e;\nALTER DOMAIN c RENAME TO e;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["an enum moved to another schema", "CREATE TYPE e AS ENUM ('a');\nALTER TYPE e SET SCHEMA archive;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain that replaced an enum of the same name", `CREATE TYPE d AS ENUM ('a');\nDROP TYPE d;\n${POSITIVE}`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a schema-qualified type of PostgreSQL that is a domain", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" information_schema.cardinal_number;'],
    ["a type named with three parts", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" slugbase.public.d;'],
    ["a type no migration declares", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" some_type;'],
    ["a quoted name that is not a built-in", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" "integer";'],
    ["a quoted capitals name, which is not the serial type", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "n" "SERIAL";'],
  ])("rejects %s", async (_name, declaration, sql) => {
    const findings = await afterContract(declaration, sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
    expect(findings[0]?.message).toContain(VALIDATES);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it("rejects a domain that an earlier release created", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, `${POSITIVE}\nCREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY);\n`, [{ name: "bookmarks", columns: ["id"] }]);
    repository.commit("first release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;', [{ name: "bookmarks", columns: ["id", "a"] }]);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(VALIDATES);
  });

  it("accepts it in a contract migration with the header and the marker, and names the marker when only the header is there", async () => {
    const repository = released();
    repository.migration(SECOND, `${CONTRACT}${POSITIVE}`, [{ name: "bookmarks", columns: BOOKMARKS }]);
    repository.migration(THIRD, `${CONTRACT}ALTER TABLE "bookmarks" ADD COLUMN "a" d;`);
    expect(await inspect(repository, true)).toEqual([]);
    const findings = await inspect(repository);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(({ message }) => message.includes(MARKER_HINT))).toBe(true);
    expect(findings.some(({ message }) => message.includes(VALIDATES))).toBe(true);
  });

  it.each([
    ["a built-in type", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" integer;'],
    ["built-in types of several words", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" double precision, ADD COLUMN "b" character varying(10) DEFAULT \'x\', ADD COLUMN "c" timestamp (3) with time zone, ADD COLUMN "d" bit varying(4);'],
    ["the citext type of the extension the package installs", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" citext, ADD COLUMN "b" public.citext;'],
    ["a built-in array type", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" text[], ADD COLUMN "b" integer ARRAY;'],
    ["built-in types by their catalog names", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" int4, ADD COLUMN "b" "int8", ADD COLUMN "c" jsonb, ADD COLUMN "d" uuid, ADD COLUMN "e" pg_catalog.int2, ADD COLUMN "f" pg_catalog.varchar(5);'],
    ["a built-in type, NOT NULL with a default", "SELECT 1;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" boolean DEFAULT false NOT NULL;'],
    ["an enum", "CREATE TYPE \"public\".\"kind\" AS ENUM('a', 'b');", 'ALTER TABLE "bookmarks" ADD COLUMN "a" kind DEFAULT \'a\' NOT NULL, ADD COLUMN "b" public.kind, ADD COLUMN "c" kind[];'],
    ["an enum extended later", "CREATE TYPE kind AS ENUM ('a');\nALTER TYPE kind ADD VALUE 'b';", 'ALTER TABLE "bookmarks" ADD COLUMN "a" kind;'],
    ["a domain without a constraint", "CREATE DOMAIN d AS integer;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d DEFAULT 5;'],
    ["a domain with a default and a collation only", "CREATE DOMAIN d AS text COLLATE \"C\" DEFAULT 'x';", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain whose default is a CASE expression", "CREATE DOMAIN d AS integer DEFAULT (CASE WHEN true THEN 1 ELSE 0 END);", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain over an enum", "CREATE TYPE kind AS ENUM ('a');\nCREATE DOMAIN d AS kind;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;'],
    ["a domain over a domain without a constraint", "CREATE DOMAIN d AS integer;\nCREATE DOMAIN e AS d NULL;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["an array of a domain with a CHECK, which is not a domain type", POSITIVE, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d[];'],
    ["a domain with a CHECK, owned by another owner later", `${POSITIVE}\nCREATE DOMAIN e AS integer;\nALTER DOMAIN e OWNER TO slugbase_owner;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
  ])("accepts %s", async (_name, declaration, sql) => {
    expect(await afterContract(declaration, sql)).toEqual([]);
  });

  describe("after a migration this check cannot read", () => {
    const FOURTH = "20260401000000_add_more";
    // A BEGIN ATOMIC body holds statements the reader does not separate, so the whole file is unreadable.
    const UNREADABLE = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;";
    const ADD = 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;';

    it.each([
      ["a domain given a constraint", "CREATE DOMAIN d AS integer;", "ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0);"],
      ["a domain made NOT NULL", "CREATE DOMAIN d AS integer;", "ALTER DOMAIN d SET NOT NULL;"],
      ["an enum replaced by a domain", "CREATE TYPE d AS ENUM ('a');", `DROP TYPE d;\n${POSITIVE}`],
      ["a domain renamed to the name of a constraint-free one", "CREATE DOMAIN d AS integer;", "ALTER DOMAIN d RENAME TO old_d;\nCREATE DOMAIN d AS integer CHECK (VALUE > 0);"],
    ])("rejects %s by a migration added since the release", async (_name, declaration, change) => {
      const repository = released();
      repository.migration(SECOND, `${CONTRACT}${declaration}`, [{ name: "bookmarks", columns: BOOKMARKS }]);
      repository.migration(THIRD, `${CONTRACT}${change}\n${UNREADABLE}`);
      repository.migration(FOURTH, ADD);
      const findings = await inspect(repository, true);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${FOURTH}.sql`);
      expect(findings[0]?.message).toContain("adds column bookmarks.a of type d");
      expect(findings[0]?.message).toContain(VALIDATES);
    });

    it.each([
      ["a domain given a constraint", "CREATE DOMAIN d AS integer;", "ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0);"],
      ["an enum replaced by a domain", "CREATE TYPE d AS ENUM ('a');", `DROP TYPE d;\n${POSITIVE}`],
    ])("rejects %s by a migration of the release", async (_name, declaration, change) => {
      const repository = new GitPackage();
      repositories.push(repository);
      repository.migration(FIRST, `${declaration}\nCREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY);\n`, [{ name: "bookmarks", columns: ["id"] }]);
      repository.migration(SECOND, `${change}\n${UNREADABLE}`);
      repository.commit("first release");
      repository.tag("v1.0.0");
      repository.migration(THIRD, ADD, [{ name: "bookmarks", columns: ["id", "a"] }]);
      const findings = await inspect(repository);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
      expect(findings[0]?.message).toContain(VALIDATES);
    });

    it("rejects an unmarked migration that cannot be read itself, and an enum declared before it", async () => {
      const repository = released();
      repository.migration(SECOND, "CREATE TYPE kind AS ENUM ('a');", [{ name: "bookmarks", columns: BOOKMARKS }]);
      repository.migration(THIRD, `${CONTRACT}${UNREADABLE}`);
      repository.migration(FOURTH, 'ALTER TABLE "bookmarks" ADD COLUMN "a" kind;');
      const findings = await inspect(repository, true);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${FOURTH}.sql`);
      expect(findings[0]?.message).toContain(VALIDATES);
    });

    const DO_BLOCK = "DO $$ BEGIN ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0); END $$;";

    it("rejects a domain given a constraint in a DO block of a migration added since the release", async () => {
      const repository = released();
      repository.migration(SECOND, `${CONTRACT}CREATE DOMAIN d AS integer;`, [{ name: "bookmarks", columns: BOOKMARKS }]);
      repository.migration(THIRD, `${CONTRACT}${DO_BLOCK}`);
      repository.migration(FOURTH, ADD);
      const findings = await inspect(repository, true);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${FOURTH}.sql`);
      expect(findings[0]?.message).toContain("adds column bookmarks.a of type d");
      expect(findings[0]?.message).toContain(VALIDATES);
    });

    it("rejects a domain given a constraint in a DO block of a migration of the release", async () => {
      const repository = new GitPackage();
      repositories.push(repository);
      repository.migration(FIRST, 'CREATE DOMAIN d AS integer;\nCREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY);\n', [{ name: "bookmarks", columns: ["id"] }]);
      repository.migration(SECOND, DO_BLOCK);
      repository.commit("first release");
      repository.tag("v1.0.0");
      repository.migration(THIRD, ADD, [{ name: "bookmarks", columns: ["id", "a"] }]);
      const findings = await inspect(repository);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
      expect(findings[0]?.message).toContain(VALIDATES);
    });

    it("rejects an enum declared before a DO block", async () => {
      const repository = released();
      repository.migration(SECOND, "CREATE TYPE kind AS ENUM ('a');", [{ name: "bookmarks", columns: BOOKMARKS }]);
      repository.migration(THIRD, `${CONTRACT}DO $$ BEGIN PERFORM 1; END $$;`);
      repository.migration(FOURTH, 'ALTER TABLE "bookmarks" ADD COLUMN "a" kind;');
      const findings = await inspect(repository, true);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${FOURTH}.sql`);
    });

    it("accepts a type declared after a DO block", async () => {
      const repository = released();
      repository.migration(SECOND, `${CONTRACT}${DO_BLOCK}`, [{ name: "bookmarks", columns: BOOKMARKS }]);
      repository.migration(THIRD, `${CONTRACT}CREATE TYPE kind AS ENUM ('a');\nCREATE DOMAIN d AS integer;`);
      repository.migration(FOURTH, 'ALTER TABLE "bookmarks" ADD COLUMN "a" integer, ADD COLUMN "b" citext, ADD COLUMN "e" kind, ADD COLUMN "f" d;');
      expect(await inspect(repository, true)).toEqual([]);
    });

    it("still accepts a built-in type, the citext type and a type declared after it", async () => {
      const repository = released();
      repository.migration(SECOND, `${CONTRACT}${UNREADABLE}`, [{ name: "bookmarks", columns: BOOKMARKS }]);
      repository.migration(THIRD, `${CONTRACT}CREATE TYPE kind AS ENUM ('a');\nCREATE DOMAIN d AS integer;`);
      repository.migration(FOURTH, 'ALTER TABLE "bookmarks" ADD COLUMN "a" integer, ADD COLUMN "b" citext, ADD COLUMN "c" text[], ADD COLUMN "e" kind, ADD COLUMN "f" d;');
      expect(await inspect(repository, true)).toEqual([]);
    });
  });

  it("accepts a domain with a CHECK on a table the release does not hold", async () => {
    const repository = released();
    repository.migration(SECOND, `${CONTRACT}${POSITIVE}\nCREATE TABLE "notes" ("id" uuid PRIMARY KEY);`, [
      { name: "bookmarks", columns: BOOKMARKS },
      { name: "notes", columns: ["id"] },
    ]);
    repository.migration(THIRD, 'ALTER TABLE "notes" ADD COLUMN "a" d;');
    expect(await inspect(repository, true)).toEqual([]);
  });
});

// PostgreSQL 18, checked in rolled-back transactions on the development database by comparing the
// table's relfilenode before and after the ADD COLUMN: a column of a domain whose default is volatile
// (random()) and that has no default of its own rewrites the table, because each existing row gets
// its own value. A domain with a constant or stable (now()) default, none, or a dropped default does
// not, nor does a column with a default of its own (DEFAULT NULL included), nor an array of the domain.
// A domain over a domain takes the default of its base when it is created (typdefault is copied), so
// a later ALTER DOMAIN of the base leaves it as it was; its own DEFAULT, NULL included, replaces it,
// and DROP DEFAULT removes it.
const VOLATILE = "whose default is not a constant or a stable call";
const VOLATILE_DOMAIN = "CREATE DOMAIN d AS float8 DEFAULT random();";
const ADD_D = 'ALTER TABLE "bookmarks" ADD COLUMN "a" d;';

describe("a column of a domain with a default that is not provably constant or stable, on a table of the release", () => {
  it("rejects the failure scenario: a volatile default from CREATE DOMAIN in a contract migration, then added unmarked", async () => {
    const findings = await afterContract(VOLATILE_DOMAIN, ADD_D);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
    expect(findings[0]?.message).toContain("adds column bookmarks.a of type d");
    expect(findings[0]?.message).toContain(VOLATILE);
    expect(findings[0]?.message).toContain(REWRITES);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it("rejects the variant: a volatile default from ALTER DOMAIN ... SET DEFAULT", async () => {
    const findings = await afterContract("CREATE DOMAIN d AS float8;\nALTER DOMAIN d SET DEFAULT random();", ADD_D);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("adds column bookmarks.a of type d");
    expect(findings[0]?.message).toContain(VOLATILE);
    expect(findings[0]?.message).toContain(REWRITES);
  });

  it.each([
    ["COMPRESSION default", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d COMPRESSION default;'],
    ["COMPRESSION default before NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d COMPRESSION default NOT NULL;'],
    ["COMPRESSION default after NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d NOT NULL COMPRESSION default;'],
    ["STORAGE default", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d STORAGE default;'],
    ["STORAGE default before NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d STORAGE default NOT NULL;'],
    ["STORAGE default after NOT NULL", 'ALTER TABLE "bookmarks" ADD COLUMN "a" d NOT NULL STORAGE default;'],
  ])("rejects a volatile default under %s, which is no default of the column", async (_name, sql) => {
    const findings = await afterContract(VOLATILE_DOMAIN, sql);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(({ message }) => message.includes(VOLATILE) && message.includes(REWRITES))).toBe(true);
  });

  it.each([
    ["a default that calls a function the rule does not know", "CREATE DOMAIN d AS uuid DEFAULT gen_random_uuid();", ADD_D],
    ["a default that calls a sequence function", "CREATE DOMAIN d AS bigint DEFAULT nextval('s');", ADD_D],
    ["a default that calls clock_timestamp", "CREATE DOMAIN d AS timestamptz DEFAULT clock_timestamp();", ADD_D],
    ["a default that calls random() in an expression", "CREATE DOMAIN d AS float8 DEFAULT (1 + random()) * 2;", ADD_D],
    ["a default that calls random() under a schema", "CREATE DOMAIN d AS float8 DEFAULT pg_catalog.random();", ADD_D],
    ["a volatile default after another clause", 'CREATE DOMAIN d AS float8 COLLATE "C" DEFAULT random();', ADD_D],
    ["a volatile default, nullable, without COLUMN", VOLATILE_DOMAIN, "alter table bookmarks add a d;"],
    ["a volatile default, in a multi-action ALTER", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "x" text, ADD COLUMN "a" d;'],
    ["a volatile default named by its schema", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" "public"."d";'],
    ["a volatile default set after a constant one", "CREATE DOMAIN d AS float8 DEFAULT 1;\nALTER DOMAIN d SET DEFAULT random();", ADD_D],
    ["a domain over a domain with a volatile default", `${VOLATILE_DOMAIN}\nCREATE DOMAIN e AS d;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a domain over a domain with a volatile default", `${VOLATILE_DOMAIN}\nCREATE DOMAIN e AS d;\nCREATE DOMAIN f AS e;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" f;'],
    ["a domain over a domain whose volatile default was dropped from the base later", `${VOLATILE_DOMAIN}\nCREATE DOMAIN e AS d;\nALTER DOMAIN d DROP DEFAULT;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a domain given a volatile default later", "CREATE DOMAIN d AS float8;\nCREATE DOMAIN e AS d;\nALTER DOMAIN e SET DEFAULT random();", 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
  ])("rejects %s", async (_name, declaration, sql) => {
    const findings = await afterContract(declaration, sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
    expect(findings[0]?.message).toContain(VOLATILE);
    expect(findings[0]?.message).toContain(REWRITES);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it("rejects a volatile default that an earlier release created", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, `${VOLATILE_DOMAIN}\nCREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY);\n`, [{ name: "bookmarks", columns: ["id"] }]);
    repository.commit("first release");
    repository.tag("v1.0.0");
    repository.migration(SECOND, ADD_D, [{ name: "bookmarks", columns: ["id", "a"] }]);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(VOLATILE);
  });

  it("rejects a volatile default set by ALTER DOMAIN in a migration of the release", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, 'CREATE DOMAIN d AS float8;\nCREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY);\n', [{ name: "bookmarks", columns: ["id"] }]);
    repository.migration(SECOND, "ALTER DOMAIN d SET DEFAULT random();");
    repository.commit("first release");
    repository.tag("v1.0.0");
    repository.migration(THIRD, ADD_D, [{ name: "bookmarks", columns: ["id", "a"] }]);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(VOLATILE);
  });

  it("accepts it in a contract migration with the header and the marker, and names the marker when only the header is there", async () => {
    const repository = released();
    repository.migration(SECOND, `${CONTRACT}${VOLATILE_DOMAIN}`, [{ name: "bookmarks", columns: BOOKMARKS }]);
    repository.migration(THIRD, `${CONTRACT}${ADD_D}`);
    expect(await inspect(repository, true)).toEqual([]);
    const findings = await inspect(repository);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(({ message }) => message.includes(MARKER_HINT))).toBe(true);
    expect(findings.some(({ message }) => message.includes(VOLATILE))).toBe(true);
  });

  it.each([
    ["a constant default", "CREATE DOMAIN d AS float8 DEFAULT 5;", ADD_D],
    ["a constant default expression", "CREATE DOMAIN d AS text DEFAULT 'a' || 'b';", ADD_D],
    ["a default of the stable now()", "CREATE DOMAIN d AS timestamptz DEFAULT now();", ADD_D],
    ["a default of a stable current_setting call", "CREATE DOMAIN d AS text DEFAULT current_setting('app.x', true);", ADD_D],
    ["a NULL default", "CREATE DOMAIN d AS float8 DEFAULT NULL;", ADD_D],
    ["no default", "CREATE DOMAIN d AS float8;", ADD_D],
    ["a volatile default that DROP DEFAULT removed", `${VOLATILE_DOMAIN}\nALTER DOMAIN d DROP DEFAULT;`, ADD_D],
    ["a volatile default that SET DEFAULT replaced by a constant", `${VOLATILE_DOMAIN}\nALTER DOMAIN d SET DEFAULT 1;`, ADD_D],
    ["a volatile default that SET DEFAULT NULL removed", `${VOLATILE_DOMAIN}\nALTER DOMAIN d SET DEFAULT NULL;`, ADD_D],
    ["a volatile default under a column default of its own", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d DEFAULT 1;'],
    ["a volatile default under a column default of NULL", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d DEFAULT NULL;'],
    ["a volatile default under a NOT NULL column with a default of its own", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d NOT NULL DEFAULT 1;'],
    ["a volatile default under a column default of its own beside COMPRESSION default", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d COMPRESSION default DEFAULT 1;'],
    ["a volatile default under a column default of its own beside STORAGE default", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d DEFAULT 1 STORAGE default;'],
    ["an array of a domain with a volatile default", VOLATILE_DOMAIN, 'ALTER TABLE "bookmarks" ADD COLUMN "a" d[];'],
    ["a domain over a domain with a volatile default, given a constant default of its own", `${VOLATILE_DOMAIN}\nCREATE DOMAIN e AS d DEFAULT 3;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a domain with a volatile default, given a NULL default of its own", `${VOLATILE_DOMAIN}\nCREATE DOMAIN e AS d DEFAULT NULL;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a domain with a volatile default, whose default was dropped", `${VOLATILE_DOMAIN}\nCREATE DOMAIN e AS d;\nALTER DOMAIN e DROP DEFAULT;`, 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a domain whose base was given a volatile default after its creation", "CREATE DOMAIN d AS float8 DEFAULT 1;\nCREATE DOMAIN e AS d;\nALTER DOMAIN d SET DEFAULT random();", 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
    ["a domain over a domain with a constant default", "CREATE DOMAIN d AS float8 DEFAULT 1;\nCREATE DOMAIN e AS d;", 'ALTER TABLE "bookmarks" ADD COLUMN "a" e;'],
  ])("accepts %s", async (_name, declaration, sql) => {
    expect(await afterContract(declaration, sql)).toEqual([]);
  });

  it("accepts a volatile default on a table the release does not hold", async () => {
    const repository = released();
    repository.migration(SECOND, `${CONTRACT}${VOLATILE_DOMAIN}\nCREATE TABLE "notes" ("id" uuid PRIMARY KEY);`, [
      { name: "bookmarks", columns: BOOKMARKS },
      { name: "notes", columns: ["id"] },
    ]);
    repository.migration(THIRD, 'ALTER TABLE "notes" ADD COLUMN "a" d;');
    expect(await inspect(repository, true)).toEqual([]);
  });

  it("rejects a domain with a constant default after a migration this check cannot read", async () => {
    const FOURTH = "20260401000000_add_more";
    const repository = released();
    repository.migration(SECOND, `${CONTRACT}CREATE DOMAIN d AS float8 DEFAULT 1;`, [{ name: "bookmarks", columns: BOOKMARKS }]);
    repository.migration(THIRD, `${CONTRACT}DO $$ BEGIN ALTER DOMAIN d SET DEFAULT random(); END $$;`);
    repository.migration(FOURTH, ADD_D);
    const findings = await inspect(repository, true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${FOURTH}.sql`);
    expect(findings[0]?.message).toContain("adds column bookmarks.a of type d");
  });
});

describe("the release the objects are measured against", () => {
  it("uses the highest release tag, ignoring tags that are not releases and older releases", async () => {
    const repository = released("v1.0.0");
    repository.migration(SECOND, 'CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "body" text);', [
      { name: "bookmarks", columns: BOOKMARKS },
      { name: "notes", columns: ["id", "body"] },
    ]);
    repository.commit("second release");
    repository.tag("v1.0.1-rc.1");
    repository.tag("v1.0.1");
    repository.tag("v0.9.0");
    repository.tag("nightly");
    repository.tag("v2");
    repository.migration(THIRD, 'ALTER TABLE "notes" DROP COLUMN "body";', undefined);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("drops column notes.body, which exists at v1.0.1");
  });

  it("orders pre-releases below their release and by their identifiers", async () => {
    const repository = released("v1.0.0-rc.2");
    repository.tag("v1.0.0-rc.10");
    repository.tag("v1.0.0-beta.1");
    repository.migration(SECOND, 'ALTER TABLE "bookmarks" DROP COLUMN "title";');
    const findings = await inspect(repository);
    expect(findings[0]?.message).toContain("exists at v1.0.0-rc.10");
  });

  it("accepts an unprefixed release tag", async () => {
    const repository = released("1.2.3");
    repository.migration(SECOND, 'DROP TABLE "bookmarks";');
    expect((await inspect(repository))[0]?.message).toContain("exists at 1.2.3");
  });

  it("counts every object as unreleased in a full clone without a release tag", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, 'CREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY, "title" text);', [{ name: "bookmarks", columns: ["id", "title"] }]);
    repository.commit("only commit");
    repository.tag("nightly");
    repository.migration(SECOND, 'ALTER TABLE "bookmarks" DROP COLUMN "title";\nDROP TABLE "bookmarks";\nCREATE INDEX ix ON "bookmarks" ("id");', []);
    expect(await inspect(repository)).toEqual([]);
  });

  it("still reads the migrations of a repository with no tag for statements it cannot place", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, "DO $$ BEGIN PERFORM 1; END $$;", []);
    repository.commit("only commit");
    expect(await inspect(repository)).toHaveLength(1);
  });

  it("does not look at a migration the release already holds", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, 'DO $$ BEGIN PERFORM 1; END $$;', []);
    repository.commit("release");
    repository.tag("v1.0.0");
    expect(await inspect(repository)).toEqual([]);
  });
});

describe("when git cannot say whether a release tag exists", () => {
  it("fails in a shallow clone, whatever the migrations hold", async () => {
    const repository = released();
    const parent = mkdtempSync(join(tmpdir(), "slugbase-db-check-shallow-"));
    scratch.push(parent);
    const clone = join(parent, "clone");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--no-tags", `file://${repository.root}`, clone], { stdio: "ignore" });
    expect(execFileSync("git", ["-C", clone, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim()).toBe("true");
    await expect(
      Promise.resolve(expandContractRule.run({ packageDir: join(clone, "packages", "db"), sql: undefined, hashSqlFiles })),
    ).rejects.toThrow("shallow clone");
    const results = await runChecks([expandContractRule], { packageDir: join(clone, "packages", "db"), sql: undefined, hashSqlFiles });
    expect(results[0]?.findings[0]?.message).toContain("the rule could not run: shallow clone");
  });

  it("fails outside a git work tree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slugbase-db-check-nogit-"));
    scratch.push(directory);
    const repository = released();
    const results = await runChecks([expandContractRule], { packageDir: join(directory), sql: undefined, hashSqlFiles });
    expect(results[0]?.findings[0]?.message).toContain("the rule could not run");
    expect(repository.dir).not.toBe(directory);
  });

  it("fails when the release tag has no readable journal", async () => {
    const repository = released();
    repository.git("rm", "--quiet", "-r", "--cached", "packages");
    repository.git("commit", "--quiet", "-m", "remove");
    repository.git("tag", "-f", "v1.1.0");
    const results = await runChecks([expandContractRule], { packageDir: repository.dir, sql: undefined, hashSqlFiles });
    expect(results[0]?.findings[0]?.message).toContain("the rule could not run");
  });
});

/** v1.0.0 holds bookmarks.legacy_title, v1.1.0 adds the migration that replaces it. */
function pair(header: string, sql = 'ALTER TABLE "bookmarks" DROP COLUMN "legacy_title";\n'): GitPackage {
  const repository = released("v1.0.0");
  repository.migration(SECOND, 'ALTER TABLE "bookmarks" ADD COLUMN "name" text;', [{ name: "bookmarks", columns: [...BOOKMARKS, "name"] }]);
  repository.commit("expand");
  repository.tag("v1.1.0");
  repository.migration(THIRD, `${header}${sql}`, [{ name: "bookmarks", columns: ["id", "title", "name"] }]);
  return repository;
}
const HEADER = `-- slugbase:contract expand=${SECOND} release=1.1.0\n`;

describe("the marked contract half of an expand/contract pair", () => {
  it("accepts the drop with the header and the marker", async () => {
    expect(await inspect(pair(HEADER), true)).toEqual([]);
  });

  it("accepts a table-rewriting ADD COLUMN with the header and the marker, and rejects it with the header alone", async () => {
    const sql = 'ALTER TABLE "bookmarks" ADD COLUMN "n" bigserial NOT NULL;\n';
    expect(await inspect(pair(HEADER, sql), true)).toEqual([]);
    const findings = await inspect(pair(HEADER, sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(REWRITES);
    expect(findings[0]?.message).toContain(MARKER_HINT);
  });

  it("accepts a revocation on a table of the release with the header and the marker, and rejects it with the header alone", async () => {
    const sql = "REVOKE SELECT ON bookmarks FROM slugbase_app;\n";
    expect(await inspect(pair(HEADER, sql), true)).toEqual([]);
    const findings = await inspect(pair(HEADER, sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table bookmarks, which exists at v1.1.0");
    expect(findings[0]?.message).toContain(MARKER_HINT);
  });

  it("rejects a revocation on a table of the release without a header, whatever the marker says", async () => {
    const findings = await inspect(pair("", "REVOKE SELECT ON bookmarks FROM slugbase_app;\n"), true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it("accepts the release written with its v and a header after other comments", async () => {
    const header = `-- A note first.\n\n-- slugbase:contract expand=${SECOND} release=v1.1.0\n`;
    expect(await inspect(pair(header), true)).toEqual([]);
  });

  it("rejects the drop with the header alone", async () => {
    const findings = await inspect(pair(HEADER));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(MARKER_HINT);
    expect(findings[0]?.message).toContain("SLUGBASE_DB_CHECK_CONTRACT=true");
  });

  it("rejects the drop with the marker alone", async () => {
    const findings = await inspect(pair(""), true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("has no contract header");
    expect(findings[0]?.message).not.toContain(MARKER_HINT);
  });

  it("rejects the drop with neither", async () => {
    const findings = await inspect(pair(""));
    expect(findings[0]?.message).toContain("has no contract header");
    expect(findings[0]?.message).toContain(MARKER_HINT);
  });

  it.each([
    ["a malformed header", `-- slugbase:contract expand=${SECOND}\n`, "malformed contract header"],
    ["two headers", `-- slugbase:contract expand=${SECOND} release=1.1.0\n-- slugbase:contract expand=${SECOND} release=1.0.0\n`, "malformed contract header"],
    ["an expand migration the journal does not list", "-- slugbase:contract expand=20260101000001_nothing release=1.1.0\n", "not a migration of the journal"],
    ["a release that is not a tag", `-- slugbase:contract expand=${SECOND} release=9.9.9\n`, "release 9.9.9, which is not a release tag"],
    ["an expand migration that is not part of the named release", `-- slugbase:contract expand=${SECOND} release=1.0.0\n`, `${SECOND} is not part of that release`],
    ["a header after the first statement", `COMMENT ON TABLE bookmarks IS 'x';\n${HEADER}`, "has no contract header"],
    ["a header after a statement behind a lone carriage return", `-- note\rCOMMENT ON TABLE bookmarks IS 'x';\n${HEADER}`, "has no contract header"],
  ])("rejects %s even with the marker", async (_name, header, expected) => {
    const findings = await inspect(pair(header), true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(expected);
  });

  it("rejects a contract that is paired with itself", async () => {
    const findings = await inspect(pair(`-- slugbase:contract expand=${THIRD} release=1.1.0\n`), true);
    expect(findings[0]?.message).toContain(`${THIRD} is not part of that release`);
  });

  it("does not accept a timeout set in the file, with the header and the marker", async () => {
    const findings = await inspect(pair(HEADER, "SET lock_timeout = 0;\nALTER TABLE bookmarks DROP COLUMN legacy_title;\n"), true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("sets lock_timeout");
  });

  it("accepts a statement it cannot place only in the marked pair", async () => {
    const sql = "DO $$ BEGIN PERFORM 1; END $$;\n";
    expect(await inspect(pair(HEADER, sql))).toHaveLength(1);
    expect(await inspect(pair(HEADER, sql), true)).toEqual([]);
  });
});

describe("data-changing statements", () => {
  const DATA_HINT = "worker job";
  const STATEMENTS: [string, string, string][] = [
    ["an UPDATE that backfills a column of a table of the release", "UPDATE bookmarks SET title = lower(title);", "UPDATE"],
    ["an UPDATE in lower case with a schema-qualified table", "update public.bookmarks set title = 'x' where id = 1;", "UPDATE"],
    ["an UPDATE with ONLY and an alias", "UPDATE ONLY bookmarks AS b SET title = 'x';", "UPDATE"],
    ["a DELETE", "DELETE FROM bookmarks WHERE id = 1;", "DELETE"],
    ["a DELETE of every row", "delete from only bookmarks;", "DELETE"],
    ["a TRUNCATE", "TRUNCATE bookmarks;", "TRUNCATE"],
    ["a TRUNCATE TABLE with CASCADE", "TRUNCATE TABLE ONLY bookmarks, notes RESTART IDENTITY CASCADE;", "TRUNCATE"],
    ["an INSERT with values", "INSERT INTO bookmarks (id) VALUES (1);", "INSERT"],
    ["an INSERT ... SELECT", "INSERT INTO archive (id) SELECT id FROM bookmarks;", "INSERT"],
    ["an INSERT ... ON CONFLICT", "insert into bookmarks (id) values (1) on conflict do nothing;", "INSERT"],
    ["a MERGE", "MERGE INTO bookmarks b USING notes n ON b.id = n.id WHEN MATCHED THEN DELETE;", "MERGE"],
    ["a COPY ... FROM", "COPY bookmarks (id) FROM stdin;", "COPY"],
    ["a COPY ... FROM PROGRAM", "COPY bookmarks FROM PROGRAM 'cat x' WITH (FORMAT csv);", "COPY"],
    ["an UPDATE in a leading CTE", "WITH u AS (UPDATE bookmarks SET title = NULL RETURNING id) SELECT id FROM u;", "UPDATE"],
    ["a DELETE in a leading CTE", "WITH d AS (DELETE FROM bookmarks RETURNING id) SELECT count(*) FROM d;", "DELETE"],
    ["an INSERT in a leading CTE", "WITH s AS (SELECT id FROM bookmarks) INSERT INTO archive SELECT id FROM s;", "INSERT"],
    ["a DELETE in a CTE of a CREATE TABLE ... AS", "CREATE TABLE gone (id) AS WITH d AS (DELETE FROM bookmarks RETURNING id) SELECT id FROM d;", "DELETE"],
    ["an UPDATE in a CTE of a CREATE TABLE ... AS", "CREATE TABLE gone (id) AS WITH u AS (UPDATE bookmarks SET title = NULL RETURNING id) SELECT id FROM u;", "UPDATE"],
    ["a DELETE in the query of a COPY ... TO", "COPY (DELETE FROM bookmarks RETURNING id) TO stdout;", "DELETE"],
  ];

  it.each(STATEMENTS)("rejects %s, naming the file and the statement and pointing to a worker job", async (_name, sql, statement) => {
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${SECOND}.sql`);
    expect(findings[0]?.message).toContain(`changes data with ${statement}`);
    expect(findings[0]?.message).toContain(sql.replace(/;$/, ""));
    expect(findings[0]?.message).toContain(DATA_HINT);
    expect(findings[0]?.message).not.toContain("cannot place");
  });

  it("rejects the statement on a table created in the same migration, with no exception", async () => {
    const findings = await added('CREATE TABLE "kinds" ("id" uuid PRIMARY KEY);\nINSERT INTO "kinds" ("id") VALUES (\'a\');');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("changes data with INSERT");
  });

  it("rejects the backfill of a column that the same migration adds, beside the schema change", async () => {
    const findings = await added('ALTER TABLE "bookmarks" ADD COLUMN "name" text;\nUPDATE "bookmarks" SET "name" = "title";');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("changes data with UPDATE");
  });

  it("reports each data statement of a file", async () => {
    const findings = await added("UPDATE bookmarks SET title = 'x';\n--> statement-breakpoint\nDELETE FROM bookmarks;\n--> statement-breakpoint\nTRUNCATE bookmarks;");
    expect(findings.map((finding) => /changes data with (\w+)/.exec(finding.message)?.[1])).toEqual(["UPDATE", "DELETE", "TRUNCATE"]);
  });

  it("rejects it in a migration that no release holds, in a full clone without a release tag", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, "DELETE FROM bookmarks;", []);
    repository.commit("only commit");
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("changes data with DELETE");
  });

  it("does not take a column, a lock clause or a foreign key action for a data statement", async () => {
    const sql = [
      'ALTER TABLE "notes" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "bookmarks"("id") ON DELETE SET NULL ON UPDATE SET NULL NOT VALID;',
      'CREATE TABLE "logs" ("update" text, "delete" text, "insert" text, "copy" text);',
      "CREATE TRIGGER t BEFORE INSERT OR UPDATE OR DELETE ON bookmarks EXECUTE FUNCTION f();",
    ].join("\n");
    const findings = await added(sql);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
    expect(findings[0]?.message).not.toContain("changes data");
  });

  it("stays unknown for a data statement inside a DO block, which the reader cannot see", async () => {
    const findings = await added("DO $$ BEGIN DELETE FROM bookmarks; END $$;");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("cannot place");
  });

  it("does not analyse the body of a function, which runs only when the function is called", async () => {
    for (const sql of [
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM bookmarks; END $$;",
      "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM bookmarks $$;",
    ]) {
      expect(await added(sql)).toEqual([]);
    }
  });

  describe("in the marked contract half of an expand/contract pair", () => {
    function pair(sql: string): GitPackage {
      const repository = released("v1.0.0");
      repository.migration(SECOND, 'ALTER TABLE "bookmarks" ADD COLUMN "name" text;', [{ name: "bookmarks", columns: [...BOOKMARKS, "name"] }]);
      repository.commit("expand");
      repository.tag("v1.1.0");
      repository.migration(THIRD, `-- slugbase:contract expand=${SECOND} release=1.1.0\n${sql}`, [{ name: "bookmarks", columns: ["id", "title", "name"] }]);
      return repository;
    }

    it.each(STATEMENTS)("rejects %s with the header and the marker", async (_name, sql, statement) => {
      const findings = await inspect(pair(sql), true);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.object).toBe(`migrations/${THIRD}.sql`);
      expect(findings[0]?.message).toContain(`changes data with ${statement}`);
      expect(findings[0]?.message).toContain(DATA_HINT);
    });

    it("still accepts the contract drop beside nothing else, and rejects the data statement next to it", async () => {
      const sql = 'ALTER TABLE "bookmarks" DROP COLUMN "legacy_title";\nUPDATE "bookmarks" SET "name" = "title";';
      const findings = await inspect(pair(sql), true);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("changes data with UPDATE");
    });
  });
});

describe("the session timeouts", () => {
  it.each([
    ["SET lock_timeout = '5s';", "lock_timeout"],
    ["SET LOCAL statement_timeout TO 0;", "statement_timeout"],
    ["SELECT set_config('lock_timeout', '0', true);", "lock_timeout"],
    ["ALTER ROLE slugbase_app SET Statement_Timeout = 1;", "statement_timeout"],
    ["-- note\rSET lock_timeout = 0;", "lock_timeout"],
  ])("rejects a file that sets them: %s", async (sql, name) => {
    const findings = (await added(sql)).filter((finding) => finding.message.startsWith("sets "));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(`sets ${name}`);
    expect(findings[0]?.message).toContain("`migrate` sets lock_timeout and statement_timeout");
  });

  it("does not take a comment for a setting", async () => {
    expect(await added("-- migrate sets lock_timeout\nCOMMENT ON TABLE bookmarks IS 'x';")).toEqual([]);
  });
});

describe("the contract marker", () => {
  it("reads true, false, pending and an absent variable, and nothing else", () => {
    expect(contractMarkerFromEnv({ SLUGBASE_DB_CHECK_CONTRACT: "true" })).toBe("set");
    expect(contractMarkerFromEnv({ SLUGBASE_DB_CHECK_CONTRACT: "false" })).toBe("unset");
    expect(contractMarkerFromEnv({ SLUGBASE_DB_CHECK_CONTRACT: "pending" })).toBe("pending");
    expect(contractMarkerFromEnv({})).toBe("unset");
    expect(contractMarkerFromEnv({ SLUGBASE_DB_CHECK_CONTRACT: undefined })).toBe("unset");
  });

  it("refuses any other value instead of reading it as unset", () => {
    for (const value of ["", "1", "TRUE", "True", "yes", " true", "true ", "Pending", "awaiting"]) {
      expect(() => contractMarkerFromEnv({ SLUGBASE_DB_CHECK_CONTRACT: value }), JSON.stringify(value)).toThrow(
        "must be true, false or pending",
      );
    }
  });
});

describe("a push run, where the label cannot be read", () => {
  const failing = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => finding.awaiting !== true);

  it("reports a step with a valid header as awaiting the label, not as a failure", async () => {
    const findings = await inspect(pair(HEADER), "pending");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.awaiting).toBe(true);
    expect(findings[0]?.message).toContain("drops column bookmarks.legacy_title");
    expect(findings[0]?.message).toContain("awaits the migration:contract label");
    expect(failing(findings)).toEqual([]);
  });

  it("reports every problem of the step, not only the first", async () => {
    const sql = 'ALTER TABLE "bookmarks" DROP COLUMN "legacy_title";\nALTER TABLE "bookmarks" ADD COLUMN "n" bigserial;\n';
    const findings = await inspect(pair(HEADER, sql), "pending");
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.awaiting === true)).toBe(true);
  });

  it("fails a destructive step with no header", async () => {
    const findings = await inspect(pair(""), "pending");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.awaiting).toBeUndefined();
    expect(findings[0]?.message).toContain("has no contract header");
  });

  it.each([
    ["a malformed header", `-- slugbase:contract expand=${SECOND}\n`, "malformed contract header"],
    ["two headers", `-- slugbase:contract expand=${SECOND} release=1.1.0\n-- slugbase:contract expand=${SECOND} release=1.0.0\n`, "malformed contract header"],
    ["an expand migration the journal does not list", "-- slugbase:contract expand=20260101000001_nothing release=1.1.0\n", "not a migration of the journal"],
    ["a release that is not a tag", `-- slugbase:contract expand=${SECOND} release=9.9.9\n`, "which is not a release tag"],
    ["an expand migration that is not part of the named release", `-- slugbase:contract expand=${SECOND} release=1.0.0\n`, `${SECOND} is not part of that release`],
    ["a header after the first statement", `COMMENT ON TABLE bookmarks IS 'x';\n${HEADER}`, "has no contract header"],
  ])("fails %s", async (_name, header, expected) => {
    const findings = await inspect(pair(header), "pending");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.awaiting).toBeUndefined();
    expect(findings[0]?.message).toContain(expected);
  });

  it("does not let a valid header license a data change or a session timeout", async () => {
    const data = await inspect(pair(HEADER, 'ALTER TABLE "bookmarks" DROP COLUMN "legacy_title";\nUPDATE bookmarks SET title = \'x\';\n'), "pending");
    expect(failing(data)).toHaveLength(1);
    expect(failing(data)[0]?.message).toContain("changes data with");
    const timeout = await inspect(pair(HEADER, "SET lock_timeout = 0;\nALTER TABLE bookmarks DROP COLUMN legacy_title;\n"), "pending");
    expect(failing(timeout)).toHaveLength(1);
    expect(failing(timeout)[0]?.message).toContain("sets lock_timeout");
  });

  it("still names the marker as missing when the run carries none", async () => {
    const findings = await inspect(pair(HEADER), false);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.awaiting).toBeUndefined();
    expect(findings[0]?.message).toContain(MARKER_HINT);
  });
});

describe("the statement reader", () => {
  it("splits at top-level semicolons only and drops comments", () => {
    const statements = analyseSql("SELECT 'a;b'; -- x;\nSELECT $$c;d$$, \"e;f\"; /* g; /* h; */ i; */ SELECT 1");
    expect(statements.map((statement) => statement.text)).toEqual(["SELECT 'a;b'", 'SELECT $$c;d$$, "e;f"', "SELECT 1"]);
  });

  it("reads quoted names with their case", () => {
    const [statement] = analyseSql('ALTER TABLE "Mixed"."Table" DROP COLUMN "Col";');
    expect(statement?.operations).toEqual([{ kind: "drop-column", table: { schema: "Mixed", name: "Table" }, column: "Col" }]);
  });

  it("refuses text it cannot scan to the end", () => {
    expect(() => analyseSql("SELECT 'open")).toThrow("not closed");
    expect(() => analyseSql("SELECT $$open")).toThrow("not closed");
    expect(() => analyseSql("/* open")).toThrow("not closed");
    expect(() => analyseSql("CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT 1; END;")).toThrow("BEGIN ATOMIC");
    expect(() => setsSessionTimeout('SELECT "open')).toThrow("not closed");
  });

  it("ends a line comment at a lone carriage return, as PostgreSQL does", () => {
    expect(analyseSql("-- note\rALTER TABLE bookmarks DROP COLUMN title;").map((statement) => statement.text)).toEqual([
      "ALTER TABLE bookmarks DROP COLUMN title",
    ]);
    expect(analyseSql("-- note\r\nCOMMENT ON TABLE t IS 'x';").map((statement) => statement.text)).toEqual(["COMMENT ON TABLE t IS 'x'"]);
  });

  it("closes a nested block comment only at its outermost end", () => {
    const statements = analyseSql("/* a /* b */ c */ ALTER TABLE bookmarks DROP COLUMN title; /* d /* e */ ALTER TABLE bookmarks DROP COLUMN id; */");
    expect(statements.map((statement) => statement.text)).toEqual(["ALTER TABLE bookmarks DROP COLUMN title"]);
  });

  it("ends a standard string at its quote, whatever the backslash before it", () => {
    const statements = analyseSql("COMMENT ON TABLE bk IS 'a\\'; ALTER TABLE bk DROP COLUMN t3; --';");
    expect(statements.map((statement) => statement.text)).toEqual(["COMMENT ON TABLE bk IS 'a\\'", "ALTER TABLE bk DROP COLUMN t3"]);
    expect(statements[1]?.operations[0]?.kind).toBe("drop-column");
  });

  it("keeps an escape string, which a backslash can quote in, whole", () => {
    const statements = analyseSql("COMMENT ON TABLE bk IS E'it\\'s; DROP TABLE bk;';");
    expect(statements).toHaveLength(1);
    expect(statements[0]?.operations).toEqual([{ kind: "safe" }]);
  });

  it("closes a dollar-quoted string only at its own tag", () => {
    const statements = analyseSql("COMMENT ON TABLE bk IS $a$ x; DROP TABLE bk; $$ y $a$;");
    expect(statements).toHaveLength(1);
    expect(statements[0]?.operations).toEqual([{ kind: "safe" }]);
  });

  it("does not read names or text spelled with Unicode escapes", () => {
    expect(analyseSql('ALTER TABLE U&"b\\006Fokmarks" DROP COLUMN title;')[0]?.operations[0]?.kind).toBe("unknown");
    expect(analyseSql("COMMENT ON TABLE bk IS U&'\\0027';")[0]?.operations[0]?.kind).toBe("unknown");
    expect(analyseSql('COMMENT ON TABLE U&"b\\006Fokmarks" IS \'x\';')[0]?.operations[0]?.kind).toBe("unknown");
  });

  it("treats only PostgreSQL whitespace as whitespace", () => {
    expect(analyseSql("ALTER TABLE bookmarks \u00a0DROP COLUMN title;")[0]?.operations[0]?.kind).toBe("unknown");
  });

  it("reads the forms of the shipped migration and of drizzle-kit as safe", () => {
    const kinds = analyseSql(
      [
        "CREATE EXTENSION IF NOT EXISTS citext;",
        "CREATE OR REPLACE FUNCTION public.app_account_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;",
        'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "t" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "p" ON "t" AS PERMISSIVE FOR ALL TO "slugbase_app" USING (true);',
        'GRANT SELECT ON "t" TO slugbase_app;',
        "COMMENT ON TABLE t IS 'x';",
      ].join("\n"),
    ).flatMap((statement) => statement.operations.map((operation) => operation.kind));
    expect(kinds).toEqual(["safe", "declares-function", "safe", "safe", "safe", "safe", "safe"]);
  });

  it("places no operation of ALTER TABLE without an action or a name", () => {
    expect(analyseSql("ALTER TABLE bookmarks")[0]?.operations[0]?.kind).toBe("unknown");
    expect(analyseSql("ALTER TABLE")[0]?.operations[0]?.kind).toBe("unknown");
    expect(analyseSql("BEGIN")[0]?.operations[0]?.kind).toBe("unknown");
    expect(analyseSql("COPY t TO stdout")[0]?.operations[0]?.kind).toBe("unknown");
  });
});

// A custom-SQL step re-emits all of src/sql/ in every migration that changes it (doc 05 section 5.1), so the REVOKE statements of
// the release come back unchanged. The rule accepts a table REVOKE only inside the migration's own custom step and only when that
// step leaves the table the GRANT and REVOKE statements, in order, that the latest custom-SQL step of the release left it
// (doc 05 section 5.2).
describe("a custom-SQL step that re-emits the REVOKE statements of the release", () => {
  const BREAKPOINT = "\n--> statement-breakpoint\n";
  const HASH = "a".repeat(64);
  const REVOKE_BOOKMARKS = "REVOKE ALL ON TABLE public.bookmarks FROM PUBLIC, slugbase_app;";
  const TABLES = [
    { name: "bookmarks", columns: BOOKMARKS },
    { name: "notes", columns: ["id", "body"] },
  ];

  /** The statements a migration carries from src/sql/: the first starts with the marker, then one per file. */
  function customStep(...files: string[]): string {
    return files
      .map((body, index) => `${index === 0 ? `-- slugbase:custom-sql sha256=${HASH}\n` : ""}-- src/sql/${String(index * 10 + 10).padStart(3, "0")}-file.sql\n${body}`)
      .join(BREAKPOINT);
  }

  /** A repository whose release holds `bookmarks` and `notes` and the given first migration. */
  function releasedWith(firstMigration: string): GitPackage {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, firstMigration, TABLES);
    repository.commit("first release");
    repository.tag("v1.0.0");
    return repository;
  }

  const CREATE = 'CREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY, "title" text, "legacy_title" text);\n--> statement-breakpoint\nCREATE TABLE "notes" ("id" uuid PRIMARY KEY, "body" text);';

  /** The release's custom step holds REVOKE_BOOKMARKS; `reEmit` is the custom step of the migration added after it. */
  async function reEmitted(reEmit: string, release = customStep(REVOKE_BOOKMARKS), marker?: boolean | "pending"): Promise<readonly Finding[]> {
    const repository = releasedWith(`${CREATE}${BREAKPOINT}${release}`);
    repository.migration(SECOND, reEmit, TABLES);
    return inspect(repository, marker);
  }

  it("accepts a re-emit of the same src/sql without a contract header", async () => {
    expect(await reEmitted(customStep(REVOKE_BOOKMARKS))).toEqual([]);
  });

  it("accepts it under every contract marker", async () => {
    expect(await reEmitted(customStep(REVOKE_BOOKMARKS), customStep(REVOKE_BOOKMARKS), true)).toEqual([]);
    expect(await reEmitted(customStep(REVOKE_BOOKMARKS), customStep(REVOKE_BOOKMARKS), "pending")).toEqual([]);
  });

  it("rejects a new REVOKE on a table of the release beside the re-emitted ones, naming only the new one", async () => {
    const findings = await reEmitted(customStep(REVOKE_BOOKMARKS, "REVOKE ALL ON TABLE public.notes FROM PUBLIC, slugbase_app;"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${SECOND}.sql`);
    expect(findings[0]?.message).toContain("revokes privileges on table notes, which exists at v1.0.0");
    expect(findings[0]?.message).toContain(MARKER_HINT);
  });

  it("accepts a re-emit that moves the statement to another file or adds a GRANT on another table", async () => {
    const reEmit = customStep("GRANT SELECT ON TABLE public.notes TO slugbase_app;", REVOKE_BOOKMARKS);
    expect(await reEmitted(reEmit)).toEqual([]);
  });

  it("compares the statement with its whitespace and line breaks normalised", async () => {
    expect(await reEmitted(customStep("REVOKE   ALL\n  ON TABLE public.bookmarks\n  FROM PUBLIC,\n       slugbase_app;"))).toEqual([]);
  });

  it("accepts the statement when the release wrote it in several lines and the re-emit in one", async () => {
    expect(await reEmitted(customStep(REVOKE_BOOKMARKS), customStep("REVOKE ALL ON TABLE public.bookmarks\n  FROM PUBLIC, slugbase_app;"))).toEqual([]);
  });

  it.each([
    ["other privileges", "REVOKE SELECT ON TABLE public.bookmarks FROM PUBLIC, slugbase_app;"],
    ["other roles", "REVOKE ALL ON TABLE public.bookmarks FROM PUBLIC;"],
    ["another spelling of the table", "REVOKE ALL ON TABLE bookmarks FROM PUBLIC, slugbase_app;"],
    ["another letter case", "revoke all on table public.bookmarks from public, slugbase_app;"],
    ["a column list", "REVOKE ALL (title) ON TABLE public.bookmarks FROM PUBLIC, slugbase_app;"],
    ["CASCADE", "REVOKE ALL ON TABLE public.bookmarks FROM PUBLIC, slugbase_app CASCADE;"],
  ])("rejects a REVOKE that differs from the release's in %s", async (_label, statement) => {
    const findings = await reEmitted(customStep(statement));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table bookmarks, which exists at v1.0.0");
  });

  describe("when a GRANT follows the REVOKE in the release", () => {
    const GRANT_BOOKMARKS = "GRANT SELECT, INSERT ON TABLE public.bookmarks TO slugbase_app;";
    const release = customStep(`${REVOKE_BOOKMARKS}\n${GRANT_BOOKMARKS}`);

    it("accepts the unchanged pair", async () => {
      expect(await reEmitted(release, release)).toEqual([]);
    });

    it("rejects a re-emit that drops the GRANT, which would leave the table without the access the release granted", async () => {
      const findings = await reEmitted(customStep(REVOKE_BOOKMARKS), release);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("revokes privileges on table bookmarks, which exists at v1.0.0");
      expect(findings[0]?.message).toContain(MARKER_HINT);
    });

    it("rejects a re-emit that puts the GRANT before the REVOKE", async () => {
      const findings = await reEmitted(customStep(`${GRANT_BOOKMARKS}\n${REVOKE_BOOKMARKS}`), release);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("revokes privileges on table bookmarks");
    });

    it("rejects a re-emit that changes the GRANT", async () => {
      const findings = await reEmitted(customStep(`${REVOKE_BOOKMARKS}\nGRANT SELECT ON TABLE public.bookmarks TO slugbase_app;`), release);
      expect(findings).toHaveLength(1);
    });

    it("rejects a re-emit that adds a GRANT on the table in another file", async () => {
      const findings = await reEmitted(customStep(`${REVOKE_BOOKMARKS}\n${GRANT_BOOKMARKS}`, "GRANT DELETE ON TABLE public.bookmarks TO slugbase_app;"), release);
      expect(findings).toHaveLength(1);
    });

    it("rejects a re-emit that adds a GRANT on every table of the schema", async () => {
      const findings = await reEmitted(customStep(`${REVOKE_BOOKMARKS}\n${GRANT_BOOKMARKS}`, "GRANT SELECT ON ALL TABLES IN SCHEMA public TO slugbase_app;"), release);
      expect(findings).toHaveLength(1);
    });

    it("rejects a re-emit when the GRANT is one the check does not read", async () => {
      const unread = "GRANT SELECT ON TABLE public.bookmarks TO slugbase_app GRANTED BY slugbase_owner;";
      const findings = await reEmitted(customStep(`${REVOKE_BOOKMARKS}\n${unread}`), customStep(`${REVOKE_BOOKMARKS}\n${unread}`));
      expect(findings.some((finding) => finding.message.includes("revokes privileges on table bookmarks"))).toBe(true);
    });
  });

  describe("when the matching REVOKE is not in the migration's custom step", () => {
    it("rejects it in a migration that has no custom step", async () => {
      const findings = await reEmitted(REVOKE_BOOKMARKS);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("revokes privileges on table bookmarks, which exists at v1.0.0");
    });

    it("rejects it in the schema statements before the custom step, which holds the same statement", async () => {
      const findings = await reEmitted(`${REVOKE_BOOKMARKS}${BREAKPOINT}${customStep(REVOKE_BOOKMARKS)}`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("revokes privileges on table bookmarks");
    });
  });

  it("compares a statement with a quoted name as written", async () => {
    const quoted = 'REVOKE ALL ON TABLE public."bookmarks" FROM PUBLIC, slugbase_app;';
    expect(await reEmitted(customStep(quoted), customStep(quoted))).toEqual([]);
    const findings = await reEmitted(customStep('REVOKE ALL ON TABLE public."bookmarks"  FROM PUBLIC, slugbase_app;'), customStep(quoted));
    expect(findings).toHaveLength(1);
  });

  it("rejects a REVOKE on a table of the release that the release's custom step does not hold", async () => {
    const findings = await reEmitted(customStep("REVOKE ALL ON TABLE public.notes FROM PUBLIC, slugbase_app;"), customStep(REVOKE_BOOKMARKS));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table notes, which exists at v1.0.0");
  });

  it("reads the latest custom step of the release, not an earlier one", async () => {
    const repository = releasedWith(`${CREATE}${BREAKPOINT}${customStep(REVOKE_BOOKMARKS)}`);
    repository.migration("20260115000000_change_sql", customStep("GRANT SELECT ON TABLE public.bookmarks TO slugbase_app;"), TABLES);
    repository.commit("second release step");
    repository.tag("v1.1.0");
    repository.migration(SECOND, customStep(REVOKE_BOOKMARKS), TABLES);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table bookmarks, which exists at v1.1.0");
  });

  it("reads the release from git, not from the working tree", async () => {
    const repository = releasedWith(`${CREATE}${BREAKPOINT}${customStep(REVOKE_BOOKMARKS)}`);
    repository.migration(SECOND, customStep(REVOKE_BOOKMARKS), TABLES);
    repository.write(customStep("GRANT SELECT ON TABLE public.bookmarks TO slugbase_app;"), "migrations", `${FIRST}.sql`);
    expect(await inspect(repository)).toEqual([]);
  });

  it("does not count a REVOKE of the release outside its custom step", async () => {
    const findings = await reEmitted(customStep(REVOKE_BOOKMARKS), `${REVOKE_BOOKMARKS}${BREAKPOINT}${customStep("GRANT SELECT ON TABLE public.notes TO slugbase_app;")}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table bookmarks");
  });

  it("rejects the statement when the release holds no custom step", async () => {
    const repository = releasedWith(`${CREATE}\n--> statement-breakpoint\n${REVOKE_BOOKMARKS}`);
    repository.migration(SECOND, customStep(REVOKE_BOOKMARKS), TABLES);
    const findings = await inspect(repository);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table bookmarks");
  });

  it("flags nothing while the repository has no release tag", async () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, `${CREATE}${BREAKPOINT}${customStep(REVOKE_BOOKMARKS)}`, TABLES);
    expect(await inspect(repository)).toEqual([]);
  });

  it("still rejects a REVOKE on a schema or on every table of a schema that the release also holds", async () => {
    const statements = ["REVOKE USAGE ON SCHEMA public FROM slugbase_app;", "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM slugbase_app;"];
    for (const statement of statements) {
      const findings = await reEmitted(customStep(statement), customStep(statement));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("revokes privileges on a schema, sequence, database or every object of a kind");
    }
  });

  it("does not let an identical statement hide a second one in the same text", async () => {
    const findings = await reEmitted(customStep(`${REVOKE_BOOKMARKS}\nREVOKE ALL ON TABLE public.notes FROM PUBLIC, slugbase_app;`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table notes");
  });

  it("still holds a statement between GRANT CREATE ON SCHEMA and its REVOKE to the function statements", async () => {
    const reEmit = customStep(`GRANT CREATE ON SCHEMA public TO slugbase_system;\n${REVOKE_BOOKMARKS}\nREVOKE CREATE ON SCHEMA public FROM slugbase_system;`);
    const findings = await reEmitted(reEmit);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("between GRANT CREATE ON SCHEMA");
  });
});
