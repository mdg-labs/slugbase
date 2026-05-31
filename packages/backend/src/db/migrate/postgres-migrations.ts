import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";

import { adaptSqliteMigrationSqlForPostgres } from "../dialect/adapt-migration-sql.js";

interface MigrationJournal {
  entries: Array<{ tag: string }>;
}

export async function preparePostgresMigrationsFolder(
  sourceFolder: string,
): Promise<string> {
  const tempFolder = await mkdtemp(join(tmpdir(), "slugbase-pg-migrations-"));
  const metaSource = join(sourceFolder, "meta");
  const metaTarget = join(tempFolder, "meta");

  await mkdir(metaTarget, { recursive: true });
  await cp(join(metaSource, "_journal.json"), join(metaTarget, "_journal.json"));

  const journalRaw = await readFile(join(metaSource, "_journal.json"), "utf8");
  const journal = JSON.parse(journalRaw) as MigrationJournal;

  for (const entry of journal.entries) {
    const sourceSql = await readFile(join(sourceFolder, `${entry.tag}.sql`), "utf8");
    const adaptedSql = adaptSqliteMigrationSqlForPostgres(sourceSql);
    await writeFile(join(tempFolder, `${entry.tag}.sql`), adaptedSql, "utf8");
  }

  return tempFolder;
}

export async function cleanupPostgresMigrationsFolder(
  tempFolder: string,
): Promise<void> {
  await rm(tempFolder, { recursive: true, force: true });
}

export function listMigrationHashes(migrationsFolder: string): string[] {
  return readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash);
}
