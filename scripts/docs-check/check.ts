import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { isVersion, splitFrontmatter, stripBom, validateFrontmatter } from "./frontmatter.ts";
import { CONTENT_ROOTS, IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, PAGE_EXTENSIONS } from "./contract.ts";
import { checkImage, checkLink, collectRefs, type LinkContext, type PageRefs } from "./links.ts";
import { lintTree, parseBody } from "./mdx.ts";
import { firstUserSegment, RESERVED_SEGMENTS, routeOf } from "./routes.ts";

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

interface CheckedPage extends PageRefs {
  path: string;
  /** The lines the frontmatter takes, to turn a line of the body into a line of the file. */
  offset: number;
}

/** Checks the frontmatter, the release name and the MDX of a page; returns what the link pass needs. */
function checkPage(repoRoot: string, path: string, violations: Violation[]): CheckedPage {
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
  const parsed = parseBody(split?.body ?? stripBom(text), path.endsWith(".mdx") ? ".mdx" : ".md");
  if (!parsed.ok) {
    violations.push({ file: path, line: parsed.finding.line + offset, message: parsed.finding.message });
    return { path, offset, refs: [], headings: new Set() };
  }
  for (const finding of lintTree(parsed.tree)) {
    violations.push({ file: path, line: finding.line + offset, message: finding.message });
  }
  return { path, offset, ...collectRefs(parsed.tree) };
}

/** The reserved first segments and the routes two pages share; returns the routes that exist. */
function checkRoutes(pages: readonly string[], violations: Violation[]): Set<string> {
  const byRoute = new Map<string, string[]>();
  for (const page of pages) {
    const segment = firstUserSegment(page);
    if ((RESERVED_SEGMENTS as readonly (string | null)[]).includes(segment)) {
      violations.push({
        file: page,
        message: `the route starts with the reserved segment "${segment ?? ""}"; ${RESERVED_SEGMENTS.join(", ")} belong to other parts of the site`,
      });
    }
    const route = routeOf(page);
    if (route !== null) byRoute.set(route, [...(byRoute.get(route) ?? []), page]);
  }
  for (const [route, sharing] of byRoute) {
    for (const page of sharing) {
      const others = sharing.filter((other) => other !== page);
      if (others.length > 0) violations.push({ file: page, message: `produces the route ${route}, which ${others.join(" and ")} also produces` });
    }
  }
  return new Set(byRoute.keys());
}

function checkImageSizes(repoRoot: string, images: readonly string[], violations: Violation[]): void {
  for (const image of images) {
    const size = statSync(join(repoRoot, image)).size;
    if (size > MAX_IMAGE_BYTES) {
      violations.push({ file: image, message: `the image is ${String(size)} bytes; the limit is ${String(MAX_IMAGE_BYTES)} (1 MiB)` });
    }
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
  const checked = found.pages.map((path) => checkPage(repoRoot, path, violations));
  const routes = checkRoutes(found.pages, violations);
  checkImageSizes(repoRoot, found.images, violations);

  const files = new Set([...found.pages, ...found.images]);
  const images = new Set(found.images);
  for (const page of checked) {
    const context: LinkContext = { page: page.path, files, images, routes, headings: page.headings };
    for (const ref of page.refs) {
      const message = ref.kind === "link" ? checkLink(ref.url, context) : checkImage(ref.url, context);
      if (message !== null) violations.push({ file: page.path, line: ref.line + page.offset, message });
    }
  }
  violations.sort((a, b) => (a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1));
  return { violations, pages: found.pages.length };
}

export function formatViolation(violation: Violation): string {
  const where = violation.line === undefined ? violation.file : `${violation.file}:${String(violation.line)}`;
  return `${where}: ${violation.message}`;
}
