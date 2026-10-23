import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { checksumsRule } from "../../src/check/checksums.ts";
import { customSqlRule } from "../../src/check/custom-sql.ts";
import { driftRule } from "../../src/check/drift.ts";
import { checkRules, formatReport, recordChecksums, runChecks } from "../../src/check/index.ts";
import { ownershipRule } from "../../src/check/ownership.ts";
import { rlsRule } from "../../src/check/rls.ts";
import type { CheckContext, CheckRule } from "../../src/check/types.ts";
import { PackageCopy, PACKAGE } from "./package-copy.ts";

// The rules that read the migrations folder, driven with copies of the package,
// and the runner that turns a rule that could not run into a failure. The rules
// that read the database are driven in db-check.integration.test.ts.

const TIMEOUT_MS = 120_000;
const THINGS_SCHEMA = `import { pgTable, text, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey(), name: text() });
`;

const copies: PackageCopy[] = [];
let copy: PackageCopy;

beforeEach(() => {
  copy = new PackageCopy();
  copies.push(copy);
});

afterAll(() => {
  for (const each of copies) {
    each.remove();
  }
});

function context(packageDir: string): CheckContext {
  return { packageDir, sql: undefined, hashSqlFiles };
}

describe("the shipped migrations", () => {
  it("pass the rules that read the folder", async () => {
    for (const rule of [checksumsRule, customSqlRule, driftRule]) {
      expect(await rule.run(context(PACKAGE)), rule.id).toEqual([]);
    }
  }, TIMEOUT_MS);
});

describe("migration-checksums", () => {
  it("fails with the name of a migration edited after it was recorded", async () => {
    const tag = copy.firstMigrationTag();
    copy.write(`${copy.read("migrations", `${tag}.sql`)}\nDROP TABLE bookmarks;\n`, "migrations", `${tag}.sql`);
    const findings = await checksumsRule.run(context(copy.dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe(`migrations/${tag}.sql`);
    expect(findings[0]?.message).toContain("changed after it was recorded");
  });

  it("fails with the name of a migration that has no recorded checksum", async () => {
    const tag = copy.firstMigrationTag();
    const journal = JSON.parse(copy.read("migrations", "meta", "_journal.json")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const next = "20261012000000_add_things";
    journal.entries.push({ idx: 1, when: (journal.entries[0]?.when ?? 0) + 1, tag: next });
    copy.write(JSON.stringify(journal), "migrations", "meta", "_journal.json");
    copy.write('CREATE TABLE "things" ("id" uuid PRIMARY KEY);\n', "migrations", `${next}.sql`);
    const findings = await checksumsRule.run(context(copy.dir));
    expect(findings.map((finding) => finding.object)).toEqual([`migrations/${next}.sql`]);
    expect(findings[0]?.message).toContain("pnpm db:record-checksums");

    expect(recordChecksums(copy.dir)).toEqual([next]);
    expect(await checksumsRule.run(context(copy.dir))).toEqual([]);
    expect(tag).not.toBe(next);
  });

  it("never rewrites an entry that exists when recording", () => {
    const tag = copy.firstMigrationTag();
    const before = copy.read("src", "check", "migration-checksums.json");
    copy.write(`${copy.read("migrations", `${tag}.sql`)}\n-- edited\n`, "migrations", `${tag}.sql`);
    expect(recordChecksums(copy.dir)).toEqual([]);
    expect(copy.read("src", "check", "migration-checksums.json")).toBe(before);
  });

  it("fails for a migration file the journal does not list and for a checksum without a file", async () => {
    copy.write("SELECT 1;\n", "migrations", "20261012000000_add_orphan.sql");
    const manifest = JSON.parse(copy.read("src", "check", "migration-checksums.json")) as {
      migrations: Record<string, string>;
    };
    manifest.migrations["20261012000001_add_gone"] = "0".repeat(64);
    copy.write(JSON.stringify(manifest), "src", "check", "migration-checksums.json");
    const findings = await checksumsRule.run(context(copy.dir));
    expect(findings.map((finding) => finding.object).sort()).toEqual([
      "migrations/20261012000000_add_orphan.sql",
      "migrations/20261012000001_add_gone.sql",
    ]);
  });

  it("rejects a malformed checksum file", () => {
    copy.write(JSON.stringify({ migrations: { [copy.firstMigrationTag()]: "abc" } }), "src", "check", "migration-checksums.json");
    expect(() => checksumsRule.run(context(copy.dir))).toThrow("holds no sha256");
  });
});

describe("custom-sql-hash", () => {
  it("fails when src/sql changed without a new custom step", async () => {
    copy.write("CREATE OR REPLACE FUNCTION public.extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n", "src", "sql", "030-extra.sql");
    const findings = await customSqlRule.run(context(copy.dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe("src/sql");
    expect(findings[0]?.message).toContain("changed since");
  });

  it("fails when the record does not name the last custom step", async () => {
    copy.write(JSON.stringify({ sha256: "0".repeat(64), migration: copy.firstMigrationTag() }), "migrations", "meta", "_custom-sql.json");
    const findings = await customSqlRule.run(context(copy.dir));
    expect(findings.map((finding) => finding.object)).toEqual(["migrations/meta/_custom-sql.json"]);
  });
});

describe("schema-drift", () => {
  it("fails with the statements of a schema change that has no migration", async () => {
    copy.schema(THINGS_SCHEMA);
    const before = copy.read("migrations", "meta", "_journal.json");
    const findings = await driftRule.run(context(copy.dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe("src/schema");
    expect(findings[0]?.message).toContain('CREATE TABLE "things"');
    expect(copy.read("migrations", "meta", "_journal.json")).toBe(before);
  }, TIMEOUT_MS);

  it("fails when the schema does not load, although drizzle-kit exits 0", async () => {
    copy.schema('import { nothing } from "./does-not-exist.ts";\nexport { nothing };\n');
    const findings = await driftRule.run(context(copy.dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("did not confirm");
  }, TIMEOUT_MS);

  it("fails when a snapshot is malformed", async () => {
    copy.write("{", "migrations", "meta", "20261011134302_snapshot.json");
    const findings = await driftRule.run(context(copy.dir));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.object).toBe("migrations/meta");
  }, TIMEOUT_MS);
});

describe("runChecks", () => {
  it("turns a rule that throws into a failure of that rule", async () => {
    const broken: CheckRule = {
      id: "broken",
      description: "never looks",
      run: () => Promise.reject(new Error("boom")),
    };
    const results = await runChecks([broken], context(copy.dir));
    expect(results[0]?.findings).toEqual([{ rule: "broken", object: "broken", message: "the rule could not run: boom" }]);
    expect(formatReport(results).passed).toBe(false);
  });

  it("fails the rules that read the database when there is no connection", async () => {
    const results = await runChecks([rlsRule, ownershipRule], context(PACKAGE));
    expect(results.map((result) => result.findings.length)).toEqual([1, 1]);
    expect(results[0]?.findings[0]?.message).toContain("no database connection");
  });

  it("registers every rule once, under its own id", () => {
    const ids = checkRules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["rls-forced", "app-owns-nothing", "migration-checksums", "schema-drift", "custom-sql-hash", "system-operations", "purge-registry", "expand-contract"]);
  });

  it("reports a pass only when every rule found nothing", () => {
    const passed = formatReport([{ rule: "a", description: "", findings: [] }]);
    expect(passed).toEqual({ passed: true, lines: ["db:check: ok    a", "db:check: 1 rule(s) passed"] });
    const failed = formatReport([{ rule: "a", description: "", findings: [{ rule: "a", object: "x", message: "bad" }] }]);
    expect(failed.passed).toBe(false);
    expect(failed.lines).toContain("db:check: FAIL  a: x: bad");
  });

  it("counts a rule with several findings once, prints every finding, and fails the run", () => {
    const report = formatReport([
      {
        rule: "a",
        description: "",
        findings: [
          { rule: "a", object: "x", message: "first" },
          { rule: "a", object: "y", message: "bad" },
        ],
      },
      { rule: "b", description: "", findings: [] },
    ]);
    expect(report.passed).toBe(false);
    expect(report.lines).toEqual(["db:check: FAIL  a: x: first", "db:check: FAIL  a: y: bad", "db:check: ok    b", "db:check: 1 of 2 rule(s) failed"]);
  });
});
