import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../vitest.shared.ts";
import { checkDocs } from "./check.ts";
import { isVersion } from "./frontmatter.ts";
import { checkImage, checkLink, collectRefs, type LinkContext, slugify } from "./links.ts";
import { ALLOWED_COMPONENTS, lintBody, parseBody } from "./mdx.ts";

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
    expect(result.stdout).toContain("13 pages checked");
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
  ["mdx-import", ["docs/user/mdx-import.mdx:9:", "import and export"]],
  ["mdx-export", ["docs/user/mdx-export.mdx:9:", "import and export"]],
  ["mdx-expression-text", ["docs/user/page.mdx:7:", "JavaScript expression"]],
  ["mdx-expression-flow", ["docs/user/page.mdx:9:", "JavaScript expression"]],
  ["mdx-expression-attribute", ["docs/user/page.mdx:9:", 'attribute "kind"', "JavaScript expression"]],
  ["mdx-spread-attribute", ["docs/user/page.mdx:9:", "spread attribute"]],
  ["mdx-component-unknown", ["docs/user/page.mdx:9:", "<Chart>", "not an allowed component"]],
  ["mdx-fragment", ["docs/user/page.mdx:9:", "a fragment"]],
  ["mdx-html-script", ["docs/user/page.mdx:9:", "<script>"]],
  ["mdx-html-iframe", ["docs/user/page.mdx:9:", "<iframe>"]],
  ["mdx-html-style", ["docs/user/page.mdx:9:", "<style>"]],
  ["mdx-html-img", ["docs/user/page.mdx:7:", "<img>"]],
  ["mdx-html-anchor", ["docs/user/page.mdx:7:", "<a>"]],
  ["mdx-html-comment", ["docs/user/page.mdx:9:", "not valid MDX"]],
  ["mdx-parse-error", ["docs/user/page.mdx:", "not valid MDX"]],
  ["md-html-script", ["docs/user/page.md:9:", "raw HTML"]],
  ["md-html-iframe", ["docs/user/page.md:9:", "raw HTML"]],
  ["md-html-style", ["docs/user/page.md:9:", "raw HTML"]],
  ["md-html-img", ["docs/user/page.md:7:", "raw HTML"]],
  ["md-html-anchor", ["docs/user/page.md:7:", "raw HTML"]],
  ["md-html-comment", ["docs/user/page.md:9:", "raw HTML"]],
  ["md-html-allowed-name", ["docs/user/page.md:9:", "raw HTML"]],
  ["link-relative-missing", ["docs/user/page.md:7:", '"missing.md"', "does not resolve"]],
  ["link-route-missing", ["docs/user/page.md:7:", '"/docs/nope"', "route /docs/nope"]],
  ["link-http", ["docs/user/page.md:7:", "http: scheme"]],
  ["link-javascript", ["docs/user/page.md:7:", "javascript: scheme"]],
  ["link-mailto", ["docs/user/page.md:7:", "mailto: scheme"]],
  ["link-root-absolute", ["docs/user/page.md:7:", '"/pricing"', "root-absolute"]],
  ["link-cloud-traversal", ["docs/user/page.md:7:", '"/docs/cloud/../../pricing"', "climbs out"]],
  ["link-cloud-traversal-encoded", ["docs/user/page.md:7:", "/docs/cloud/%2E%2E/%2E%2E/pricing", "climbs out"]],
  ["link-bare-http", ["docs/user/page.md:7:", '"http://example.com"', "http: scheme", "bare address"]],
  ["link-bare-www", ["docs/user/page.md:7:", '"http://www.example.com"', "bare address"]],
  ["link-fragment-missing", ["docs/user/page.md:9:", '"#absent"', "matches no heading"]],
  ["link-reference-missing", ["docs/user/page.md:9:", '"missing.md"']],
  ["image-missing", ["docs/user/page.md:7:", '"shot.png"', "not a file next to the page"]],
  ["image-remote", ["docs/user/page.md:7:", "absolute or remote"]],
  ["image-absolute", ["docs/user/page.md:7:", "absolute or remote"]],
  ["image-parent", ["docs/user/sub/page.md:7:", '"../shot.png"', "leaves the page's folder"]],
  ["image-extension", ["docs/user/page.md:7:", 'extension ".tiff"']],
  ["image-screenshot-missing", ["docs/user/page.mdx:7:", '"shot.png"']],
  ["route-reserved-cloud", ["docs/user/cloud/page.md", 'reserved segment "cloud"']],
  ["route-reserved-self-hosting", ["docs/user/self-hosting.md", 'reserved segment "self-hosting"']],
  ["route-reserved-releases", ["docs/user/releases/page.md", 'reserved segment "releases"']],
  ["route-reserved-case", ["docs/user/Cloud/page.md", 'reserved segment "Cloud"']],
  ["route-duplicate-index", ["docs/user/a.md", "docs/user/a/index.md", "route /docs/a"]],
  ["route-duplicate-extension", ["docs/user/b.md", "docs/user/b.mdx", "route /docs/b"]],
];

describe("the command fails", () => {
  it.each(INVALID)("on fixtures/invalid/%s", { timeout: HEAVY_TEST_TIMEOUT_MS }, (fixture, expected) => {
    const result = runCli(join(FIXTURES, "invalid", fixture));
    expect(result.status).toBe(1);
    for (const text of expected) expect(result.stderr).toContain(text);
  });

  it("on two pages whose routes differ only in case", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user/Guide"), { recursive: true });
    writeFileSync(join(root, "docs/user/A.md"), PAGE);
    writeFileSync(join(root, "docs/user/a.md"), PAGE);
    writeFileSync(join(root, "docs/user/Guide/index.md"), PAGE);
    writeFileSync(join(root, "docs/user/guide.mdx"), PAGE);
    const messages = checkDocs(root).violations.map((violation) => `${violation.file}: ${violation.message}`);
    expect(messages).toEqual([
      expect.stringContaining("docs/user/A.md: produces the route /docs/A, which docs/user/a.md also produces"),
      expect.stringContaining("docs/user/Guide/index.md: produces the route /docs/Guide, which docs/user/guide.mdx also produces"),
      expect.stringContaining("docs/user/a.md: produces the route /docs/a, which docs/user/A.md also produces"),
      expect.stringContaining("docs/user/guide.mdx: produces the route /docs/guide, which docs/user/Guide/index.md also produces"),
    ]);
  });

  it("on a page named INDEX that shares its route with another page", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user/a"), { recursive: true });
    writeFileSync(join(root, "docs/user/a.md"), PAGE);
    writeFileSync(join(root, "docs/user/a/INDEX.md"), PAGE);
    const messages = checkDocs(root).violations.map((violation) => `${violation.file}: ${violation.message}`);
    expect(messages).toEqual([
      expect.stringContaining("docs/user/a.md: produces the route /docs/a, which docs/user/a/INDEX.md also produces"),
      expect.stringContaining("docs/user/a/INDEX.md: produces the route /docs/a, which docs/user/a.md also produces"),
    ]);
  });

  it("on a bare email address, with a message that does not ask for https://", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user"), { recursive: true });
    writeFileSync(join(root, "docs/user/page.md"), `${PAGE}\nWrite to someone@example.com for help.\n`);
    const messages = checkDocs(root).violations.map((violation) => violation.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("mailto: scheme");
    expect(messages[0]).toContain("email address");
    expect(messages[0]).not.toContain("write it as https://");
  });

  it("on a reserved first segment in any case", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user"), { recursive: true });
    for (const name of ["CLOUD.md", "Self-Hosting.md", "Releases.md"]) writeFileSync(join(root, "docs/user", name), PAGE);
    expect(checkDocs(root).violations.map((violation) => violation.file)).toEqual([
      "docs/user/CLOUD.md",
      "docs/user/Releases.md",
      "docs/user/Self-Hosting.md",
    ]);
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

describe("the component allow-list", () => {
  it("is exactly the components the site mirrors", () => {
    expect([...ALLOWED_COMPONENTS]).toEqual(["Callout", "Tabs", "Tab", "Steps", "Step", "EditionBadge", "Screenshot"]);
  });

  it.each(ALLOWED_COMPONENTS)("accepts <%s> with literal attributes", (name) => {
    expect(lintBody(`<${name} a="x" b={2} c={true} d={-1.5} e />\n`, ".mdx")).toEqual([]);
  });

  it.each(["Callout2", "callout", "Chart", "div", "Tabs.Tab"])("refuses <%s>", (name) => {
    expect(lintBody(`<${name} />\n`, ".mdx")).toHaveLength(1);
  });

  it("refuses an expression that only looks like a literal", () => {
    expect(lintBody("<Tab a={1 + 1} />\n", ".mdx")).toHaveLength(1);
    expect(lintBody("<Tab a={null} />\n", ".mdx")).toHaveLength(1);
    expect(lintBody("<Tab a={'x'} />\n", ".mdx")).toHaveLength(1);
  });

  it("reports the line within the whole file, frontmatter included", () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user"), { recursive: true });
    writeFileSync(join(root, "docs/user/page.mdx"), `${PAGE}\n<Chart />\n`);
    expect(checkDocs(root).violations).toEqual([expect.objectContaining({ file: "docs/user/page.mdx", line: 9 })]);
  });

  it("finds nothing in a page that uses every allowed component and in code fences", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    expect(checkDocs(join(FIXTURES, "valid")).violations).toEqual([]);
  });
});

describe("a renamed page", () => {
  it("fails the command and names every link that still points to the old name", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const root = tempTree();
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });
    renameSync(join(root, "docs/user/getting-started.md"), join(root, "docs/user/started.md"));

    const result = runCli(root);
    expect(result.status).toBe(1);
    const reported = result.stderr.split("\n").filter((line) => line.includes("getting-started"));
    expect(reported).toEqual([
      expect.stringContaining('docs/user/components/code-fences.md:23: "../getting-started.md" does not resolve'),
      expect.stringContaining('docs/user/components/every-component-2.mdx:7: "../getting-started.md" does not resolve'),
      expect.stringContaining('docs/user/links.md:9: "getting-started.md" does not resolve'),
      expect.stringContaining('docs/user/links.md:11: "/docs/getting-started" matches no page'),
    ]);
    expect(result.stderr).toContain("docs:check failed: 4 problems");
  });
});

describe("an image over 1 MiB", () => {
  const png = Buffer.from("iVBORw0KGgo=", "base64");

  it("fails, and one of exactly 1 MiB passes", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const root = tempTree();
    mkdirSync(join(root, "docs/user"), { recursive: true });
    writeFileSync(join(root, "docs/user/page.md"), `${PAGE}\n![Fits](fits.png)\n`);
    writeFileSync(join(root, "docs/user/fits.png"), Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)]));
    expect(runCli(root).status).toBe(0);

    writeFileSync(join(root, "docs/user/big.png"), Buffer.concat([png, Buffer.alloc(1024 * 1024 + 1 - png.length)]));
    const result = runCli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/user/big.png: the image is 1048577 bytes");
    expect(result.stderr).not.toContain("fits.png");
  });
});

function contextFor(page: string, extra: Partial<LinkContext> = {}): LinkContext {
  return {
    page,
    files: new Set(["docs/user/index.md", "docs/user/a/b.md", "docs/user/a/pic.png", "docs/user/pic.png", "docs/self-hosting/install.md"]),
    images: new Set(["docs/user/a/pic.png", "docs/user/pic.png"]),
    routes: new Set(["/docs", "/docs/a/b", "/docs/self-hosting/install"]),
    headings: new Set(["intro", "intro-1"]),
    ...extra,
  };
}

describe("link targets", () => {
  const context = contextFor("docs/user/a/b.md");

  it.each([
    "https://example.com",
    "HTTPS://example.com/a?b=1#c",
    "../index.md",
    "./b.md",
    "../../self-hosting/install.md",
    "/docs",
    "/docs/",
    "/docs/a/b",
    "/docs/a/b/?x=1#y",
    "/docs/self-hosting/install",
    "/docs/cloud",
    "/docs/cloud/anything/else",
    "/docs/cloud/a..b/c...",
    "/docs/cloud/100%25",
    "/docs/cloud/a%20b",
    "/docs/cloud/%25/a",
    "#intro",
    "#intro-1",
    "%2E%2E/index.md",
  ])("accepts %s", (url) => {
    expect(checkLink(url, context)).toBeNull();
  });

  it.each([
    "",
    "http://example.com",
    "HTTP://example.com",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "data:text/html;base64,AAAA",
    "mailto:a@example.com",
    "tel:+4930123",
    "ftp://example.com/a",
    "file:///etc/passwd",
    "https:example.com",
    "https://",
    "//example.com/a",
    "/pricing",
    "/",
    "/docsx",
    "/docs/missing",
    "/docs/../etc/passwd",
    "/docs/cloudy",
    "/docs/cloud/../../pricing",
    "/docs/cloud/..",
    "/docs/cloud/%2E%2E/%2e%2e/pricing",
    "/docs/cloud/..%2F..%2Fpricing",
    "/docs/cloud/%2E%2E%5C%2E%2E%5Cpricing",
    "/docs/cloud/%252e%252e/pricing",
    "/docs/cloud/%25252e%25252e/pricing",
    "/docs/cloud/%25/%252e%252e/pricing",
    "/docs/cloud/%25zz/%252e%252e/pricing",
    "/docs/cloud/%2525zz/%25252e%25252e/pricing",
    "/docs/cloud/..%252f../pricing",
    "/docs/cloud/%252e%252e%255cpricing",
    "/docs/cloud/%2525252525252e/pricing",
    "/docs/cloud/%25zz%252f..%252fx",
    "/docs/cloud/%2525zz%25252f..%25252fx",
    "/docs/cloud/%zz%2f..%2fx",
    "/docs/cloud/%25zz%2f..%2fx",
    "/docs/cloud/%2E%2e/x",
    "/docs/cloud/%2e./x",
    "/docs/cloud/.%2e/x",
    "/docs/cloud/..%5cx",
    "/docs/cloud/..%255cx",
    "/docs/cloud/%zz",
    "/docs/cloud/a/../../../x?y=1",
    "/docs/a/b/../../../pricing",
    "missing.md",
    "../missing.md",
    "../../../outside.md",
    "..\\index.md",
    "%2E%2E%2F%2E%2E%2F%2E%2E%2Foutside.md",
    "%zz",
    "#absent",
    "#",
    "#INTRO",
    "?query-only",
  ])("refuses %j", (url) => {
    expect(checkLink(url, context)).not.toBeNull();
  });
});

describe("what a GFM renderer links", () => {
  const refsOf = (body: string): { url: string; bare: boolean }[] => {
    const parsed = parseBody(body, ".md");
    if (!parsed.ok) throw new Error(parsed.finding.message);
    return collectRefs(parsed.tree).refs.map((ref) => ({ url: ref.url, bare: ref.bare === true }));
  };

  it.each([
    ["See http://example.com now.", "http://example.com"],
    ["See HTTP://EXAMPLE.COM/a?b=1 now.", "HTTP://EXAMPLE.COM/a?b=1"],
    ["See www.example.com now.", "http://www.example.com"],
    ["Mail a@example.com now.", "mailto:a@example.com"],
    ["- a list http://example.com/x item\n", "http://example.com/x"],
    ["| a |\n| - |\n| http://example.com |\n", "http://example.com"],
    ["> **http://example.com**\n", "http://example.com"],
  ])("finds a bare address in %j", (body, url) => {
    expect(refsOf(body)).toEqual([{ url, bare: true }]);
  });

  it("finds a bare https address and leaves it to the link rules", () => {
    expect(refsOf("See https://example.com/a.")).toEqual([{ url: "https://example.com/a", bare: true }]);
  });

  it.each([
    "Inline `http://example.com` code.",
    "```\nhttp://example.com\n```\n",
    "~~~sh\ncurl http://example.com\n~~~\n",
    "    http://example.com\n",
  ])("does not read code in %j as a link", (body) => {
    expect(refsOf(body)).toEqual([]);
  });

  it("does not call an explicit link bare", () => {
    expect(refsOf("[a site](https://example.com) and <https://example.com/b>")).toEqual([
      { url: "https://example.com", bare: false },
      { url: "https://example.com/b", bare: false },
    ]);
  });
});

describe("a Markdown file", () => {
  it("is never compiled as MDX: import, export and braces have no meaning in it", () => {
    const findings = lintBody("import x from 'y'\n\nexport const a = 1\n\nText {1 + 1} and <Callout />.\n", ".md");
    expect(findings.map((finding) => finding.message)).toEqual(["raw HTML is not allowed; use Markdown syntax for links and images"]);
    expect(lintBody("import x from 'y'\n\nexport const a = 1\n\nText {1 + 1}.\n", ".md")).toEqual([]);
  });

  it("is not the MDX of the same text", () => {
    expect(lintBody("import x from 'y'\n", ".mdx")).toHaveLength(1);
  });
});

describe("image sources", () => {
  const context = contextFor("docs/user/a/b.md");

  it.each(["pic.png", "./pic.png"])("accepts %s", (url) => {
    expect(checkImage(url, context)).toBeNull();
  });

  it.each([
    "",
    "missing.png",
    "../pic.png",
    "sub/../pic.png",
    "/pic.png",
    "//example.com/pic.png",
    "https://example.com/pic.png",
    "data:image/png;base64,AAAA",
    "pic.svg",
    "pic.bmp",
    "pic",
    "pic.png?x=1",
    "pic.png#frag",
    "%2E%2E/pic.png",
    "pic.png ",
  ])("refuses %j", (url) => {
    expect(checkImage(url, context)).not.toBeNull();
  });

  it.each(["png", "jpg", "jpeg", "webp", "gif", "avif"])("matches the case of the file name for .%s", (extension) => {
    const target = `docs/user/a/shot.${extension}`;
    const withShot = contextFor("docs/user/a/b.md", { images: new Set([target]) });
    expect(checkImage(`shot.${extension.toUpperCase()}`, withShot)).not.toBeNull();
    expect(checkImage(`shot.${extension}`, withShot)).toBeNull();
  });
});

// The customer-docs skill writes its pages from these templates. Filling every
// placeholder must give a page the contract accepts; the skill's own checks are
// the only guard on what it writes into docs/user.
describe("a page written from a customer-docs template", () => {
  const SKILL = resolve(import.meta.dirname, "../../.claude/skills/customer-docs");
  const TEMPLATES = [
    ["page-doc-template.md", "page.mdx"],
    ["getting-started-template.md", "getting-started.mdx"],
    ["landing-page-template.md", "index.md"],
    ["concept-template.md", "concepts/concept.md"],
    ["faq-template.md", "faq.md"],
  ] as const;

  /** The page a template holds: the whole file, or the markdown fence of one that wraps its page in rules. */
  function pageOf(template: string): string {
    const text = readFileSync(join(SKILL, template), "utf8");
    return /^```markdown\n([\s\S]*?)\n```$/m.exec(text)?.[1] ?? text;
  }

  /** Replaces each `{PLACEHOLDER}` with text, or with a target that resolves when it is a link. */
  function fill(page: string): string {
    return page
      .replace(/\(\{[^{}]*URL\}\)/g, "(https://example.com/source)")
      .replace(/\(\{[^{}]*path\}\)/g, "(more.md)")
      .replace(/\{[^{}]+\}/g, "Filled");
  }

  function treeWith(template: string, target: string): string {
    const root = tempTree();
    mkdirSync(join(root, "docs/user/concepts"), { recursive: true });
    writeFileSync(join(root, "docs/user/more.md"), PAGE);
    writeFileSync(join(root, "docs/user/concepts/more.md"), PAGE);
    writeFileSync(join(root, "docs/user", target), fill(pageOf(template)));
    return root;
  }

  it.each(TEMPLATES)("passes docs:check: %s", (template, target) => {
    expect(checkDocs(treeWith(template, target)).violations).toEqual([]);
  });

  it.each(TEMPLATES)("starts with the frontmatter fields of the contract: %s", (template) => {
    const [, block = ""] = /^---\n([\s\S]*?)\n---\n/.exec(pageOf(template)) ?? [];
    const keys = block.split("\n").map((line) => /^([a-z]+):/.exec(line)?.[1]);
    expect(keys).toEqual(expect.arrayContaining(["title", "description", "edition"]));
    expect(keys.filter((key) => key !== undefined)).toEqual(expect.not.arrayContaining(["sidebar_position", "slug"]));
  });

  it("uses every allowed component somewhere, so that a rename of one fails here", () => {
    const used = TEMPLATES.map(([template]) => pageOf(template)).join("\n");
    for (const name of ["Screenshot", "Callout", "EditionBadge", "Steps", "Step"]) expect(used).toContain(`<${name}`);
  });

  it("is laid out in the config template with the extension its components need", () => {
    const layout = readFileSync(join(SKILL, "docs-config-template.md"), "utf8");
    const ROWS = [
      ["landing-page-template.md", "Landing page"],
      ["getting-started-template.md", "Getting started"],
      ["page-doc-template.md", "Page docs"],
      ["concept-template.md", "Concept pages"],
      ["faq-template.md", "FAQ"],
    ] as const;
    for (const [template, label] of ROWS) {
      const row = layout.split("\n").find((line) => line.startsWith(`| ${label}`));
      const extension = /`docs\/user\/[^`]*\.(mdx?)`/.exec(row ?? "")?.[1];
      const usesComponent = /<[A-Z]/.test(pageOf(template));
      expect(extension, template).toBe(usesComponent ? "mdx" : "md");
    }
  });

  it("never writes the HTML comment placeholder", () => {
    for (const [template] of TEMPLATES) expect(pageOf(template)).not.toContain("<!--");
  });

  it("is refused when it carries the old screenshot comment", () => {
    const root = treeWith("page-doc-template.md", "page.mdx");
    writeFileSync(join(root, "docs/user/page.mdx"), `${fill(pageOf("page-doc-template.md"))}\n<!-- SCREENSHOT: x -->\n`);
    expect(checkDocs(root).violations.length).toBeGreaterThan(0);
  });
});

describe("heading fragments", () => {
  it.each([
    ["Links and anchors", "links-and-anchors"],
    ["The `code` heading", "the-code-heading"],
    ["What's new? (v2)", "whats-new-v2"],
    ["snake_case and-dash", "snake_case-and-dash"],
    ["Über uns", "über-uns"],
  ])("turns %j into %s", (text, slug) => {
    expect(slugify(text)).toBe(slug);
  });
});
