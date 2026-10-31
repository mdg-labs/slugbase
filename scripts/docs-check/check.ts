import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isVersion, splitFrontmatter, stripBom, validateFrontmatter } from "./frontmatter.ts";
import { lintBody } from "./mdx.ts";

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
  const text = readFileSync(join(repoRoot, path), "utf8");
  const split = splitFrontmatter(text);
  const isRelease = path.startsWith("docs/releases/");
  let since: string | undefined;
  if (split === null) {
    violations.push({ file: path, message: "the page has no frontmatter; it must start with a --- block" });
  } else {
    const result = validateFrontmatter(split.yaml);
    if (result.ok) since = result.data.since;
    else for (const problem of result.problems) violations.push({ file: path, line: 1, message: problem });
  }
  if (isRelease) checkReleaseName(path, since, violations);

  const offset = split?.frontmatterLines ?? 0;
  const extension = path.endsWith(".mdx") ? ".mdx" : ".md";
  for (const finding of lintBody(split?.body ?? stripBom(text), extension)) {
    violations.push({ file: path, line: finding.line + offset, message: finding.message });
  }
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
