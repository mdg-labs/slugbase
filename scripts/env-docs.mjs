// Generates docs/self-hosting/environment.md from the environment schemas and checks that nothing
// drifted (doc 09 section 3.5, D24):
//
//   node scripts/env-docs.mjs            writes the page
//   node scripts/env-docs.mjs --check    fails when the page, .env.example and the schemas disagree
//
// The page is scripts/env-docs/environment.template.md (the prose, written by hand) with a table in
// place of each `{{keys:<group>}}` line and of `{{oidc}}`. A table row holds what the schemas say
// (the processes that read the key, whether it is required, its default) and what
// packages/server/src/config/key-docs.ts says (its type and a one-line description). The check fails when
//
// - a key a process schema declares has no entry in key-docs.ts, or an entry names no declared key;
// - the keys of .env.example and the declared keys are not the same set;
// - the page on disk is not what this script writes now;
// - a page names an environment key no schema declares;
// - a secret key is given a default or a value (`KEY=value`, or in a table row a cell that is one code span
//   right after the key's cell; a `<your ...>` placeholder and another key's name are not values), or the page
//   holds a run of characters shaped like a credential.
//
// Exit status: 0 when everything agrees (or the page was written), 1 when it does not, 2 when the
// script could not run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = join("docs", "self-hosting", "environment.md");
const EXAMPLE = ".env.example";
const TEMPLATE = join("scripts", "env-docs", "environment.template.md");
const REGENERATE = "run `pnpm env:docs` and commit the result";

// A name of upper-case letters and digits in groups joined by single underscores. A name followed by an
// underscore, an angle bracket or an asterisk is a pattern (`RATE_LIMIT_<BUCKET>_*`), not a key.
const KEY_PATTERN = /(?<![A-Za-z0-9_<])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_<>*])/g;
// Provider slugs the prose gives as examples; they have the shape of a key but are values of `<SLUG>`.
const SLUG_EXAMPLES = new Set(["COMPANY_SSO"]);
const SECRET_KEY = /^(?:[A-Z][A-Z0-9]*_)*(?:KEY|SECRET|PASS|PASSWORD|TOKEN|DSN)$/;
const SECRET_ASSIGNMENT = /(?<![A-Za-z0-9_])(?:[A-Z][A-Z0-9]*_)*(?:KEY|SECRET|PASS|PASSWORD|TOKEN|DSN)\s*=\s*[^\s<`]/;
// Something that looks like a credential: a long run of base64, hex or token characters.
const TOKEN_SHAPED = /[A-Za-z0-9+/=_-]{32,}/;
// A placeholder such as `<your secret>`, and another key's name, are not values.
const PLACEHOLDER = /^<[^<>]+>$/;
const KEY_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const PERIODS = new Map([
  [1, "sec"],
  [60, "min"],
  [3600, "hour"],
]);

// The text with the names of declared keys taken out, since a name of 32 characters or more is a run of token
// characters. What is left stays joined where a name was, so a credential written on both sides of a name is
// still one run. A key-shaped name no schema declares stays, and is tested like any other run.
function withoutDeclaredKeys(text, declared) {
  return text.replace(KEY_PATTERN, (name) => (declared.has(name) ? "" : name));
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

/** The secret keys a table row of `page` gives a value in the cell after its own. */
function secretsWithValues(page) {
  const found = [];
  walk(unified().use(remarkParse).use(remarkGfm).parse(withoutFrontmatter(page)), (node) => {
    if (node.type !== "tableRow") {
      return;
    }
    const cells = (node.children ?? []).map(soleCode);
    cells.forEach((code, index) => {
      const next = cells[index + 1];
      if (code !== undefined && SECRET_KEY.test(code) && next !== undefined && !PLACEHOLDER.test(next.trim()) && !KEY_NAME.test(next)) {
        found.push(code);
      }
    });
  });
  return found;
}

function escapeCell(text) {
  return text.replaceAll("|", String.raw`\|`);
}

function typeText(type) {
  switch (type.kind) {
    case "boolean":
      return "boolean";
    case "integer":
      return `whole number, ${String(type.min)} to ${String(type.max)}`;
    case "enum":
      return `one of ${type.options.map((option) => `\`${option}\``).join(", ")}`;
    case "rate":
      return "count and period, such as `5/hour`";
    default:
      return type.label;
  }
}

function defaultOf(value) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return undefined;
  }
  if (typeof value === "object" && value !== null && "count" in value && "windowSeconds" in value) {
    return `${String(value.count)}/${PERIODS.get(value.windowSeconds) ?? `${String(value.windowSeconds)}s`}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`a default of an unexpected kind: ${JSON.stringify(value)}`);
}

/** The processes that read `key`, and what the schemas say about it. */
function facts(config, key) {
  const readers = config.PROCESS_TYPES.filter((type) => config.envSchemas[type].keys.includes(key));
  let required = false;
  let fallback;
  for (const type of readers) {
    const parsed = config.envSchemas[type].object.shape[key].safeParse(undefined);
    if (!parsed.success) {
      required = true;
    } else if (fallback === undefined) {
      fallback = defaultOf(parsed.data);
    }
  }
  return { readers, required, fallback };
}

function schemaKeys(config) {
  return [...new Set(config.PROCESS_TYPES.flatMap((type) => config.envSchemas[type].keys))].sort();
}

function row(cells) {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function table(header, rows) {
  return [row(header), row(header.map((cell) => "-".repeat(Math.max(3, cell.length)))), ...rows.map(row)].join("\n");
}

const HEADER = ["Key", "Read by", "Required", "Default", "Type", "What it sets"];

/** The table of the keys of one group, in the order key-docs.ts lists them. */
export function keysTable(config, group) {
  const rows = Object.entries(config.KEY_DOCS)
    .filter(([, doc]) => doc.group === group)
    .map(([key, doc]) => {
      const { readers, required, fallback } = facts(config, key);
      return [
        `\`${key}\``,
        readers.join(", "),
        doc.requiredWhen ?? (required ? "Yes" : "No"),
        doc.defaultText ?? (fallback === undefined ? "None" : `\`${fallback}\``),
        typeText(doc.type),
        doc.description,
      ];
    });
  return table(HEADER, rows);
}

/** The table of the `OIDC_<SLUG>_*` keys. */
export function oidcTable(config) {
  const rows = config.oidcKeyDocs().map((doc) => [
    `\`OIDC_<SLUG>_${doc.field}\``,
    "server",
    doc.required ? "Yes, for an enabled provider" : "No",
    doc.defaultText ?? "None",
    typeText(doc.type),
    doc.description,
  ]);
  return table(HEADER, rows);
}

/** The page: the template with a table in place of each placeholder. */
export function renderPage(config, template) {
  return template
    .replace(/^\{\{keys:([a-z-]+)\}\}$/gm, (_, group) => keysTable(config, group))
    .replace(/^\{\{oidc\}\}$/gm, () => oidcTable(config));
}

/** What is wrong with the schemas, key-docs.ts, .env.example and the page, as sentences. */
export function checkEnvironment(config, { template, pageText, exampleText }) {
  const problems = [];
  const declared = new Set(schemaKeys(config));
  const documented = new Set(Object.keys(config.KEY_DOCS));
  const exampleKeys = new Set([...exampleText.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

  for (const key of [...declared].sort()) {
    if (!documented.has(key)) {
      problems.push(`${key} is declared by a process schema but has no entry in packages/server/src/config/key-docs.ts`);
    }
    if (!exampleKeys.has(key)) {
      problems.push(`${key} is declared by a process schema but is not a line of ${EXAMPLE}`);
    }
  }
  for (const key of [...documented].sort()) {
    if (!declared.has(key)) {
      problems.push(`${key} has an entry in packages/server/src/config/key-docs.ts but no process schema declares it`);
    }
  }
  for (const key of [...exampleKeys].sort()) {
    if (!declared.has(key)) {
      problems.push(`${key} is a line of ${EXAMPLE} but no process schema declares it`);
    }
  }

  const placeholders = new Set([...template.matchAll(/^\{\{keys:([a-z-]+)\}\}$/gm)].map((match) => match[1]));
  for (const group of config.KEY_GROUPS) {
    if (!placeholders.has(group)) {
      problems.push(`the template has no {{keys:${group}}} line, so the keys of that group are not on the page`);
    }
  }
  for (const group of placeholders) {
    if (!config.KEY_GROUPS.includes(group)) {
      problems.push(`the template has {{keys:${group}}} but no key belongs to a group of that name`);
    }
  }
  if (!/^\{\{oidc\}\}$/m.test(template)) {
    problems.push("the template has no {{oidc}} line, so the OIDC keys are not on the page");
  }

  let page;
  try {
    page = renderPage(config, template);
  } catch (error) {
    problems.push(`the page could not be generated: ${error instanceof Error ? error.message : String(error)}`);
    return problems;
  }

  if (pageText !== page) {
    problems.push(`${PAGE} is not what the generator writes from the schemas; ${REGENERATE}`);
  }
  for (const key of new Set(page.match(KEY_PATTERN) ?? [])) {
    if (!declared.has(key) && !SLUG_EXAMPLES.has(key)) {
      problems.push(`${key} is on the page but no process schema declares it`);
    }
  }

  // The page never gives a secret a value.
  for (const key of [...declared].filter((name) => SECRET_KEY.test(name))) {
    const { fallback } = facts(config, key);
    if (fallback !== undefined || config.KEY_DOCS[key]?.defaultText !== undefined) {
      problems.push(`${key} is a secret and must have no default on the page`);
    }
  }
  for (const [key, doc] of Object.entries(config.KEY_DOCS)) {
    const text = `${doc.description} ${doc.defaultText ?? ""}`;
    if (SECRET_ASSIGNMENT.test(text) || TOKEN_SHAPED.test(withoutDeclaredKeys(text, declared))) {
      problems.push(`the description of ${key} holds a value that looks like a secret; use a placeholder such as <your secret>`);
    }
  }
  if (SECRET_ASSIGNMENT.test(page)) {
    problems.push(`the page gives a secret key a value: ${page.match(SECRET_ASSIGNMENT)[0].split("=")[0].trim()}`);
  }
  for (const key of secretsWithValues(page)) {
    problems.push(`the page gives a secret key a value: ${key}`);
  }
  if (TOKEN_SHAPED.test(withoutDeclaredKeys(page, declared))) {
    problems.push(`the page holds a run of characters shaped like a credential; use a placeholder such as <your secret>`);
  }
  return problems;
}

export async function loadSchemaConfig(root) {
  const base = pathToFileURL(join(root, "packages", "server", "src", "config")).href;
  const index = await import(`${base}/index.ts`);
  const docs = await import(`${base}/key-docs.ts`);
  return {
    PROCESS_TYPES: index.PROCESS_TYPES,
    envSchemas: index.envSchemas,
    KEY_DOCS: docs.KEY_DOCS,
    KEY_GROUPS: docs.KEY_GROUPS,
    oidcKeyDocs: docs.oidcKeyDocs,
  };
}

function fail(message) {
  process.stderr.write(`env-docs: ${message}\n`);
  process.exitCode = 2;
}

/** Runs the script on `argv`; `load` reads the schema configuration, so that a test can hand it another one. */
export async function main(argv, load = () => loadSchemaConfig(ROOT)) {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    fail(`unknown argument ${unknown.join(" ")}; usage: env-docs.mjs [--check]`);
    return;
  }
  let config;
  let template;
  let exampleText;
  try {
    config = await load();
    template = readFileSync(join(ROOT, TEMPLATE), "utf8");
    exampleText = readFileSync(join(ROOT, EXAMPLE), "utf8");
  } catch (error) {
    fail(`could not read the schemas, ${TEMPLATE} or ${EXAMPLE}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!check) {
    let page;
    try {
      page = renderPage(config, template);
    } catch (error) {
      fail(`could not generate the page: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const keyProblems = checkEnvironment(config, { template, pageText: page, exampleText });
    if (keyProblems.length > 0) {
      process.stderr.write(`${keyProblems.map((problem) => `env-docs: ${problem}`).join("\n")}\n`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(join(ROOT, PAGE)), { recursive: true });
    writeFileSync(join(ROOT, PAGE), page);
    process.stdout.write(`env-docs: wrote ${PAGE}\n`);
    return;
  }

  let pageText = "";
  try {
    pageText = readFileSync(join(ROOT, PAGE), "utf8");
  } catch {
    // A missing page is reported by the comparison below.
  }
  const problems = checkEnvironment(config, { template, pageText, exampleText });
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `env-docs: ${problem}`).join("\n")}\n`);
    process.stderr.write(`env-docs failed: ${String(problems.length)} problem${problems.length === 1 ? "" : "s"}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`env-docs passed: ${PAGE} and ${EXAMPLE} agree with the environment schemas\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
