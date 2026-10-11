import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { findTerm, loadTerms, type ForbiddenTerm } from "./terms.ts";

export interface CatalogViolation {
  file: string;
  path: string;
  text: string;
  term: ForbiddenTerm;
  where: "key" | "value";
}

function catalogFiles(root: string): string[] {
  const packagesDir = join(root, "packages");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".json")) {
        files.push(full);
      }
    }
  };
  let packageNames: string[];
  try {
    packageNames = readdirSync(packagesDir).sort();
  } catch {
    return files;
  }
  for (const name of packageNames) {
    const i18nDir = join(packagesDir, name, "src", "i18n");
    try {
      if (statSync(i18nDir).isDirectory()) {
        walk(i18nDir);
      }
    } catch {
      continue;
    }
  }
  return files;
}

function scan(value: unknown, path: string, file: string, terms: readonly ForbiddenTerm[], out: CatalogViolation[]): void {
  if (typeof value === "string") {
    const term = findTerm(value, terms);
    if (term !== undefined) {
      out.push({ file, path, text: value, term, where: "value" });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scan(item, `${path}[${String(index)}]`, file, terms, out);
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const term = findTerm(key, terms);
      if (term !== undefined) {
        out.push({ file, path: childPath, text: key, term, where: "key" });
      }
      scan(child, childPath, file, terms, out);
    }
  }
}

export function checkCatalogs(root: string, terms: readonly ForbiddenTerm[]): { files: number; violations: CatalogViolation[] } {
  const files = catalogFiles(root);
  const violations: CatalogViolation[] = [];
  for (const file of files) {
    scan(JSON.parse(readFileSync(file, "utf8")) as unknown, "", relative(root, file), terms, violations);
  }
  return { files: files.length, violations };
}

function main(): number {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, "../.."));
  const { files, violations } = checkCatalogs(root, loadTerms());
  for (const v of violations) {
    process.stderr.write(
      `${v.file}: ${v.where} "${v.text}" at ${v.path} contains "${v.term.word}"; the product term is "${v.term.canonical}" (doc 00 section 3)\n`,
    );
  }
  if (violations.length > 0) {
    process.stderr.write(`vocabulary: ${String(violations.length)} violation(s) in ${String(files)} catalog file(s)\n`);
    return 1;
  }
  process.stdout.write(`vocabulary: ${String(files)} catalog file(s) clean\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`vocabulary: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
