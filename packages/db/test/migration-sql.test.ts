import { describe, expect, it } from "vitest";
import {
  customSqlStatements,
  hashSqlFiles,
  isNonTransactional,
  joinStatements,
  nonTransactional,
  rewriteIndexesConcurrently,
  splitStatements,
  tablesOfSnapshot,
} from "../scripts/migration-sql.ts";

const existing = new Set(["public.accounts", "cloud.widgets"]);

describe("rewriteIndexesConcurrently", () => {
  it("rewrites an index on a table of an earlier migration and moves it out of the transaction", () => {
    const result = rewriteIndexesConcurrently(
      'CREATE INDEX "accounts_email_idx" ON "accounts" USING btree ("email");',
      existing,
    );
    expect(result.transactional).toEqual([]);
    expect(result.concurrent).toEqual([
      'CREATE INDEX CONCURRENTLY "accounts_email_idx" ON "accounts" USING btree ("email");',
    ]);
  });

  it("keeps an index on a table the same migration creates inside the transaction", () => {
    const sql = [
      'CREATE TABLE "things" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);',
      'CREATE INDEX "things_id_idx" ON "things" USING btree ("id");',
    ].join("\n--> statement-breakpoint\n");
    const result = rewriteIndexesConcurrently(sql, existing);
    expect(result.concurrent).toEqual([]);
    expect(result.transactional).toHaveLength(2);
    expect(result.transactional[1]).toBe('CREATE INDEX "things_id_idx" ON "things" USING btree ("id");');
  });

  it("handles unique indexes, a schema-qualified table and statements joined without a newline", () => {
    const sql =
      'ALTER TABLE "accounts" ADD COLUMN "n" text;--> statement-breakpoint\n' +
      'CREATE UNIQUE INDEX "accounts_n_key" ON "public"."accounts" USING btree ("n");--> statement-breakpoint\n' +
      'CREATE INDEX "widgets_n_idx" ON "cloud"."widgets" USING btree ("n");';
    const result = rewriteIndexesConcurrently(sql, existing);
    expect(result.transactional).toEqual(['ALTER TABLE "accounts" ADD COLUMN "n" text;']);
    expect(result.concurrent).toEqual([
      'CREATE UNIQUE INDEX CONCURRENTLY "accounts_n_key" ON "public"."accounts" USING btree ("n");',
      'CREATE INDEX CONCURRENTLY "widgets_n_idx" ON "cloud"."widgets" USING btree ("n");',
    ]);
  });

  it("does not treat a table in another schema with the same name as an existing one", () => {
    const result = rewriteIndexesConcurrently('CREATE INDEX "x" ON "cloud"."accounts" ("a");', existing);
    expect(result.concurrent).toEqual([]);
    expect(result.transactional).toHaveLength(1);
  });

  it("accepts unquoted names, IF NOT EXISTS, ONLY and an unnamed index", () => {
    const sql = [
      "create index if not exists accounts_a_idx on only accounts (a);",
      "CREATE INDEX ON ACCOUNTS (b);",
    ].join("\n--> statement-breakpoint\n");
    const result = rewriteIndexesConcurrently(sql, existing);
    expect(result.transactional).toEqual([]);
    expect(result.concurrent).toEqual([
      "create index CONCURRENTLY if not exists accounts_a_idx on only accounts (a);",
      "CREATE INDEX CONCURRENTLY ON ACCOUNTS (b);",
    ]);
  });

  it("moves an index that is already concurrent without rewriting it twice", () => {
    const sql = 'CREATE INDEX CONCURRENTLY "x" ON "things" ("a");';
    expect(rewriteIndexesConcurrently(sql, existing)).toEqual({ transactional: [], concurrent: [sql] });
  });

  it("leaves other statements alone, including a column that mentions an index", () => {
    const sql = [
      'ALTER TABLE "accounts" ADD COLUMN "create_index_at" timestamp with time zone;',
      'DROP INDEX "accounts_old_idx";',
      'ALTER TABLE "accounts" ADD CONSTRAINT "accounts_a_key" UNIQUE("a");',
    ].join("\n--> statement-breakpoint\n");
    const result = rewriteIndexesConcurrently(sql, existing);
    expect(result.concurrent).toEqual([]);
    expect(result.transactional).toHaveLength(3);
  });

  it("keeps the order of the statements that stay", () => {
    const sql = ["SELECT 1;", 'CREATE INDEX "a" ON "accounts" ("a");', "SELECT 2;"].join(
      "\n--> statement-breakpoint\n",
    );
    expect(rewriteIndexesConcurrently(sql, existing).transactional).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("returns nothing for an empty migration", () => {
    expect(rewriteIndexesConcurrently("", existing)).toEqual({ transactional: [], concurrent: [] });
  });
});

describe("tablesOfSnapshot", () => {
  it("lists the tables as schema.table, with the public schema for an empty one", () => {
    const snapshot = {
      tables: {
        "public.accounts": { name: "accounts", schema: "" },
        "cloud.widgets": { name: "widgets", schema: "cloud" },
      },
    };
    expect(tablesOfSnapshot(snapshot)).toEqual(new Set(["public.accounts", "cloud.widgets"]));
  });

  it("rejects a snapshot it cannot read instead of returning an empty set", () => {
    expect(() => tablesOfSnapshot({})).toThrow("tables");
    expect(() => tablesOfSnapshot(null)).toThrow("tables");
    expect(() => tablesOfSnapshot({ tables: { a: { schema: "" } } })).toThrow("without a name");
  });
});

describe("statement files", () => {
  it("splits on the breakpoint and joins back to the same statements", () => {
    const statements = ["A;", "B;\nC;"];
    expect(splitStatements(joinStatements(statements))).toEqual(statements);
    expect(joinStatements([])).toBe("");
  });

  it("marks a non-transactional file on its first line only", () => {
    const file = nonTransactional(['CREATE INDEX CONCURRENTLY "x" ON "t" ("a");']);
    expect(isNonTransactional(file)).toBe(true);
    expect(splitStatements(file)[0]).toContain("-- slugbase:non-transactional");
    expect(isNonTransactional(`SELECT 1;\n${file}`)).toBe(false);
    expect(isNonTransactional("SELECT 1;\n")).toBe(false);
  });
});

describe("custom SQL", () => {
  const second = { name: "020-b.sql", content: "SELECT 2;\n" };
  const first = { name: "010-a.sql", content: "SELECT 1;\n" };
  const files = [second, first];

  it("hashes the files by name and content, whatever order they come in", () => {
    expect(hashSqlFiles(files)).toBe(hashSqlFiles([...files].reverse()));
    expect(hashSqlFiles(files)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the hash when a file's content, a file's name or the set of files changes", () => {
    const base = hashSqlFiles(files);
    expect(hashSqlFiles([{ name: "020-b.sql", content: "SELECT 3;\n" }, first])).not.toBe(base);
    expect(hashSqlFiles([{ name: "030-b.sql", content: "SELECT 2;\n" }, first])).not.toBe(base);
    expect(hashSqlFiles([second])).not.toBe(base);
  });

  it("ignores the line ending of a checkout", () => {
    expect(hashSqlFiles([{ name: "a.sql", content: "SELECT 1;\r\nSELECT 2;\r\n" }])).toBe(
      hashSqlFiles([{ name: "a.sql", content: "SELECT 1;\nSELECT 2;\n" }]),
    );
  });

  it("emits one statement per file in name order, the first carrying the marker and the hash", () => {
    const statements = customSqlStatements(files);
    expect(statements).toEqual([
      `-- slugbase:custom-sql sha256=${hashSqlFiles(files)}\n-- src/sql/010-a.sql\nSELECT 1;`,
      "-- src/sql/020-b.sql\nSELECT 2;",
    ]);
  });
});
