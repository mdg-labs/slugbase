import { resolve } from "node:path";
import { checkRules, contractMarkerFromEnv, formatReport, runChecks, type ContractMarker, type RuleResult } from "../src/check/index.ts";
import { withTestDatabase } from "../src/testing.ts";
import { hashSqlFiles } from "./migration-sql.ts";

// `pnpm db:check` (doc 08 section 3.4): applies the CE chain to a fresh
// database of the test harness (a `test_*` clone of the migration template, on
// the server of SLUGBASE_TEST_PG_URL, the development Postgres by default),
// runs every rule of src/check/ against it and the migrations folder, and drops
// the database. It exits 1 when a rule finds anything, and also when a rule
// could not run: a check that did not look is not a pass. The one finding that
// does not fail the run is a contract migration with a valid header that awaits
// the `migration:contract` label (SLUGBASE_DB_CHECK_CONTRACT=pending, which CI
// sets on a push); it is printed as AWAIT. A value of that variable other than
// true, false or pending exits 2.

const USAGE = "usage: db-check.ts [--package <directory>]";

function parseArguments(argv: readonly string[]): string {
  let packageDir = resolve(import.meta.dirname, "..");
  const rest = argv.filter((argument) => argument !== "--");
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index + 1];
    if (rest[index] === "--package" && value !== undefined) {
      packageDir = resolve(value);
      index += 1;
    } else {
      throw new Error(USAGE);
    }
  }
  return packageDir;
}

async function main(): Promise<number> {
  let packageDir: string;
  try {
    packageDir = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`db:check: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let contractMarker: ContractMarker;
  try {
    contractMarker = contractMarkerFromEnv(process.env);
  } catch (error) {
    process.stderr.write(`db:check: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let results: RuleResult[];
  try {
    results = await withTestDatabase((database) =>
      runChecks(checkRules, { packageDir, sql: database.app, hashSqlFiles, contractMarker }),
    );
  } catch (error) {
    process.stderr.write(
      `db:check: the freshly migrated database could not be built or dropped: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    results = await runChecks(checkRules, { packageDir, sql: undefined, hashSqlFiles, contractMarker });
  }
  const { passed, lines } = formatReport(results);
  process.stdout.write(`${lines.join("\n")}\n`);
  return passed ? 0 : 1;
}

process.exitCode = await main();
