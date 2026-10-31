import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isVersion, splitFrontmatter, validateFrontmatter } from "./frontmatter.ts";

/** The content roots of the docs contract (doc 09 section 3.5), relative to the repository root. */
export const CONTENT_ROOTS = ["docs/user", "docs/self-hosting", "docs/releases"] as const;

export const PAGE_EXTENSIONS = [".md", ".mdx"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"] as const;

export interface Violation {
  /** Path relative to the repository root, with `/` separators. */
  file: string;
  line?: number;
  message: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

interface Walked {
  pages: string[];
  images: string[];
}

function walk(repoRoot: string, dir: string, violations: Violation[], found: Walked): void {
  const entries = readdirSync(join(repoRoot, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const path = posix.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      violations.push({ file: path, message: "a symbolic link is not allowed in a content root" });
    } else if (entry.isDirectory()) {
      walk(repoRoot, path, violations, found);
    } else if (!entry.isFile()) {
      violations.push({ file: path, message: "only regular files are allowed in a content root" });
    } else if ((PAGE_EXTENSIONS as readonly string[]).includes(extensionOf(entry.name))) {
      found.pages.push(path);
    } else if ((IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(entry.name))) {
      found.images.push(path);
    } else {
      violations.push({
        file: path,
        message: `a content root holds only .md and .mdx pages and ${IMAGE_EXTENSIONS.join(", ")} images, not "${extensionOf(entry.name) || entry.name}"`,
      });
    }
  }
}

function checkReleaseName(path: string, since: string | undefined, violations: Violation[]): void {
  const name = posix.relative("docs/releases", path);
  const expected = "a release note is named <version>.md directly under docs/releases/, for example 1.0.0.md or 1.2.0-rc.1.md";
  if (name.includes("/") || !name.endsWith(".md")) {
    violations.push({ file: path, message: expected });
    return;
  }
  const version = name.slice(0, -".md".length);
  if (!isVersion(version)) {
    violations.push({ file: path, message: `"${version}" is not a version; ${expected}` });
    return;
  }
  if (since !== undefined && since !== version) {
    violations.push({ file: path, message: `frontmatter field "since" is "${since}" but the file is named for version ${version}` });
  }
}

function checkPage(repoRoot: string, path: string, violations: Violation[]): void {
  const split = splitFrontmatter(readFileSync(join(repoRoot, path), "utf8"));
  const isRelease = path.startsWith("docs/releases/");
  if (split === null) {
    violations.push({ file: path, message: "the page has no frontmatter; it must start with a --- block" });
    if (isRelease) checkReleaseName(path, undefined, violations);
    return;
  }
  const result = validateFrontmatter(split.yaml);
  if (!result.ok) {
    for (const problem of result.problems) violations.push({ file: path, line: 1, message: problem });
  }
  if (isRelease) checkReleaseName(path, result.ok ? result.data.since : undefined, violations);
}

/** Reads the three content roots under `repoRoot` and returns every violation of the docs contract. */
export function checkDocs(repoRoot: string): { violations: Violation[]; pages: number } {
  const violations: Violation[] = [];
  const found: Walked = { pages: [], images: [] };
  for (const root of CONTENT_ROOTS) {
    try {
      if (!lstatSync(join(repoRoot, root)).isDirectory()) {
        violations.push({ file: root, message: "a content root must be a directory" });
        continue;
      }
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    walk(repoRoot, root, violations, found);
  }
  for (const path of found.pages) checkPage(repoRoot, path, violations);
  violations.sort((a, b) => (a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1));
  return { violations, pages: found.pages.length };
}

export function formatViolation(violation: Violation): string {
  const where = violation.line === undefined ? violation.file : `${violation.file}:${String(violation.line)}`;
  return `${where}: ${violation.message}`;
}
