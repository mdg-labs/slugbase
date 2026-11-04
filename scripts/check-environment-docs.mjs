// Checks that docs/self-hosting/environment.md and the environment schema agree
// (doc 09 section 3.5, D24):
//
//   node scripts/check-environment-docs.mjs [repository root]
//
// - every environment key the page names, in text, in a code span or in a code
//   block, is declared by the schema of a process and is a line of .env.example;
// - every key of the settings the page covers (the AI keys, the audit
//   retention and the rate limits of the go, fetch, ai and bulk buckets) is
//   named on the page, in a table row whose next code span after the key is its
//   default, which equals the default of the schema;
// - no key whose name ends in KEY, SECRET, PASS, PASSWORD, TOKEN or DSN is given a
//   value on the page, as `KEY=value` or, in a table row, as a cell that is one
//   code span right after the key's cell (a placeholder in angle brackets and
//   another key's name are not values).
//
// The schema is read from packages/server/src/config, so a key added or removed
// there changes this check's verdict without an edit here. The optional argument
// names another repository root for the page and .env.example, which the test
// uses for its fixtures. Exit status: 0 when they agree, 1 when they do not, 2 when
// the check could not run.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const PAGE = join("docs", "self-hosting", "environment.md");
const EXAMPLE = ".env.example";
const RATE_LIMIT_BUCKETS_ON_THE_PAGE = ["go", "fetch", "ai", "bulk"];

// A name of upper-case letters and digits in groups joined by single underscores.
// A name followed by an underscore, an angle bracket or an asterisk is a pattern
// (`RATE_LIMIT_<BUCKET>_*`), not a key.
const KEY_PATTERN = /(?<![A-Za-z0-9_<])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_<>*])/g;
const SECRET_ASSIGNMENT = /(?<![A-Za-z0-9_])(?:[A-Z][A-Z0-9]*_)*(?:KEY|SECRET|PASS|PASSWORD|TOKEN|DSN)\s*=\s*[^\s<`]/;
// A secret key's name alone, and a placeholder such as `<your API token>`.
const SECRET_KEY = /^(?:[A-Z][A-Z0-9]*_)*(?:KEY|SECRET|PASS|PASSWORD|TOKEN|DSN)$/;
const PLACEHOLDER = /^<[^<>]+>$/;
const KEY_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function fail(message) {
  process.stderr.write(`environment-docs: ${message}\n`);
  process.exitCode = 2;
}

function withoutFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

// The value of a table cell that holds one code span and nothing else but white space, or undefined.
function soleCode(cell) {
  const parts = (cell.children ?? []).filter((child) => !(child.type === "text" && child.value.trim() === ""));
  return parts.length === 1 && parts[0].type === "inlineCode" ? parts[0].value : undefined;
}

function keysIn(text) {
  return text.match(KEY_PATTERN) ?? [];
}

const root = process.argv[2] === undefined ? resolve(import.meta.dirname, "..") : resolve(process.argv[2]);

let pageText;
let exampleText;
try {
  pageText = readFileSync(join(root, PAGE), "utf8");
  exampleText = readFileSync(join(root, EXAMPLE), "utf8");
} catch (error) {
  fail(`could not read ${PAGE} or ${EXAMPLE} under ${root}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit();
}

const config = await import(pathToFileURL(resolve(import.meta.dirname, "../packages/server/src/config/index.ts")).href);
const declared = new Set(config.declaredKeys());
const exampleKeys = new Set([...exampleText.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

// The keys the page covers, with the default each has in the schema.
const covered = new Map();
for (const key of config.AI_KEYS) {
  covered.set(key, undefined);
}
for (const [key, field] of Object.entries(config.retentionFragment.shape)) {
  const parsed = field.safeParse(undefined);
  covered.set(key, parsed.success ? String(parsed.data) : undefined);
}
for (const bucket of RATE_LIMIT_BUCKETS_ON_THE_PAGE) {
  const scopes = config.RATE_LIMIT_DEFAULTS[bucket];
  if (scopes === undefined) {
    fail(`the rate-limit registry has no bucket ${bucket}`);
    process.exit();
  }
  for (const [scope, fallback] of Object.entries(scopes)) {
    covered.set(config.rateLimitKey(bucket, scope), fallback);
  }
}

const tree = unified().use(remarkParse).use(remarkGfm).parse(withoutFrontmatter(pageText));

const documented = new Set();
const rows = [];
const problems = [];
walk(tree, (node) => {
  if ((node.type === "text" || node.type === "inlineCode" || node.type === "code") && typeof node.value === "string") {
    for (const key of keysIn(node.value)) {
      documented.add(key);
    }
    if (SECRET_ASSIGNMENT.test(node.value)) {
      problems.push(`the page gives a secret key a value: ${node.value.match(SECRET_ASSIGNMENT)[0].split("=")[0].trim()}`);
    }
  }
  if (node.type === "tableRow") {
    const codes = [];
    walk(node, (child) => {
      if (child.type === "inlineCode") {
        codes.push(child.value);
      }
    });
    rows.push(codes);
    // A table gives a key a value in the cell after its own, written as one code span, as it gives a default; a secret key gets none.
    const cells = (node.children ?? []).map(soleCode);
    cells.forEach((code, index) => {
      const next = cells[index + 1];
      if (code !== undefined && SECRET_KEY.test(code) && next !== undefined && !PLACEHOLDER.test(next.trim()) && !KEY_NAME.test(next)) {
        problems.push(`the page gives a secret key a value: ${code}`);
      }
    });
  }
});

for (const key of [...documented].sort()) {
  if (!declared.has(key)) {
    problems.push(`${key} is on the page but no process schema declares it`);
  } else if (!exampleKeys.has(key)) {
    problems.push(`${key} is on the page but is not a line of ${EXAMPLE}`);
  }
}

for (const [key, fallback] of [...covered].sort(([a], [b]) => (a < b ? -1 : 1))) {
  if (!documented.has(key)) {
    problems.push(`${key} is a setting the page covers but the page does not name it`);
    continue;
  }
  if (fallback === undefined) {
    continue;
  }
  const row = rows.find((codes) => codes.includes(key));
  if (row === undefined) {
    problems.push(`${key} has no table row that gives its default`);
    continue;
  }
  const written = row[row.indexOf(key) + 1];
  if (written !== fallback) {
    problems.push(`${key} has the default ${written ?? "none"} on the page, and ${fallback} in the schema`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `environment-docs: ${problem}`).join("\n")}\n`);
  process.stderr.write(`environment-docs failed: ${String(problems.length)} problem${problems.length === 1 ? "" : "s"}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`environment-docs passed: ${String(documented.size)} keys on the page agree with the schema\n`);
}
