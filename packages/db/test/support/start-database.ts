import type { MigrationChain } from "../../src/migrate.ts";
import { withTestDatabase } from "../../src/testing.ts";

// One process that starts a test database for the chain list in its first
// argument (JSON), reports what it found on stdout and drops the database. The
// template-build test starts several of these at once, which is how a second
// worker or a second checkout meets the harness.

const chains = JSON.parse(process.argv[2] ?? "[]") as MigrationChain[];

const report = await withTestDatabase(
  async (database) => {
    const core = await database.app<{ count: string }[]>`SELECT count(*) FROM drizzle.migrations_core`;
    return { name: database.name, template: database.template, core: Number(core[0]?.count) };
  },
  { chains },
);

process.stdout.write(`${JSON.stringify(report)}\n`);
