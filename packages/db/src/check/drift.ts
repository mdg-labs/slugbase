import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitStatements } from "../migrate.ts";
import type { CheckRule, Finding } from "./types.ts";

// Doc 05 section 5.1: regenerating from the schema produces no new migration.
// drizzle-kit exits 0 after errors it catches (a schema file that does not
// load, a malformed snapshot), so its verdict is the sentence it prints, never
// its exit code. It runs against a copy of migrations/, so a diff writes
// nothing into the package.

const ID = "schema-drift";
const CHECK_OK = "Everything's fine";
const NO_CHANGES = "No schema changes, nothing to migrate";
const RUN_TIMEOUT_MS = 120_000;
const MAX_OBJECTS = 5;

function drizzleKit(packageDir: string, cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(packageDir, "node_modules", "drizzle-kit", "bin.cjs"), ...args, "--config", "drizzle.config.mjs"],
      { cwd, encoding: "utf8", timeout: RUN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        // A non-zero exit still prints the verdict, which is what is judged.
        if (error !== null && (error.killed || error.code === "ENOENT")) {
          reject(new Error(`drizzle-kit ${args.join(" ")} did not finish: ${error.message}`));
          return;
        }
        resolve(`${stdout}${stderr}`);
      },
    );
    child.stdin?.end();
  });
}

function addedStatements(before: ReadonlySet<string>, dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !before.has(name))
    .flatMap((name) => splitStatements(readFileSync(join(dir, name), "utf8")))
    .map((statement) => statement.split("\n", 1)[0] ?? statement);
}

export const driftRule: CheckRule = {
  id: ID,
  description: "drizzle-kit reports no pending diff between src/schema/ and the migrations",
  async run({ packageDir }) {
    if (!existsSync(join(packageDir, "migrations", "meta"))) {
      throw new Error("migrations/meta does not exist");
    }
    const work = mkdtempSync(join(tmpdir(), "slugbase-db-check-"));
    try {
      const copy = join(work, "migrations");
      cpSync(join(packageDir, "migrations"), copy, { recursive: true });
      const before = new Set(readdirSync(copy));
      writeFileSync(
        join(work, "drizzle.config.mjs"),
        `export default ${JSON.stringify({
          dialect: "postgresql",
          schema: join(packageDir, "src", "schema", "index.ts"),
          out: "./migrations",
          casing: "snake_case",
          migrations: { schema: "drizzle", table: "migrations_core", prefix: "timestamp" },
        })};\n`,
      );
      const findings: Finding[] = [];
      const checked = await drizzleKit(packageDir, work, ["check"]);
      if (!checked.includes(CHECK_OK)) {
        findings.push({
          rule: ID,
          object: "migrations/meta",
          message: `drizzle-kit does not accept the snapshots: ${checked.trim()}`,
        });
        return findings;
      }
      const generated = await drizzleKit(packageDir, work, ["generate", "--name", "unnamed_schema_change"]);
      if (generated.includes(NO_CHANGES)) {
        return findings;
      }
      const statements = addedStatements(before, copy);
      if (statements.length > 0) {
        findings.push({
          rule: ID,
          object: "src/schema",
          message: `has changes no migration holds (${statements.slice(0, MAX_OBJECTS).join("; ")}${statements.length > MAX_OBJECTS ? "; ..." : ""}): run pnpm db:generate`,
        });
      } else {
        findings.push({
          rule: ID,
          object: "src/schema",
          message: `drizzle-kit did not confirm that the schema and the migrations agree: ${generated.trim()}`,
        });
      }
      return findings;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};
