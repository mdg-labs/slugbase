import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTestDatabase, type MigrationChain, type TestDatabase, type TestSql } from "@slugbase/testing/db";

/** The connection URL of a pool of the test harness, with its login role and password. */
export function urlOf(pool: TestSql): string {
  const { options } = pool;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

/** The URL of the same database for another login, such as the superuser of the test cluster. */
export function urlFor(pool: TestSql, login: { username: string; password: string }): string {
  const url = new URL(urlOf(pool));
  url.username = login.username;
  url.password = login.password;
  return url.href;
}

/** The superuser of the test cluster, as the harness itself reads it. */
export function clusterSuperuser(): { username: string; password: string } {
  const server = new URL(process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev");
  return { username: decodeURIComponent(server.username), password: decodeURIComponent(server.password) };
}

export interface ScratchChains {
  /** A chain of the given migrations, each a file of one SQL text, applied in order. */
  chain(name: string, migrations: readonly string[]): MigrationChain;
  remove(): void;
}

/** Migration folders in a temporary directory, for the chains a test composes after the CE chain. */
export function scratchChains(): ScratchChains {
  const root = mkdtempSync(join(tmpdir(), "slugbase-chains-"));
  return {
    chain(name, migrations) {
      const folder = join(root, name);
      mkdirSync(join(folder, "meta"), { recursive: true });
      const entries = migrations.map((_sql, index) => ({ tag: `${String(index).padStart(4, "0")}_${name}`, when: 1_900_000_000_000 + index }));
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ entries }));
      migrations.forEach((sql, index) => {
        writeFileSync(join(folder, `${entries[index]?.tag ?? ""}.sql`), sql);
      });
      return { name, folder, bookkeepingTable: `migrations_${name}` };
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A test database `migrate` can run against: the harness gives `slugbase_owner` the database-level grants `roles.sql` does. */
export function useMigratableDatabase(): () => TestDatabase {
  return useTestDatabase();
}
