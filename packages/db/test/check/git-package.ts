import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A temporary git repository holding a package/db-shaped folder (journal,
// snapshots and migrations, no schema), so the expand/contract rule can be
// driven against real release tags. The package sits one level below the
// repository root, as packages/db does, to cover the path prefix.

const PACKAGE_PATH = ["packages", "db"] as const;

export interface TableSpec {
  name: string;
  columns: string[];
}

export class GitPackage {
  readonly root = mkdtempSync(join(tmpdir(), "slugbase-db-check-git-"));
  readonly dir = join(this.root, ...PACKAGE_PATH);
  private readonly entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] = [];
  private tables: TableSpec[] = [];

  constructor() {
    mkdirSync(join(this.dir, "migrations", "meta"), { recursive: true });
    this.git("init", "--quiet", "--initial-branch=main");
    this.writeJournal();
  }

  git(...args: string[]): string {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    return execFileSync(
      "git",
      ["-C", this.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
      { encoding: "utf8", env },
    );
  }

  private writeJournal(): void {
    writeFileSync(
      join(this.dir, "migrations", "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries: this.entries }),
    );
  }

  /** Adds a migration file with the snapshot of the tables it leaves behind. */
  migration(tag: string, sql: string, tables?: TableSpec[]): void {
    if (tables !== undefined) {
      this.tables = tables;
    }
    this.entries.push({ idx: this.entries.length, version: "7", when: 1_800_000_000_000 + this.entries.length, tag, breakpoints: true });
    this.writeJournal();
    this.write(sql, "migrations", `${tag}.sql`);
    const snapshot = {
      version: "7",
      dialect: "postgresql",
      tables: Object.fromEntries(
        this.tables.map(({ name, columns }) => [
          `public.${name}`,
          { name, schema: "", columns: Object.fromEntries(columns.map((column) => [column, { name: column, type: "text" }])) },
        ]),
      ),
    };
    this.write(JSON.stringify(snapshot), "migrations", "meta", `${tag.slice(0, 14)}_snapshot.json`);
  }

  write(content: string, ...parts: string[]): void {
    const file = join(this.dir, ...parts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  commit(message = "commit"): void {
    this.git("add", "--all");
    this.git("commit", "--quiet", "-m", message);
  }

  tag(name: string): void {
    this.git("tag", name);
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export const FIRST = "20260101000000_add_bookmarks";
export const SECOND = "20260201000000_add_notes";

/** A repository whose release tag holds a `bookmarks` table and the migration that created it. */
export function releasedRepository(tag = "v1.0.0"): GitPackage {
  const repository = new GitPackage();
  repository.migration(
    FIRST,
    'CREATE TABLE "bookmarks" ("id" uuid PRIMARY KEY, "title" text, "legacy_title" text);\n',
    [{ name: "bookmarks", columns: ["id", "title", "legacy_title"] }],
  );
  repository.commit("first release");
  repository.tag(tag);
  return repository;
}
