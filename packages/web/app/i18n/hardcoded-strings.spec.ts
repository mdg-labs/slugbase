import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");

const SCAN_ROOTS = [
  join(repoRoot, "packages/web/app"),
  join(repoRoot, "packages/marketing/src"),
  join(repoRoot, "packages/ui/src/components"),
];

const SOURCE_EXTENSIONS = new Set([".tsx", ".astro"]);

const IGNORED_PATH_PARTS = [
  ".spec.",
  ".spec.tsx",
  "messages.ts",
  "message-keys.generated.ts",
  "i18n/locales",
];

/** Attribute or same-line text after `>`. */
const HARD_CODED_ATTRIBUTE_PATTERN =
  /(?:>|(?:placeholder|aria-label|title|alt)=)["']([A-Z][^"'{]*?)["']/g;

/** Text on the line after a closing `>` (common in Astro markup). */
const HARD_CODED_ELEMENT_TEXT_PATTERN = />\s*\n\s*([A-Z][^\n<{]+)/g;

function shouldScanFile(path: string): boolean {
  if (![...SOURCE_EXTENSIONS].some((ext) => path.endsWith(ext))) return false;
  return !IGNORED_PATH_PARTS.some((part) => path.includes(part));
}

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (shouldScanFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectViolations(content: string, file: string): string[] {
  const violations: string[] = [];
  for (const match of content.matchAll(HARD_CODED_ATTRIBUTE_PATTERN)) {
    const text = match[1]?.trim();
    if (!text || text.length < 2) continue;
    violations.push(`${relative(repoRoot, file)}: "${text}"`);
  }
  if (file.endsWith(".astro")) {
    for (const match of content.matchAll(HARD_CODED_ELEMENT_TEXT_PATTERN)) {
      const text = match[1]?.trim();
      if (!text || text.length < 2) continue;
      violations.push(`${relative(repoRoot, file)}: "${text}"`);
    }
  }
  return violations;
}

describe("i18n hard-coded UI string audit", () => {
  it("finds no hard-coded user-visible strings in web, marketing, and ui components", () => {
    const violations: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const content = readFileSync(file, "utf8");
        violations.push(...collectViolations(content, file));
      }
    }

    expect(violations).toEqual([]);
  });
});
