import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  customSqlStatements,
  hashSqlFiles,
  joinStatements,
  nonTransactional,
  rewriteIndexesConcurrently,
  STATEMENT_BREAKPOINT,
  tablesOfSnapshot,
  type SqlFile,
} from "./migration-sql.ts";

// `pnpm db:generate` (doc 05 section 5.1): runs drizzle-kit against the Drizzle
// schema, appends the declarative SQL of src/sql/ as a custom step when it
// changed since the last migration, and rewrites index creation on existing
// tables to CONCURRENTLY, each build in a migration of its own. It never
// connects to a database and never touches a migration that already exists: all
// it writes are new files and the new tail of the journal. When any step fails,
// the migrations folder is put back as it was.
//
// With `--contract expand=<migration tag> release=<version>` the migration it
// writes carries, in its leading comment block, the contract header that the
// expand/contract check of `pnpm db:check` reads (doc 05 section 5.2), so the
// checksum recorded for the file covers it from the start. Only a file that can
// hold a destructive step gets it, not a file of one index build. Giving the
// option when no such file is written is an error.

const USAGE =
  "usage: generate-migration.ts [--name <add_|index_|drop_><thing>] [--contract expand=<migration tag> release=<version>] [--package <directory>]";
const NAME_PATTERN = /^(?:add|index|drop)_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const DEFAULT_CUSTOM_NAME = "add_sql_definitions";
const UNNAMED = "unnamed_schema_change";
const TAG_PATTERN = /^(\d{14})_(.+)$/;
// drizzle-kit reads every file of meta/ that does not start with an underscore as a snapshot.
const CHECK_OK = "Everything's fine";
const NO_CHANGES = "No schema changes, nothing to migrate";
const RECORD_FILE = "_custom-sql.json";
const CONTRACT_HEADER_PREFIX = "-- slugbase:contract";
const RELEASE_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface Contract {
  expand: string;
  release: string;
}

function contractHeader({ expand, release }: Contract): string {
  return `${CONTRACT_HEADER_PREFIX} expand=${expand} release=${release}`;
}

/** The file with the header at the end of its leading comment block, where the check reads it. */
function withContractHeader(content: string, contract: Contract): string {
  const lines = content.split("\n");
  let at = 0;
  while (at < lines.length && (lines[at] ?? "").startsWith("--") && !(lines[at] ?? "").startsWith(STATEMENT_BREAKPOINT)) {
    at += 1;
  }
  lines.splice(at, 0, contractHeader(contract));
  return lines.join("\n");
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  entries: JournalEntry[];
}

type Tree = Map<string, Buffer>;

function isJournalEntry(value: unknown): value is JournalEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "idx" in value &&
    typeof value.idx === "number" &&
    "version" in value &&
    typeof value.version === "string" &&
    "when" in value &&
    typeof value.when === "number" &&
    "tag" in value &&
    typeof value.tag === "string" &&
    "breakpoints" in value &&
    typeof value.breakpoints === "boolean"
  );
}

function readJournal(metaDir: string): Journal & Record<string, unknown> {
  const file = join(metaDir, "_journal.json");
  if (!existsSync(file)) {
    return { entries: [] };
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed) || !Array.isArray(parsed.entries)) {
    throw new Error(`${file} has no entries list`);
  }
  const entries: unknown[] = parsed.entries;
  if (!entries.every(isJournalEntry)) {
    throw new Error(`${file} holds an entry that drizzle-kit would not write`);
  }
  return { ...parsed, entries };
}

function writeJournal(metaDir: string, journal: Journal): void {
  writeFileSync(join(metaDir, "_journal.json"), JSON.stringify(journal, null, 2));
}

function captureTree(dir: string, base = dir, tree: Tree = new Map()): Tree {
  if (!existsSync(dir)) {
    return tree;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      captureTree(path, base, tree);
    } else {
      tree.set(path.slice(base.length + 1), readFileSync(path));
    }
  }
  return tree;
}

function restoreTree(dir: string, before: Tree): void {
  const after = captureTree(dir);
  for (const path of after.keys()) {
    if (!before.has(path)) {
      rmSync(join(dir, path));
    }
  }
  for (const [path, content] of before) {
    const original = after.get(path);
    if (original === undefined || !original.equals(content)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  if (before.size === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * drizzle-kit exits 0 after it printed an error it caught (a schema file that
 * does not load, a malformed snapshot), so an exit code proves nothing. With
 * `expect`, the run must print that sentence, or it failed. Without it the run
 * may be interactive: drizzle-kit asks whether a changed column was renamed
 * and needs a terminal for that.
 */
function runDrizzleKit(packageDir: string, args: readonly string[], expect?: string): void {
  const bin = join(packageDir, "node_modules", "drizzle-kit", "bin.cjs");
  const interactive = expect === undefined && process.stdin.isTTY && process.stdout.isTTY;
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  // Both are null when the run inherited the terminal.
  const output = `${(result.stdout as string | null) ?? ""}${(result.stderr as string | null) ?? ""}`;
  if (result.status !== 0 || (expect !== undefined && !output.includes(expect))) {
    throw new Error(
      `drizzle-kit ${args.join(" ")} failed${expect === undefined ? "" : ` (expected "${expect}")`}:\n${output.trim()}`,
    );
  }
}

function readSqlFiles(dir: string): SqlFile[] {
  if (!existsSync(dir)) {
    throw new Error(`${dir} does not exist`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
  if (files.length === 0) {
    throw new Error(`${dir} holds no .sql file`);
  }
  return files;
}

function recordedHash(metaDir: string): string | undefined {
  const file = join(metaDir, RECORD_FILE);
  if (!existsSync(file)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("sha256" in parsed) || typeof parsed.sha256 !== "string") {
    throw new Error(`${file} has no sha256`);
  }
  return parsed.sha256;
}

function existingTables(metaDir: string): Set<string> {
  if (!existsSync(metaDir)) {
    return new Set();
  }
  const latest = readdirSync(metaDir)
    .filter((name) => name.endsWith("_snapshot.json"))
    .sort()
    .at(-1);
  return latest === undefined
    ? new Set()
    : tablesOfSnapshot(JSON.parse(readFileSync(join(metaDir, latest), "utf8")) as unknown);
}

function nextTag(tag: string, name: string): string {
  const match = TAG_PATTERN.exec(tag);
  const digits = match?.[1];
  if (digits === undefined) {
    throw new Error(`migration tag ${tag} has no timestamp`);
  }
  const at = Date.UTC(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    Number(digits.slice(8, 10)),
    Number(digits.slice(10, 12)),
    Number(digits.slice(12, 14)) + 1,
  );
  return `${new Date(at).toISOString().replace(/\D/g, "").slice(0, 14)}_${name}`;
}

function newEntries(before: Journal, after: Journal): JournalEntry[] {
  const kept = before.entries.every((entry, index) => after.entries[index]?.tag === entry.tag);
  const added = after.entries.slice(before.entries.length);
  if (!kept || added.length > 1) {
    throw new Error("drizzle-kit changed the journal in a way the generator does not expect");
  }
  const last = before.entries.at(-1);
  const [first] = added;
  if (last !== undefined && first !== undefined && first.when <= last.when) {
    throw new Error(
      `drizzle-kit dated ${first.tag} at ${String(first.when)}, not after ${last.tag} at ${String(last.when)}: migrate would refuse the journal. Run it again once the clock has passed that time`,
    );
  }
  return added;
}

function generate(packageDir: string, name: string | undefined, contract: Contract | undefined): string[] {
  const migrationsDir = join(packageDir, "migrations");
  const metaDir = join(migrationsDir, "meta");
  const sqlFiles = readSqlFiles(join(packageDir, "src", "sql"));
  const hash = hashSqlFiles(sqlFiles);
  const customChanged = recordedHash(metaDir) !== hash;
  const tables = existingTables(metaDir);
  const journalBefore = readJournal(metaDir);
  const messages: string[] = [];
  const contractFiles: string[] = [];
  let customTag: string | undefined;

  if (contract !== undefined && !journalBefore.entries.some(({ tag }) => tag === contract.expand)) {
    throw new Error(`--contract names ${contract.expand}, which is not a migration of the journal`);
  }

  if (existsSync(metaDir)) {
    runDrizzleKit(packageDir, ["check"], CHECK_OK);
  }
  runDrizzleKit(packageDir, ["generate", "--name", name ?? UNNAMED]);
  const [generated] = newEntries(journalBefore, readJournal(metaDir));
  const custom = customChanged ? customSqlStatements(sqlFiles) : [];

  if (generated !== undefined) {
    if (name === undefined) {
      throw new Error(`the schema changed: pass --name with an add_, index_ or drop_ name. ${USAGE}`);
    }
    const file = join(migrationsDir, `${generated.tag}.sql`);
    const { transactional, concurrent } = rewriteIndexesConcurrently(readFileSync(file, "utf8"), tables);
    const head = [...transactional, ...custom];
    const [firstBuild] = concurrent;
    const holdsBuild = head.length === 0 && firstBuild !== undefined;
    messages.push(`wrote ${generated.tag}.sql${holdsBuild ? " (non-transactional)" : ""}`);
    if (concurrent.length > 0 || custom.length > 0) {
      writeFileSync(file, holdsBuild ? nonTransactional([firstBuild]) : joinStatements(head));
    }
    if (custom.length > 0) {
      customTag = generated.tag;
    }
    if (!holdsBuild) {
      contractFiles.push(file);
    }
    // One migration per build: a build that fails leaves at most its own INVALID index,
    // which migrate drops and rebuilds, where a finished build before it would stay valid
    // and make every retry of a shared file fail on its name.
    const base = `index_${name.replace(/^(?:add|index|drop)_/, "")}`;
    let previous = generated;
    for (const [position, build] of concurrent.entries()) {
      if (position === 0 && holdsBuild) {
        continue;
      }
      const journal = readJournal(metaDir);
      const tag = nextTag(previous.tag, position === 0 ? base : `${base}_${String(position + 1)}`);
      const entry = { ...generated, idx: journal.entries.length, when: previous.when + 1, tag };
      writeFileSync(join(migrationsDir, `${tag}.sql`), nonTransactional([build]));
      writeJournal(metaDir, { ...journal, entries: [...journal.entries, entry] });
      messages.push(`wrote ${tag}.sql (non-transactional)`);
      previous = entry;
    }
  } else if (customChanged) {
    runDrizzleKit(packageDir, ["generate", "--custom", "--name", name ?? DEFAULT_CUSTOM_NAME]);
    const [created] = newEntries(journalBefore, readJournal(metaDir));
    if (created === undefined) {
      throw new Error("drizzle-kit did not create the custom migration");
    }
    writeFileSync(join(migrationsDir, `${created.tag}.sql`), joinStatements(custom));
    contractFiles.push(join(migrationsDir, `${created.tag}.sql`));
    customTag = created.tag;
    messages.push(`wrote ${created.tag}.sql`);
  }

  if (contract !== undefined) {
    if (contractFiles.length === 0) {
      throw new Error("--contract was given, but this run writes no migration that can hold a contract step");
    }
    for (const file of contractFiles) {
      writeFileSync(file, withContractHeader(readFileSync(file, "utf8"), contract));
    }
  }
  if (customTag !== undefined) {
    writeFileSync(join(metaDir, RECORD_FILE), `${JSON.stringify({ sha256: hash, migration: customTag }, null, 2)}\n`);
    messages.push(`src/sql changed: emitted in ${customTag}`);
  }
  // The proof that the schema loaded and that the migrations now describe it.
  runDrizzleKit(packageDir, ["generate", "--name", UNNAMED], NO_CHANGES);
  return messages.length === 0 ? ["migrations are up to date"] : messages;
}

interface Arguments {
  packageDir: string;
  name: string | undefined;
  contract: Contract | undefined;
}

function parseContract(expand: string | undefined, release: string | undefined): Contract {
  const expandTag = expand?.startsWith("expand=") === true ? expand.slice("expand=".length) : "";
  const version = release?.startsWith("release=") === true ? release.slice("release=".length) : "";
  if (!TAG_PATTERN.test(expandTag) || !RELEASE_PATTERN.test(version)) {
    throw new Error(
      `--contract takes expand=<migration tag> and release=<version> (a release tag such as 1.2.0, v1.2.0 or 1.2.0-rc.1). ${USAGE}`,
    );
  }
  return { expand: expandTag, release: version };
}

function parseArguments(argv: readonly string[]): Arguments {
  let packageDir = resolve(import.meta.dirname, "..");
  let name: string | undefined;
  let contract: Contract | undefined;
  const rest = argv.filter((argument) => argument !== "--");
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    const value = rest[index + 1];
    if (argument === "--name" && value !== undefined) {
      name = value;
      index += 1;
    } else if (argument === "--package" && value !== undefined) {
      packageDir = resolve(value);
      index += 1;
    } else if (argument === "--contract" && contract === undefined) {
      contract = parseContract(value, rest[index + 2]);
      index += 2;
    } else {
      throw new Error(USAGE);
    }
  }
  if (name !== undefined && !NAME_PATTERN.test(name)) {
    throw new Error(`migration name "${name}" must be add_, index_ or drop_ followed by lower-case words`);
  }
  return { packageDir, name, contract };
}

function main(): number {
  let packageDir: string;
  let name: string | undefined;
  let contract: Contract | undefined;
  try {
    ({ packageDir, name, contract } = parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`db:generate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const migrationsDir = join(packageDir, "migrations");
  const before = captureTree(migrationsDir);
  try {
    process.stdout.write(`${generate(packageDir, name, contract).map((line) => `db:generate: ${line}`).join("\n")}\n`);
    return 0;
  } catch (error) {
    restoreTree(migrationsDir, before);
    process.stderr.write(
      `db:generate: ${error instanceof Error ? error.message : String(error)}\ndb:generate: migrations restored, nothing was written\n`,
    );
    return 1;
  }
}

process.exitCode = main();
