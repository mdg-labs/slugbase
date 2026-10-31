import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../vitest.shared.ts";
import { checkDocs } from "./check.ts";
import { isVersion } from "./frontmatter.ts";

const CLI = resolve(import.meta.dirname, "docs-check.ts");
const FIXTURES = resolve(import.meta.dirname, "fixtures");

function runCli(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, root], { encoding: "utf8", timeout: HEAVY_TEST_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scratch: string[] = [];
function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "slugbase-docs-check-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PAGE = "---\ntitle: A page\ndescription: What it shows.\nedition: ce\n---\n\nText.\n";

describe("the command passes", () => {
  it("on a repository without documentation", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = runCli(tempTree());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0 pages checked");
  });

  it("on content roots that hold nothing", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const root = tempTree();
    for (const dir of ["docs/user", "docs/self-hosting", "docs/releases"]) mkdirSync(join(root, dir), { recursive: true });
    const result = runCli(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("on the valid tree", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = runCli(join(FIXTURES, "valid"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("6 pages checked");
  });
});

// Each row is a fixture under fixtures/invalid and what the report must name:
// the file, and the field or rule that broke.
const INVALID: [fixture: string, expected: string[]][] = [
  ["no-frontmatter", ["docs/user/page.md", "no frontmatter"]],
  ["title-missing", ["docs/user/page.md", '"title"']],
  ["description-missing", ["docs/user/page.md", '"description"']],
  ["edition-missing", ["docs/user/page.md", '"edition"']],
  ["title-empty", ["docs/user/page.md", '"title"', "must not be empty"]],
  ["title-not-string", ["docs/user/page.md", '"title"']],
  ["edition-unknown", ["docs/user/page.md", '"edition"']],
  ["since-not-version", ["docs/user/page.md", '"since"']],
  ["since-leading-zero", ["docs/user/page.md", '"since"']],
  ["order-not-integer", ["docs/user/page.md", '"order"']],
  ["order-string", ["docs/user/page.md", '"order"']],
  ["field-unknown", ["docs/user/page.md", 'unknown field "draft"']],
  ["yaml-invalid", ["docs/user/page.md", "not valid YAML"]],
  ["yaml-duplicate-key", ["docs/user/page.md", "not valid YAML"]],
  ["yaml-not-mapping", ["docs/user/page.md", "must be a mapping"]],
  ["file-type-text", ["docs/user/notes.txt", '".txt"']],
  ["file-type-svg", ["docs/self-hosting/logo.svg", '".svg"']],
  ["release-name", ["docs/releases/latest.md", '"latest" is not a version']],
  ["release-extension", ["docs/releases/1.0.0.mdx", "<version>.md"]],
  ["release-nested", ["docs/releases/archive/1.0.0.md", "<version>.md"]],
  ["release-since-mismatch", ["docs/releases/1.0.0.md", '"since"', "1.1.0", "1.0.0"]],
];

describe("the command fails", () => {
  it.each(INVALID)("on fixtures/invalid/%s", { timeout: HEAVY_TEST_TIMEOUT_MS }, (fixture, expected) => {
    const result = runCli(join(FIXTURES, "invalid", fixture));
    expect(result.status).toBe(1);
    for (const text of expected) expect(result.stderr).toContain(text);
  });

  it("on a symbolic link in a content root", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user"), { recursive: true });
    writeFileSync(join(root, "outside.md"), PAGE);
    symlinkSync(join(root, "outside.md"), join(root, "docs/user/linked.md"));
    const { violations } = checkDocs(root);
    expect(violations).toEqual([expect.objectContaining({ file: "docs/user/linked.md" })]);
  });

  it("on a content root that is a file", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/user"), "");
    expect(checkDocs(root).violations).toEqual([expect.objectContaining({ file: "docs/user" })]);
  });

  it("naming every problem of a page, not only the first", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user"), { recursive: true });
    writeFileSync(join(root, "docs/user/page.md"), "---\ntitle: t\nextra: 1\norder: x\n---\n");
    const fields = checkDocs(root).violations.map((violation) => violation.message);
    expect(fields).toHaveLength(4);
  });

  it("with a report that is stable between runs", () => {
    const first = checkDocs(join(FIXTURES, "invalid", "release-since-mismatch"));
    expect(checkDocs(join(FIXTURES, "invalid", "release-since-mismatch"))).toEqual(first);
  });
});

describe("versions", () => {
  it.each(["0.0.1", "1.0.0", "10.20.30", "1.2.0-rc.1", "1.0.0-alpha", "1.0.0-0.3.7", "1.0.0-x-y-z.0"])("accepts %s", (version) => {
    expect(isVersion(version)).toBe(true);
  });

  it.each(["1", "1.0", "v1.0.0", "01.0.0", "1.0.0-", "1.0.0-01", "1.0.0-rc..1", "1.0.0+build.1", "1.0.0 ", "latest"])(
    "refuses %s",
    (version) => {
      expect(isVersion(version)).toBe(false);
    },
  );
});
