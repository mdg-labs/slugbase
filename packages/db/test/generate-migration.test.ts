import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashSqlFiles, isNonTransactional } from "../scripts/migration-sql.ts";

// Runs `pnpm db:generate` (scripts/generate-migration.ts) against a copy of the
// package, so a test can edit the SQL files and the schema freely.

const PACKAGE = new URL("..", import.meta.url).pathname;
const SCRIPT = join(PACKAGE, "scripts", "generate-migration.ts");
const RUN_TIMEOUT_MS = 120_000;

const EMPTY_SCHEMA = "export {};\n";
const THINGS_SCHEMA = `import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey(), name: text(), kind: text() }, (t) => [
  index("things_name_idx").on(t.name),
]);
`;
const THINGS_WITH_KIND_INDEX_SCHEMA = `import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey(), name: text(), kind: text() }, (t) => [
  index("things_name_idx").on(t.name),
  index("things_kind_idx").on(t.kind),
]);
`;
const THINGS_WITH_NOTE_SCHEMA = `import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey(), name: text(), kind: text(), note: text() }, (t) => [
  index("things_name_idx").on(t.name),
  index("things_kind_idx").on(t.kind),
  index("things_note_idx").on(t.note),
]);
`;

const THINGS_WITH_TWO_NEW_INDEXES_SCHEMA = `import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey(), name: text(), kind: text() }, (t) => [
  index("things_name_idx").on(t.name),
  index("things_kind_idx").on(t.kind),
  index("things_kind_name_idx").on(t.kind, t.name),
]);
`;

const THINGS_WITHOUT_KIND_SCHEMA = `import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey(), name: text() }, (t) => [
  index("things_name_idx").on(t.name),
]);
`;

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readTree(dir: string, base = dir, tree = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) {
    return tree;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      readTree(path, base, tree);
    } else {
      tree.set(path.slice(base.length + 1), readFileSync(path, "utf8"));
    }
  }
  return tree;
}

interface Journal {
  entries: { tag: string; when: number }[];
}

class Copy {
  readonly dir = mkdtempSync(join(tmpdir(), "slugbase-db-generate-"));

  constructor() {
    scratch.push(this.dir);
    symlinkSync(join(PACKAGE, "node_modules"), join(this.dir, "node_modules"));
    cpSync(join(PACKAGE, "drizzle.config.ts"), join(this.dir, "drizzle.config.ts"));
    cpSync(join(PACKAGE, "src", "sql"), join(this.dir, "src", "sql"), { recursive: true });
    cpSync(join(PACKAGE, "migrations"), join(this.dir, "migrations"), { recursive: true });
    this.schema(EMPTY_SCHEMA);
  }

  schema(source: string): void {
    mkdirSync(join(this.dir, "src", "schema"), { recursive: true });
    writeFileSync(join(this.dir, "src", "schema", "index.ts"), source);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  migrations(): Map<string, string> {
    return readTree(this.path("migrations"));
  }

  journal(): Journal {
    return JSON.parse(readFileSync(this.path("migrations", "meta", "_journal.json"), "utf8")) as Journal;
  }

  generate(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [SCRIPT, "--package", this.dir, ...args], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
    if (result.error) {
      throw result.error;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
}

let copy: Copy;

beforeEach(() => {
  copy = new Copy();
});

describe("committed migrations", () => {
  it("record the hash of the current src/sql files", () => {
    const dir = join(PACKAGE, "src", "sql");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
    const record = JSON.parse(readFileSync(join(PACKAGE, "migrations", "meta", "_custom-sql.json"), "utf8")) as {
      sha256: string;
      migration: string;
    };
    expect(record.sha256).toBe(hashSqlFiles(files));
    const migration = readFileSync(join(PACKAGE, "migrations", `${record.migration}.sql`), "utf8");
    expect(migration).toContain(`-- slugbase:custom-sql sha256=${record.sha256}`);
    for (const file of files) {
      expect(migration).toContain(file.content.trim());
    }
    expect(isNonTransactional(migration)).toBe(false);
  });

  it("carry the extensions and the two tenant functions of src/sql", () => {
    const [first] = copy.journal().entries;
    const migration = copy.migrations().get(`${first?.tag ?? ""}.sql`) ?? "";
    for (const extension of ["citext", "pg_trgm", "btree_gin"]) {
      expect(migration).toContain(`CREATE EXTENSION IF NOT EXISTS ${extension};`);
    }
    expect(migration).toContain("nullif(current_setting('app.workspace_id', true), '')::uuid");
    expect(migration).toContain("nullif(current_setting('app.account_id', true), '')::uuid");
    expect(migration).toMatch(/app_workspace_id\(\) RETURNS uuid\s+LANGUAGE sql STABLE/);
    expect(migration).toMatch(/app_account_id\(\) RETURNS uuid\s+LANGUAGE sql STABLE/);
  });
});

describe("pnpm db:generate", () => {
  it("writes nothing when neither the schema nor src/sql changed, however often it runs", () => {
    const before = copy.migrations();
    for (let run = 0; run < 2; run += 1) {
      const result = copy.generate();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("up to date");
      expect(copy.migrations()).toEqual(before);
    }
  }, RUN_TIMEOUT_MS * 2);

  it("emits an edited SQL file as a new migration and leaves every earlier migration byte for byte", () => {
    const before = copy.migrations();
    const sqlFile = copy.path("src", "sql", "020-tenant-context.sql");
    writeFileSync(sqlFile, `${readFileSync(sqlFile, "utf8")}\nCOMMENT ON FUNCTION public.app_account_id() IS 'account of the request';\n`);

    const result = copy.generate();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const after = copy.migrations();
    for (const [path, content] of before) {
      if (path !== join("meta", "_journal.json") && path !== join("meta", "_custom-sql.json")) {
        expect(after.get(path), path).toBe(content);
      }
    }
    const added = [...after.keys()].filter((path) => !before.has(path)).sort();
    expect(added).toHaveLength(2);
    const migrationFile = added.find((path) => !path.startsWith("meta"));
    expect(migrationFile).toMatch(/^\d{14}_add_sql_definitions\.sql$/);
    expect(added.find((path) => path.startsWith("meta"))).toMatch(/^meta[/\\]\d{14}_snapshot\.json$/);

    const created = after.get(migrationFile ?? "") ?? "";
    expect(created).toContain("-- slugbase:custom-sql sha256=");
    expect(created).toContain("COMMENT ON FUNCTION public.app_account_id()");
    expect(created).toContain("CREATE EXTENSION IF NOT EXISTS citext;");
    expect(isNonTransactional(created)).toBe(false);

    const entries = copy.journal().entries;
    expect(JSON.stringify(entries.slice(0, 1))).toBe(
      JSON.stringify((JSON.parse(before.get(join("meta", "_journal.json")) ?? "") as Journal).entries),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]?.tag).toBe(migrationFile?.replace(/\.sql$/, ""));

    const afterSecondRun = copy.generate();
    expect(afterSecondRun.stdout).toContain("up to date");
    expect(copy.migrations()).toEqual(after);
  }, RUN_TIMEOUT_MS * 2);

  it("appends the SQL step to the migration of a schema change and does so once", () => {
    copy.schema(THINGS_SCHEMA);
    const sqlFile = copy.path("src", "sql", "010-extensions.sql");
    writeFileSync(sqlFile, `${readFileSync(sqlFile, "utf8")}CREATE EXTENSION IF NOT EXISTS unaccent;\n`);

    const result = copy.generate("--name", "add_things");
    expect(result.status).toBe(0);
    const tag = copy.journal().entries[1]?.tag ?? "";
    expect(tag).toMatch(/^\d{14}_add_things$/);
    const migration = copy.migrations().get(`${tag}.sql`) ?? "";
    expect(migration).toContain('CREATE TABLE "things"');
    expect(migration).toContain('CREATE INDEX "things_name_idx" ON "things"');
    expect(migration).not.toContain("CONCURRENTLY");
    expect(migration.indexOf("CREATE TABLE")).toBeLessThan(migration.indexOf("-- slugbase:custom-sql"));
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS unaccent;");
    expect(isNonTransactional(migration)).toBe(false);
    expect(copy.journal().entries).toHaveLength(2);

    expect(copy.generate().stdout).toContain("up to date");
  }, RUN_TIMEOUT_MS * 2);

  it("writes an index on a table of an earlier migration as one non-transactional migration under the given name", () => {
    copy.schema(THINGS_SCHEMA);
    expect(copy.generate("--name", "add_things").status).toBe(0);
    copy.schema(THINGS_WITH_KIND_INDEX_SCHEMA);
    expect(copy.generate("--name", "index_things_kind").status).toBe(0);

    const entries = copy.journal().entries;
    expect(entries).toHaveLength(3);
    const migrations = copy.migrations();
    expect(migrations.get(`${entries[2]?.tag ?? ""}.sql`)).toBe(
      '-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "things_kind_idx" ON "things" USING btree ("kind");\n',
    );
    expect(migrations.get(`${entries[1]?.tag ?? ""}.sql`)).not.toContain("CONCURRENTLY");
    expect(copy.generate().stdout).toContain("up to date");
  }, RUN_TIMEOUT_MS * 3);

  it("splits a column and its index on an existing table into a transactional and a non-transactional migration", () => {
    copy.schema(THINGS_SCHEMA);
    expect(copy.generate("--name", "add_things").status).toBe(0);
    copy.schema(THINGS_WITH_KIND_INDEX_SCHEMA);
    expect(copy.generate("--name", "index_things_kind").status).toBe(0);
    copy.schema(THINGS_WITH_NOTE_SCHEMA);
    const result = copy.generate("--name", "add_note");
    expect(result.status).toBe(0);

    const entries = copy.journal().entries;
    expect(entries.map((entry) => entry.tag.slice(15))).toEqual([
      "add_extensions_and_tenant_functions",
      "add_things",
      "index_things_kind",
      "add_note",
      "index_note",
    ]);
    const [, , , column, index] = entries;
    expect(index?.when).toBeGreaterThan(column?.when ?? Number.POSITIVE_INFINITY);
    expect((index?.tag ?? "") > (column?.tag ?? "")).toBe(true);

    const migrations = copy.migrations();
    const columnSql = migrations.get(`${column?.tag ?? ""}.sql`) ?? "";
    const indexSql = migrations.get(`${index?.tag ?? ""}.sql`) ?? "";
    expect(columnSql).toBe('ALTER TABLE "things" ADD COLUMN "note" text;\n');
    expect(isNonTransactional(columnSql)).toBe(false);
    expect(indexSql).toBe(
      '-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "things_note_idx" ON "things" USING btree ("note");\n',
    );
    expect(isNonTransactional(indexSql)).toBe(true);
    expect(copy.generate().stdout).toContain("up to date");
  }, RUN_TIMEOUT_MS * 4);

  it("writes each of several new indexes on an existing table as a non-transactional migration of its own", () => {
    copy.schema(THINGS_SCHEMA);
    expect(copy.generate("--name", "add_things").status).toBe(0);
    copy.schema(THINGS_WITH_TWO_NEW_INDEXES_SCHEMA);
    const result = copy.generate("--name", "index_things_lookup");
    expect(result.status).toBe(0);

    const entries = copy.journal().entries;
    expect(entries.map((entry) => entry.tag.slice(15))).toEqual([
      "add_extensions_and_tenant_functions",
      "add_things",
      "index_things_lookup",
      "index_things_lookup_2",
    ]);
    expect(entries.map((entry) => entry.when)).toEqual([...entries.map((entry) => entry.when)].sort((a, b) => a - b));
    const [, , first, second] = entries;
    // Added entries are a millisecond apart, so they stay within milliseconds of drizzle-kit's timestamp.
    expect((second?.when ?? 0) - (first?.when ?? 0)).toBe(1);
    expect(new Set(entries.map((entry) => entry.tag)).size).toBe(entries.length);

    const migrations = copy.migrations();
    expect(migrations.get(`${first?.tag ?? ""}.sql`)).toBe(
      '-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "things_kind_idx" ON "things" USING btree ("kind");\n',
    );
    expect(migrations.get(`${second?.tag ?? ""}.sql`)).toBe(
      '-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "things_kind_name_idx" ON "things" USING btree ("kind","name");\n',
    );
    expect(result.stdout).toContain(`wrote ${first?.tag ?? ""}.sql (non-transactional)`);
    expect(result.stdout).toContain(`wrote ${second?.tag ?? ""}.sql (non-transactional)`);
    expect(copy.generate().stdout).toContain("up to date");
  }, RUN_TIMEOUT_MS * 3);

  it("splits a column and two indexes on an existing table into one transactional and two non-transactional migrations", () => {
    copy.schema(THINGS_SCHEMA);
    expect(copy.generate("--name", "add_things").status).toBe(0);
    copy.schema(THINGS_WITH_NOTE_SCHEMA);
    const result = copy.generate("--name", "add_note");
    expect(result.status).toBe(0);

    const entries = copy.journal().entries;
    expect(entries.map((entry) => entry.tag.slice(15))).toEqual([
      "add_extensions_and_tenant_functions",
      "add_things",
      "add_note",
      "index_note",
      "index_note_2",
    ]);
    const [, , column, first, second] = entries;
    expect(first?.when).toBeGreaterThan(column?.when ?? Number.POSITIVE_INFINITY);
    expect(second?.when).toBeGreaterThan(first?.when ?? Number.POSITIVE_INFINITY);

    const migrations = copy.migrations();
    const columnSql = migrations.get(`${column?.tag ?? ""}.sql`) ?? "";
    expect(columnSql).toBe('ALTER TABLE "things" ADD COLUMN "note" text;\n');
    expect(isNonTransactional(columnSql)).toBe(false);
    expect(migrations.get(`${first?.tag ?? ""}.sql`)).toBe(
      '-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "things_kind_idx" ON "things" USING btree ("kind");\n',
    );
    expect(migrations.get(`${second?.tag ?? ""}.sql`)).toBe(
      '-- slugbase:non-transactional\nCREATE INDEX CONCURRENTLY "things_note_idx" ON "things" USING btree ("note");\n',
    );
    expect(copy.generate().stdout).toContain("up to date");
  }, RUN_TIMEOUT_MS * 3);

  it("restores the migrations folder when drizzle-kit dates its migration no later than the last journal entry", () => {
    const journalFile = copy.path("migrations", "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as Journal;
    const last = journal.entries.at(-1);
    if (last === undefined) {
      throw new Error("the committed journal is empty");
    }
    last.when = Date.now() + 3_600_000;
    writeFileSync(journalFile, JSON.stringify(journal, null, 2));
    copy.schema(THINGS_SCHEMA);
    const before = copy.migrations();

    const result = copy.generate("--name", "add_things");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migrate would refuse the journal");
    expect(result.stderr).toContain("restored");
    expect(copy.migrations()).toEqual(before);
  }, RUN_TIMEOUT_MS);

  it("restores the migrations folder when drizzle-kit has written files but the run cannot finish", () => {
    copy.schema(THINGS_SCHEMA);
    const before = copy.migrations();
    const result = copy.generate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pass --name");
    expect(result.stderr).toContain("restored");
    expect(copy.migrations()).toEqual(before);
  }, RUN_TIMEOUT_MS);

  it("restores the migrations folder when drizzle-kit fails", () => {
    copy.schema("export const broken = ;\n");
    const before = copy.migrations();
    const result = copy.generate("--name", "add_broken");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected");
    expect(copy.migrations()).toEqual(before);
  }, RUN_TIMEOUT_MS);

  it("rejects a name outside add_, index_ and drop_ before it touches anything", () => {
    const before = copy.migrations();
    const result = copy.generate("--name", "Rename Things");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("add_, index_ or drop_");
    expect(copy.migrations()).toEqual(before);
  });

  it("fails and leaves the folder alone when src/sql holds no SQL file", () => {
    rmSync(copy.path("src", "sql"), { recursive: true });
    mkdirSync(copy.path("src", "sql"));
    const before = copy.migrations();
    const result = copy.generate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds no .sql file");
    expect(copy.migrations()).toEqual(before);
  });

  describe("--contract", () => {
    const RELEASE = "1.2.0";

    /** A copy holding the add_things migration, whose tag is the expand migration of a contract step. */
    function withThings(): string {
      copy.schema(THINGS_WITH_KIND_INDEX_SCHEMA);
      expect(copy.generate("--name", "add_things").status).toBe(0);
      return copy.journal().entries.at(-1)?.tag ?? "";
    }

    const leadingComment = (content: string): string[] => {
      const lines = content.split("\n");
      return lines.slice(0, lines.findIndex((line) => !line.startsWith("--")));
    };

    it("writes the header at the top of the migration of a drop, which the recorded checksum then covers", () => {
      const expand = withThings();
      copy.schema(THINGS_WITHOUT_KIND_SCHEMA);
      const result = copy.generate("--name", "drop_kind", "--contract", `expand=${expand}`, `release=${RELEASE}`);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const entries = copy.journal().entries;
      const migration = copy.migrations().get(`${entries.at(-1)?.tag ?? ""}.sql`) ?? "";
      expect(migration.startsWith(`-- slugbase:contract expand=${expand} release=${RELEASE}\n`)).toBe(true);
      expect(migration).toContain('DROP COLUMN "kind"');
      expect(copy.generate().stdout).toContain("up to date");
    }, RUN_TIMEOUT_MS * 3);

    it("keeps the header in the leading comment block of a file that starts with the custom SQL step", () => {
      const expand = withThings();
      const sqlFile = copy.path("src", "sql", "020-tenant-context.sql");
      writeFileSync(sqlFile, `${readFileSync(sqlFile, "utf8")}\nCOMMENT ON FUNCTION public.app_account_id() IS 'account of the request';\n`);
      const result = copy.generate("--contract", `expand=${expand}`, `release=v${RELEASE}`);
      expect(result.status).toBe(0);

      const migration = copy.migrations().get(`${copy.journal().entries.at(-1)?.tag ?? ""}.sql`) ?? "";
      expect(migration.startsWith("-- slugbase:custom-sql sha256=")).toBe(true);
      expect(leadingComment(migration)).toContain(`-- slugbase:contract expand=${expand} release=v${RELEASE}`);
      expect(migration.indexOf("-- slugbase:contract")).toBeLessThan(migration.indexOf("CREATE EXTENSION"));
      expect(copy.generate().stdout).toContain("up to date");
    }, RUN_TIMEOUT_MS * 3);

    it("rejects a run that writes only an index build, and writes nothing", () => {
      const expand = withThings();
      copy.schema(THINGS_WITH_TWO_NEW_INDEXES_SCHEMA);
      const before = copy.migrations();
      const result = copy.generate("--name", "index_things_kind_name", "--contract", `expand=${expand}`, `release=${RELEASE}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no migration that can hold a contract step");
      expect(copy.migrations()).toEqual(before);
    }, RUN_TIMEOUT_MS * 3);

    it("rejects a run that has nothing to write", () => {
      const expand = copy.journal().entries[0]?.tag ?? "";
      const before = copy.migrations();
      const result = copy.generate("--contract", `expand=${expand}`, `release=${RELEASE}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no migration that can hold a contract step");
      expect(copy.migrations()).toEqual(before);
    }, RUN_TIMEOUT_MS);

    it("rejects an expand migration the journal does not list, and writes nothing", () => {
      copy.schema(THINGS_SCHEMA);
      const before = copy.migrations();
      const result = copy.generate("--name", "add_things", "--contract", "expand=20260101000001_nothing", `release=${RELEASE}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not a migration of the journal");
      expect(copy.migrations()).toEqual(before);
    }, RUN_TIMEOUT_MS);

    it.each([
      ["no values", []],
      ["no release", ["expand=20260101000001_x"]],
      ["the values swapped", [`release=${RELEASE}`, "expand=20260101000001_x"]],
      ["an expand without a timestamp", ["expand=add_things", `release=${RELEASE}`]],
      ["a release that is not a version", ["expand=20260101000001_x", "release=latest"]],
      ["a release with two parts", ["expand=20260101000001_x", "release=1.2"]],
      ["a header line smuggled into the release", ["expand=20260101000001_x", "release=1.2.0\n-- other"]],
    ])("rejects %s before it touches anything", (_name, values) => {
      const before = copy.migrations();
      const result = copy.generate("--contract", ...values);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--contract takes expand=");
      expect(copy.migrations()).toEqual(before);
    });
  });
});
