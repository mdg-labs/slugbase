import { afterAll, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { expandContractRule } from "../../src/check/expand-contract.ts";
import { analyseSql, createdTableOf } from "../../src/check/migration-statements.ts";
import { readReleaseState } from "../../src/check/release-history.ts";
import type { Finding } from "../../src/check/types.ts";
import { FIRST, GitPackage, SECOND } from "./git-package.ts";

// A table that only custom SQL creates (src/sql/, UNLOGGED for instance, which the Drizzle schema cannot express) is not in
// the drizzle snapshot of the release, so the rule used to see no table there. The release state now holds it too (doc 05
// section 5.2), and a REVOKE on, a drop of or a change to such a table is judged as it is for a table of the schema.

const BREAKPOINT = "\n--> statement-breakpoint\n";
const HASH = "a".repeat(64);
const HEADER = `-- slugbase:contract expand=${FIRST} release=1.0.0`;
const BUCKETS = "public.rate_limit_buckets";
const SNAPSHOT = [{ name: "bookmarks", columns: ["id", "title"] }];
const CREATE_BOOKMARKS = 'CREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY, "title" text);';
const CREATE_BUCKETS = `CREATE UNLOGGED TABLE IF NOT EXISTS ${BUCKETS} (
  key text PRIMARY KEY,
  tokens real NOT NULL,
  updated_at timestamptz NOT NULL
);`;
const GRANT_SYSTEM = `GRANT SELECT, INSERT, UPDATE ON TABLE ${BUCKETS} TO slugbase_system;`;
const REVOKE_PUBLIC = `REVOKE ALL ON TABLE ${BUCKETS} FROM PUBLIC, slugbase_app;`;
const REVOKE_SYSTEM = `REVOKE ALL ON TABLE ${BUCKETS} FROM slugbase_system;`;
const NO_HEADER = "has no contract header";

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

/** The custom SQL of the release: the table, the privileges the release left it. */
const RELEASE_FILE = `${CREATE_BUCKETS}\n${REVOKE_PUBLIC}\n${GRANT_SYSTEM}`;

/** A repository whose release v1.0.0 holds `bookmarks` in its snapshot and `rate_limit_buckets` only in its custom SQL. */
function released(releaseFile = RELEASE_FILE): GitPackage {
  const repository = new GitPackage();
  repositories.push(repository);
  repository.migration(FIRST, `${CREATE_BOOKMARKS}${BREAKPOINT}${customStep(releaseFile)}`, SNAPSHOT);
  repository.commit("first release");
  repository.tag("v1.0.0");
  return repository;
}

function inspect(repository: GitPackage): Promise<readonly Finding[]> {
  return Promise.resolve(expandContractRule.run({ packageDir: repository.dir, sql: undefined, hashSqlFiles }));
}

/** What the rule says about the migration added after the release. */
async function added(sql: string, releaseFile?: string): Promise<readonly Finding[]> {
  const repository = released(releaseFile);
  repository.migration(SECOND, sql, SNAPSHOT);
  return inspect(repository);
}

describe("the failure scenario: a privilege change on a table only custom SQL creates", () => {
  it("rejects a REVOKE that takes slugbase_system's access away, naming the table, the migration and the release", async () => {
    // The added REVOKE changes the statements on the table, so the release's own REVOKE in the same step is no longer a repeat either (#543).
    const findings = await added(customStep(RELEASE_FILE, REVOKE_SYSTEM));
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.rule).toBe("expand-contract");
      expect(finding.object).toBe(`migrations/${SECOND}.sql`);
      expect(finding.message).toContain("revokes privileges on table rate_limit_buckets, which exists at v1.0.0");
      expect(finding.message).toContain(NO_HEADER);
    }
  });

  it("rejects the release's GRANT deleted from the re-emit, since the REVOKE then leaves the table other privileges", async () => {
    const release = `${CREATE_BUCKETS}\n${GRANT_SYSTEM}\n${REVOKE_PUBLIC}`;
    const findings = await added(customStep(`${CREATE_BUCKETS}\n${REVOKE_PUBLIC}`), release);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table rate_limit_buckets, which exists at v1.0.0");
  });

  it("rejects the REVOKE when it stands outside the migration's custom step", async () => {
    const findings = await added(`${REVOKE_PUBLIC}${BREAKPOINT}${customStep(RELEASE_FILE)}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("revokes privileges on table rate_limit_buckets");
  });

  it("accepts an unchanged re-emit without a contract header", async () => {
    expect(await added(customStep(RELEASE_FILE))).toEqual([]);
  });

  it("accepts a re-emit that only lays the statements out differently", async () => {
    const reEmit = `-- the buckets\nCREATE   UNLOGGED TABLE IF NOT EXISTS public.rate_limit_buckets (key text PRIMARY KEY, /* the balance */ tokens real NOT NULL, updated_at timestamptz NOT NULL);\nREVOKE ALL ON TABLE public.rate_limit_buckets\n  FROM PUBLIC, slugbase_app;\nGRANT SELECT, INSERT, UPDATE ON TABLE public.rate_limit_buckets TO slugbase_system;`;
    expect(await added(customStep(reEmit))).toEqual([]);
  });

  it("accepts the REVOKE with the release's GRANT order kept, in the release that already holds it", async () => {
    const release = `${CREATE_BUCKETS}\n${GRANT_SYSTEM}\n${REVOKE_PUBLIC}`;
    expect(await added(customStep(release), release)).toEqual([]);
  });

  it("accepts it in the contract half with a header, and rejects it without one", async () => {
    const bare = await added(customStep(RELEASE_FILE, REVOKE_SYSTEM));
    expect(bare).toHaveLength(2);
    expect(bare.every((finding) => finding.message.includes(NO_HEADER))).toBe(true);
    expect(await added(marked(RELEASE_FILE, REVOKE_SYSTEM))).toEqual([]);
  });
});

describe("what else is judged on a table only custom SQL creates", () => {
  it.each([
    ["dropping the table", `DROP TABLE ${BUCKETS};`, "drops table rate_limit_buckets, which exists at v1.0.0"],
    ["dropping a column", `ALTER TABLE ${BUCKETS} DROP COLUMN tokens;`, "drops column rate_limit_buckets.tokens, which exists at v1.0.0"],
    ["renaming a column", `ALTER TABLE ${BUCKETS} RENAME COLUMN tokens TO balance;`, "renames column rate_limit_buckets.tokens to balance"],
    ["renaming the table", `ALTER TABLE ${BUCKETS} RENAME TO buckets;`, "renames table rate_limit_buckets to buckets"],
    ["adding a NOT NULL column without a default", `ALTER TABLE ${BUCKETS} ADD COLUMN burst real NOT NULL;`, "adds column rate_limit_buckets.burst as NOT NULL without a default"],
    ["setting a column NOT NULL", `ALTER TABLE ${BUCKETS} ALTER COLUMN tokens SET NOT NULL;`, "sets column rate_limit_buckets.tokens NOT NULL"],
    ["creating an index without CONCURRENTLY", `CREATE INDEX ON ${BUCKETS} (updated_at);`, "creates an index on table rate_limit_buckets, which exists at v1.0.0, without CONCURRENTLY"],
    ["revoking on the table", REVOKE_SYSTEM, "revokes privileges on table rate_limit_buckets, which exists at v1.0.0"],
  ])("rejects %s", async (_label, statement, message) => {
    const findings = await added(`${statement}${BREAKPOINT}${customStep(RELEASE_FILE)}`);
    expect(findings.map((finding) => finding.message).join("\n")).toContain(message);
  });

  it("accepts adding a nullable column and a concurrent index, as for a table of the schema", async () => {
    expect(await added(`ALTER TABLE ${BUCKETS} ADD COLUMN burst real;${BREAKPOINT}${customStep(RELEASE_FILE)}`)).toEqual([]);
    expect(await added(`CREATE INDEX CONCURRENTLY ON ${BUCKETS} (updated_at);${BREAKPOINT}${customStep(RELEASE_FILE)}`)).toEqual([]);
  });

  it("holds the columns that the release's own custom step adds, drops and renames", async () => {
    const release = `${CREATE_BUCKETS}\nALTER TABLE ${BUCKETS} ADD COLUMN IF NOT EXISTS burst real;\nALTER TABLE ${BUCKETS} DROP COLUMN updated_at;\nALTER TABLE ${BUCKETS} RENAME COLUMN tokens TO balance;`;
    const state = readReleaseState(released(release).dir, "v1.0.0");
    expect(state.tables.find((table) => table.name === "rate_limit_buckets")?.columns).toEqual(["key", "balance", "burst"]);
    const findings = await added(`ALTER TABLE ${BUCKETS} DROP COLUMN burst;${BREAKPOINT}${customStep(release)}`, release);
    expect(findings.map((finding) => finding.message).join("\n")).toContain("drops column rate_limit_buckets.burst");
  });

  it("drops a table the release's custom step drops again from the release state", () => {
    const release = `${CREATE_BUCKETS}\nDROP TABLE ${BUCKETS};`;
    expect(readReleaseState(released(release).dir, "v1.0.0").tables.map((table) => table.name)).toEqual(["bookmarks"]);
  });

  it("does not hold the table of the snapshot twice when custom SQL creates it too", () => {
    const state = readReleaseState(released("CREATE TABLE IF NOT EXISTS public.bookmarks (id uuid);").dir, "v1.0.0");
    expect(state.tables.filter((table) => table.name === "bookmarks")).toEqual([{ schema: "public", name: "bookmarks", columns: ["id", "title"] }]);
  });

  it("does not hold a table that a migration added since the release creates", async () => {
    const repository = released();
    repository.migration(SECOND, `CREATE TABLE IF NOT EXISTS public.other (id uuid);${BREAKPOINT}${customStep(RELEASE_FILE, "REVOKE ALL ON TABLE public.other FROM PUBLIC;")}`, SNAPSHOT);
    expect(await inspect(repository)).toEqual([]);
  });
});

describe("a re-emitted CREATE TABLE of a table of the release", () => {
  it("rejects a column list that differs from the one the release created the table with, which an existing table ignores", async () => {
    const reEmit = RELEASE_FILE.replace("tokens real NOT NULL", "tokens double precision NOT NULL");
    const findings = await added(customStep(reEmit));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("creates table rate_limit_buckets again with a column list other than the one the custom SQL of v1.0.0 created it with");
    expect(findings[0]?.message).toContain(NO_HEADER);
  });

  it("rejects an added column in the list", async () => {
    const findings = await added(customStep(RELEASE_FILE.replace("updated_at timestamptz NOT NULL", "updated_at timestamptz NOT NULL,\n  burst real")));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("creates table rate_limit_buckets again with a column list other than");
  });

  it("accepts the changed list in the marked contract half that also drops the column", async () => {
    const reEmit = RELEASE_FILE.replace(",\n  tokens real NOT NULL", "");
    const step = marked(reEmit, `ALTER TABLE ${BUCKETS} DROP COLUMN IF EXISTS tokens;`);
    expect(await added(step)).toEqual([]);
  });

  it("accepts the same list when it stands in the schema statements", async () => {
    expect(await added(`${CREATE_BUCKETS}${BREAKPOINT}${customStep(RELEASE_FILE)}`)).toEqual([]);
  });
});

describe("a release whose custom step the reader cannot place", () => {
  it.each([
    ["a LIKE clause", "CREATE TABLE public.copy (LIKE public.bookmarks);"],
    ["CREATE TABLE AS", "CREATE TABLE public.copy AS SELECT 1 AS one;"],
    ["a list item without a name", "CREATE TABLE public.copy (a int, );"],
  ])("fails the rule for a table created with %s, since the release then holds a table it cannot show", async (_label, statement) => {
    const repository = released(statement);
    repository.migration(SECOND, customStep(statement), SNAPSHOT);
    await expect(inspect(repository)).rejects.toThrow("creates a table this check cannot read");
  });

  it("fails the rule for a chunk that may create a table and cannot be scanned", async () => {
    const repository = released("CREATE TABLE public.copy (a int); /* open");
    repository.migration(SECOND, customStep(RELEASE_FILE), SNAPSHOT);
    await expect(inspect(repository)).rejects.toThrow("may create a table and cannot be scanned");
  });

  it("skips a chunk that creates no table and cannot be scanned", () => {
    const release = `${RELEASE_FILE}${BREAKPOINT}-- src/sql/990-open.sql\nSELECT 1; /* open`;
    const repository = released(release);
    repository.migration(SECOND, customStep(RELEASE_FILE), SNAPSHOT);
    expect(readReleaseState(repository.dir, "v1.0.0").tables.map((table) => table.name)).toEqual(["bookmarks", "rate_limit_buckets"]);
  });

  it("reads a release with no custom step as holding the tables of its snapshot", () => {
    const repository = new GitPackage();
    repositories.push(repository);
    repository.migration(FIRST, CREATE_BOOKMARKS, SNAPSHOT);
    repository.commit("first release");
    repository.tag("v1.0.0");
    expect(readReleaseState(repository.dir, "v1.0.0").tables).toEqual([{ schema: "public", name: "bookmarks", columns: ["id", "title"] }]);
  });

  it("reads the release from git, not from the working tree", async () => {
    const repository = released();
    repository.migration(SECOND, customStep(RELEASE_FILE), SNAPSHOT);
    repository.write(customStep("SELECT 1;"), "migrations", `${FIRST}.sql`);
    expect(await inspect(repository)).toEqual([]);
    expect(readReleaseState(repository.dir, "v1.0.0").tables.map((table) => table.name)).toContain("rate_limit_buckets");
  });
});

describe("the CREATE TABLE reader", () => {
  const read = (sql: string): ReturnType<typeof createdTableOf> => createdTableOf(analyseSql(sql)[0] ?? { text: "", operations: [] });

  it("names the table and the columns of the list, and leaves the table constraints out", () => {
    const created = read(
      `CREATE UNLOGGED TABLE IF NOT EXISTS app."Odd Table" (a int, "B c" text DEFAULT 'x,y', d numeric(10, 2), CONSTRAINT k PRIMARY KEY (a, d), UNIQUE (a), CHECK (a > 0));`,
    );
    expect(created).toMatchObject({ kind: "read", table: { schema: "app", name: "Odd Table" }, columns: ["a", "B c", "d"] });
  });

  it("gives the same definition for two layouts of one list and another for another list", () => {
    const first = read("CREATE TABLE t (a int,\n  b text -- note\n);");
    const second = read("create table t ( a int , b text )");
    const third = read("CREATE TABLE t (a int, b varchar);");
    expect(first?.kind === "read" && second?.kind === "read" && third?.kind === "read" ? [first.definition === second.definition, first.definition === third.definition] : []).toEqual([true, false]);
  });

  it("is undefined for other statements and for a temporary table", () => {
    expect(read("CREATE INDEX i ON t (a);")).toBeUndefined();
    expect(read("CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1';")).toBeUndefined();
    expect(read("CREATE TEMP TABLE t (a int);")).toBeUndefined();
    expect(read("ALTER TABLE t ADD COLUMN a int;")).toBeUndefined();
  });

  it("reads the list of a table whose statement the rule judges as unreadable for another reason", () => {
    expect(read("CREATE TABLE t (a uuid DEFAULT gen_random_uuid()) INHERITS (p);")).toMatchObject({ kind: "read", columns: ["a"] });
  });
});
