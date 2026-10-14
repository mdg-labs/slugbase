import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A copy of the package that `pnpm db:check` inspects, so a test can edit a
// migration, the schema or src/sql without touching the real ones. Its schema is
// the shipped one, which the migrations describe, plus the tables a test declares.

export const PACKAGE = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export class PackageCopy {
  readonly dir = mkdtempSync(join(tmpdir(), "slugbase-db-check-test-"));

  constructor() {
    symlinkSync(join(PACKAGE, "node_modules"), join(this.dir, "node_modules"));
    cpSync(join(PACKAGE, "migrations"), join(this.dir, "migrations"), { recursive: true });
    cpSync(join(PACKAGE, "src", "sql"), join(this.dir, "src", "sql"), { recursive: true });
    mkdirSync(join(this.dir, "src", "check"), { recursive: true });
    cpSync(
      join(PACKAGE, "src", "check", "migration-checksums.json"),
      join(this.dir, "src", "check", "migration-checksums.json"),
    );
    this.schema("export {};\n");
  }

  /** The shipped schema plus the tables `source` declares, which a test adds, changes or breaks. */
  schema(source: string): void {
    const dir = join(this.dir, "src", "schema");
    cpSync(join(PACKAGE, "src", "schema"), dir, { recursive: true });
    writeFileSync(join(dir, "extra.ts"), source);
    writeFileSync(
      join(dir, "index.ts"),
      `${readFileSync(join(PACKAGE, "src", "schema", "index.ts"), "utf8")}export * from "./extra.ts";\n`,
    );
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  read(...parts: string[]): string {
    return readFileSync(this.path(...parts), "utf8");
  }

  write(content: string, ...parts: string[]): void {
    writeFileSync(this.path(...parts), content);
  }

  firstMigrationTag(): string {
    const journal = JSON.parse(this.read("migrations", "meta", "_journal.json")) as { entries: { tag: string }[] };
    return journal.entries[0]?.tag ?? "";
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
