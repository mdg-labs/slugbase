import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the rules know about the migrations folder: the journal that lists the
// files in order, and the checksum of each file as it was when it was first
// committed. The checksums live next to the rules (not in migrations/meta/,
// which drizzle-kit reads as snapshots) in a file the generator's output never
// touches: `pnpm db:record-checksums` adds the entry of a new migration, and
// nothing rewrites an existing one.

export const CHECKSUM_FILE = join("src", "check", "migration-checksums.json");

export interface JournalMigration {
  tag: string;
}

export interface Checksums {
  migrations: Record<string, string>;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function readJournal(packageDir: string): JournalMigration[] {
  const file = join(packageDir, "migrations", "meta", "_journal.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read migrations/meta/_journal.json (${error instanceof Error ? error.message : "unknown error"})`);
  }
  const entries = typeof parsed === "object" && parsed !== null && "entries" in parsed ? parsed.entries : undefined;
  if (!Array.isArray(entries)) {
    throw new Error("migrations/meta/_journal.json has no entries list");
  }
  return (entries as unknown[]).map((entry) => {
    const tag = typeof entry === "object" && entry !== null && "tag" in entry ? entry.tag : undefined;
    if (typeof tag !== "string" || tag === "") {
      throw new Error("migrations/meta/_journal.json holds an entry without a tag");
    }
    return { tag };
  });
}

/** SHA-256 of the file as written, which is what `migrate` records for the migration. */
export function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readMigration(packageDir: string, tag: string): string | undefined {
  const file = join(packageDir, "migrations", `${tag}.sql`);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export function readChecksums(packageDir: string): Checksums {
  const file = join(packageDir, CHECKSUM_FILE);
  if (!existsSync(file)) {
    return { migrations: {} };
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const migrations =
    typeof parsed === "object" && parsed !== null && "migrations" in parsed ? parsed.migrations : undefined;
  if (typeof migrations !== "object" || migrations === null || Array.isArray(migrations)) {
    throw new Error(`${CHECKSUM_FILE} has no migrations object`);
  }
  const result: Record<string, string> = {};
  for (const [tag, checksum] of Object.entries(migrations)) {
    if (typeof checksum !== "string" || !SHA256.test(checksum)) {
      throw new Error(`${CHECKSUM_FILE} holds no sha256 for ${tag}`);
    }
    result[tag] = checksum;
  }
  return { migrations: result };
}

/** The tags of the `.sql` files in migrations/, which the journal must list. */
export function migrationFileTags(packageDir: string): string[] {
  return readdirSync(join(packageDir, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
}

/**
 * Records the checksum of every journal migration that has none yet, and
 * returns their tags. An entry that exists is never rewritten: a migration
 * that no longer matches it is what `migration-checksums` reports.
 */
export function recordChecksums(packageDir: string): string[] {
  const journal = readJournal(packageDir);
  const recorded = readChecksums(packageDir);
  const added: string[] = [];
  for (const { tag } of journal) {
    if (tag in recorded.migrations) {
      continue;
    }
    const content = readMigration(packageDir, tag);
    if (content === undefined) {
      throw new Error(`migration file ${tag}.sql listed in the journal cannot be read`);
    }
    recorded.migrations[tag] = checksumOf(content);
    added.push(tag);
  }
  const ordered: Record<string, string> = {};
  for (const tag of Object.keys(recorded.migrations).sort()) {
    ordered[tag] = recorded.migrations[tag] ?? "";
  }
  if (added.length > 0) {
    writeFileSync(join(packageDir, CHECKSUM_FILE), `${JSON.stringify({ migrations: ordered }, null, 2)}\n`);
  }
  return added;
}
