import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements } from "../migrate.ts";
import { readJournal, readMigration } from "./migration-files.ts";
import type { CheckRule, Finding } from "./types.ts";

// Doc 05 section 5.1: the declarative SQL of src/sql/ reaches the database as a
// custom step of a migration, which starts with `-- slugbase:custom-sql
// sha256=<hash of src/sql/>`. The hash in the last such step must be the hash
// of the files as they are now, and meta/_custom-sql.json must name that step.

const ID = "custom-sql-hash";
const MARKER = /^-- slugbase:custom-sql sha256=([0-9a-f]{64})\b/;

interface CustomStep {
  tag: string;
  sha256: string;
}

function lastCustomStep(packageDir: string): CustomStep | undefined {
  let last: CustomStep | undefined;
  for (const { tag } of readJournal(packageDir)) {
    const content = readMigration(packageDir, tag);
    if (content === undefined) {
      throw new Error(`migration file ${tag}.sql listed in the journal cannot be read`);
    }
    for (const statement of splitStatements(content)) {
      const sha256 = MARKER.exec(statement)?.[1];
      if (sha256 !== undefined) {
        last = { tag, sha256 };
      }
    }
  }
  return last;
}

function readRecord(packageDir: string): Partial<CustomStep> | undefined {
  const file = join(packageDir, "migrations", "meta", "_custom-sql.json");
  if (!existsSync(file)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("migrations/meta/_custom-sql.json is not an object");
  }
  return {
    ...("sha256" in parsed && typeof parsed.sha256 === "string" ? { sha256: parsed.sha256 } : {}),
    ...("migration" in parsed && typeof parsed.migration === "string" ? { tag: parsed.migration } : {}),
  };
}

export const customSqlRule: CheckRule = {
  id: ID,
  description: "the hash of src/sql/ equals the one of the last custom step of the migrations",
  run({ packageDir, hashSqlFiles }) {
    const dir = join(packageDir, "src", "sql");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
    const current = files.length === 0 ? undefined : hashSqlFiles(files);
    const step = lastCustomStep(packageDir);
    const record = readRecord(packageDir);
    const findings: Finding[] = [];
    if (current !== undefined && step === undefined) {
      findings.push({ rule: ID, object: "src/sql", message: "holds SQL files but no migration carries them: run pnpm db:generate" });
    } else if (current !== undefined && step !== undefined && step.sha256 !== current) {
      findings.push({
        rule: ID,
        object: "src/sql",
        message: `changed since migrations/${step.tag}.sql carried it (step ${step.sha256.slice(0, 12)}, files ${current.slice(0, 12)}): run pnpm db:generate`,
      });
    }
    if (step !== undefined && (record?.sha256 !== step.sha256 || record.tag !== step.tag)) {
      findings.push({
        rule: ID,
        object: "migrations/meta/_custom-sql.json",
        message: `does not name the last custom step (migrations/${step.tag}.sql, sha256 ${step.sha256.slice(0, 12)})`,
      });
    }
    return findings;
  },
};
